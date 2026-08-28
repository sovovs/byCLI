/**
 * Command execution: validates args, manages browser sessions, runs commands.
 *
 * This is the single entry point for executing any CLI command. It handles:
 * 1. Argument validation and coercion
 * 2. Browser session lifecycle (if needed)
 * 3. Domain pre-navigation for cookie strategies
 * 4. Timeout enforcement
 * 5. Lazy-loading of TS modules from manifest
 * 6. Lifecycle hooks (onBeforeExecute / onAfterExecute)
 */

import {
  type BrowserCliCommand,
  type CliCommand,
  type InternalCliCommand,
  type SiteSessionMode,
  type Arg,
  type CommandArgs,
  getRegistry,
  fullName,
} from './registry.js';
import type { IPage } from './types.js';
import { pathToFileURL } from 'node:url';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getUserClisDir } from './config-paths.js';
import { executePipeline } from './pipeline/index.js';
import { AdapterCoordinationError, adapterLoadError, ArgumentError, CliError, CommandExecutionError, TimeoutError, attachTraceReceipt, getErrorMessage } from './errors.js';
import { shouldUseBrowserSession } from './capabilityRouting.js';
import { getBrowserFactory, browserSession, runWithTimeout, DEFAULT_BROWSER_COMMAND_TIMEOUT, type BrowserWindowMode } from './runtime.js';
import { resolveProfileContextId } from './browser/profile.js';
import { resolveAdapterLeaseContextId } from './browser/daemon-client.js';
import { emitHook, type HookContext } from './hooks.js';
import { log } from './logger.js';
import { isElectronApp } from './electron-apps.js';
import { probeCDP, resolveElectronEndpoint } from './launcher.js';
import { ObservationSession, exportObservationSession, type ObservationExportResult, type ObservationExportStatus } from './observation/index.js';
import { resolveAdapterSourcePath } from './adapter-source.js';
import { canonicalizeManifestArgSchema, ManifestSchemaError } from './manifest-schema.js';
import { settleAdapterOperationAfterTimeout, withAdapterCommandLease } from './adapter-coordination.js';
import {
  capturedRegistryValues,
  closeRegistryTransaction,
  createRegistryTransaction,
  finalizeRegistryTransaction,
  resetRegistryTransactionStateForTests,
  rollbackRegistryTransaction,
  runRegistryTransaction,
  transactionGroupsForKey,
  type RegistryTransaction,
} from './registry-transaction.js';

interface ModuleLoadEntry {
  promise: Promise<void>;
  fingerprint: string | undefined;
  generation: number;
  /** Commands registered by this exact import generation. */
  registeredCommands: Map<string, CliCommand>;
  transaction: RegistryTransaction;
  hotReloadable: boolean;
}

const _loadedModules = new Map<string, ModuleLoadEntry>();
/** Independent cache-busting generation; retained when an import promise is discarded. */
const _moduleImportGenerations = new Map<string, number>();
let _registrationImportTail: Promise<void> = Promise.resolve();
let _registrationImportsPoisoned = false;
let _fingerprintReadCount = 0;

const DEFAULT_ADAPTER_IMPORT_TIMEOUT_MS = 30_000;

function adapterImportTimeoutMs(): number {
  const configured = Number(process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ADAPTER_IMPORT_TIMEOUT_MS;
}

function poisonedImportError(): CliError {
  return adapterLoadError(
    'Adapter registration imports are unavailable because a previous import timed out.',
    'Restart byCLI before retrying; the timed-out module may still complete and register stale commands in this process.',
  );
}

/** Internal test-only reset. Never use this to recover a production process. */
export function _resetLazyModuleStateForTests(): void {
  _loadedModules.clear();
  _moduleImportGenerations.clear();
  _registrationImportTail = Promise.resolve();
  _registrationImportsPoisoned = false;
  _fingerprintReadCount = 0;
  resetRegistryTransactionStateForTests();
}

export function _getLazyModuleFingerprintReadCountForTests(): number {
  return _fingerprintReadCount;
}

type TraceMode = 'off' | 'on' | 'retain-on-failure';

function normalizeTraceMode(raw: unknown): TraceMode {
  if (raw === undefined || raw === null || raw === '' || raw === 'off') return 'off';
  if (raw === 'on' || raw === 'retain-on-failure') return raw;
  throw new ArgumentError(`--trace must be one of: off, on, retain-on-failure. Received: "${String(raw)}"`);
}

export function coerceAndValidateArgs(cmdArgs: Arg[], kwargs: CommandArgs): CommandArgs {
  const result: CommandArgs = { ...kwargs };

  for (const argDef of cmdArgs) {
    const val = result[argDef.name];

    if (argDef.required && (val === undefined || val === null || val === '')) {
      throw new ArgumentError(
        `Argument "${argDef.name}" is required.`,
        argDef.help ?? `Provide a value for --${argDef.name}`,
      );
    }

    if (val !== undefined && val !== null) {
      if (argDef.type === 'int' || argDef.type === 'number') {
        const num = Number(val);
        if (Number.isNaN(num)) {
          throw new ArgumentError(`Argument "${argDef.name}" must be a valid number. Received: "${val}"`);
        }
        result[argDef.name] = num;
      } else if (argDef.type === 'boolean' || argDef.type === 'bool') {
        if (typeof val === 'string') {
          const lower = val.toLowerCase();
          if (lower === 'true' || lower === '1') result[argDef.name] = true;
          else if (lower === 'false' || lower === '0') result[argDef.name] = false;
          else throw new ArgumentError(`Argument "${argDef.name}" must be a boolean (true/false). Received: "${val}"`);
        } else {
          result[argDef.name] = Boolean(val);
        }
      }

      const coercedVal = result[argDef.name];
      if (argDef.choices && argDef.choices.length > 0) {
        if (!argDef.choices.map(String).includes(String(coercedVal))) {
          throw new ArgumentError(`Argument "${argDef.name}" must be one of: ${argDef.choices.join(', ')}. Received: "${coercedVal}"`);
        }
      }
    } else if (argDef.default !== undefined) {
      result[argDef.name] = argDef.default;
    }
  }
  return result;
}

async function runCommand(
  cmd: CliCommand,
  page: IPage | null,
  kwargs: CommandArgs,
  debug: boolean,
): Promise<unknown> {
  const internal = cmd as InternalCliCommand;
  if (internal._lazy && internal._modulePath) {
    const loadedEntry = await loadLazyModule(internal);

    // Use the command registered by this import generation. A newer file
    // generation may already be queued/current, but an execution that began
    // on the older generation is allowed to finish with its own command.
    const updated = loadedEntry?.registeredCommands.get(fullName(cmd));
    if (loadedEntry && updated?.func) {
      finalizeCommandRegistration(loadedEntry, fullName(cmd));
      return runCommandFunc(updated, page, kwargs, debug);
    }
    if (loadedEntry && updated?.pipeline) {
      finalizeCommandRegistration(loadedEntry, fullName(cmd));
      return executePipeline(page, updated.pipeline, { args: kwargs, debug });
    }
  }

  if (cmd.func) return runCommandFunc(cmd, page, kwargs, debug);
  if (cmd.pipeline) return executePipeline(page, cmd.pipeline, { args: kwargs, debug });
  throw new CommandExecutionError(
    `Command ${fullName(cmd)} has no func or pipeline`,
    'This is likely a bug in the adapter definition. Please report this issue.',
  );
}

function moduleFingerprint(modulePath: string): string | undefined {
  try {
    _fingerprintReadCount += 1;
    return crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex');
  } catch {
    return undefined;
  }
}

function isHotReloadableModule(modulePath: string): boolean {
  const prefix = getUserClisDir() + path.sep;
  return modulePath.startsWith(prefix);
}

function refreshCapturedCommands(entry: ModuleLoadEntry): void {
  entry.registeredCommands = capturedRegistryValues(entry.transaction);
}

function rollbackImport(entry: ModuleLoadEntry): void {
  rollbackRegistryTransaction(entry.transaction, getRegistry());
}

function rollbackCommandRegistration(entry: ModuleLoadEntry, key: string): void {
  const groups = transactionGroupsForKey(entry.transaction, key);
  rollbackRegistryTransaction(entry.transaction, getRegistry(), groups);
}

function finalizeCommandRegistration(entry: ModuleLoadEntry, key: string): void {
  const groups = transactionGroupsForKey(entry.transaction, key);
  finalizeRegistryTransaction(entry.transaction, getRegistry(), groups);
}

async function performRegistrationImport(entry: ModuleLoadEntry, importUrl: string, modulePath: string): Promise<void> {
  if (_registrationImportsPoisoned) throw poisonedImportError();
  const settlement = runRegistryTransaction(entry.transaction, () => import(importUrl)).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timeout: true }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ timeout: true }), adapterImportTimeoutMs());
  });
  const outcome = await Promise.race([settlement, timeout]);
  if ('timeout' in outcome) {
    _registrationImportsPoisoned = true;
    closeRegistryTransaction(entry.transaction);
    rollbackImport(entry);
    void settlement.then(() => {
      refreshCapturedCommands(entry);
      rollbackImport(entry);
    });
    throw adapterLoadError(
      `Adapter module ${modulePath} registration timed out after ${adapterImportTimeoutMs()}ms.`,
      'Restart byCLI before retrying; ESM evaluation cannot be cancelled safely.',
    );
  }
  if (timeoutId) clearTimeout(timeoutId);
  refreshCapturedCommands(entry);
  if (!outcome.ok) {
    rollbackImport(entry);
    throw adapterLoadError(
      `Failed to load adapter module ${modulePath}: ${getErrorMessage(outcome.error)}`,
      'Check that the adapter file exists and has no syntax errors.',
    );
  }
}

function scheduleRegistrationImport(entry: ModuleLoadEntry, importUrl: string, modulePath: string): Promise<void> {
  const scheduled = _registrationImportTail.then(
    () => performRegistrationImport(entry, importUrl, modulePath),
    () => performRegistrationImport(entry, importUrl, modulePath),
  );
  _registrationImportTail = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

async function loadLazyModule(internal: InternalCliCommand): Promise<ModuleLoadEntry | undefined> {
  const modulePath = internal._modulePath;
  if (!internal._lazy || !modulePath) return;
  let entry = _loadedModules.get(modulePath);
  if (entry) {
    if (!entry.hotReloadable) {
      await entry.promise;
      return entry;
    }
    const currentFingerprint = moduleFingerprint(modulePath);
    if (entry.fingerprint === currentFingerprint) {
      await entry.promise;
      return entry;
    }
    if (_registrationImportsPoisoned) throw poisonedImportError();
    invalidateLazyModule(modulePath, entry);
    entry = undefined;
  }
  if (_registrationImportsPoisoned) throw poisonedImportError();

  if (!entry) {
    const hotReloadable = isHotReloadableModule(modulePath);
    const fingerprint = hotReloadable ? moduleFingerprint(modulePath) : undefined;
    const url = pathToFileURL(modulePath).href;
    const generation = _moduleImportGenerations.get(modulePath) ?? 0;
    const importUrl = generation === 0 ? url : `${url}?v=${generation}`;
    const createdEntry: ModuleLoadEntry = {
      promise: Promise.resolve(),
      fingerprint,
      generation,
      registeredCommands: new Map(),
      transaction: createRegistryTransaction(),
      hotReloadable,
    };
    createdEntry.promise = scheduleRegistrationImport(createdEntry, importUrl, modulePath).catch((error) => {
      invalidateLazyModule(modulePath, createdEntry);
      throw error;
    });
    _loadedModules.set(modulePath, createdEntry);
    entry = createdEntry;
  }
  await entry.promise;
  return entry;
}

function invalidateLazyModule(
  modulePath: string | undefined,
  expectedEntry?: ModuleLoadEntry,
): void {
  if (!modulePath) return;
  const currentEntry = _loadedModules.get(modulePath);
  if (!currentEntry || (expectedEntry && currentEntry !== expectedEntry)) return;
  if (currentEntry.transaction.active) {
    void currentEntry.promise.then(
      () => finalizeRegistryTransaction(currentEntry.transaction, getRegistry()),
      () => finalizeRegistryTransaction(currentEntry.transaction, getRegistry()),
    );
  } else {
    finalizeRegistryTransaction(currentEntry.transaction, getRegistry());
  }
  _loadedModules.delete(modulePath);
  _moduleImportGenerations.set(
    modulePath,
    Math.max(_moduleImportGenerations.get(modulePath) ?? 0, currentEntry.generation) + 1,
  );
}

function assertMatchingArgSchema(
  placeholder: CliCommand,
  hydrated: CliCommand,
  loadedEntry: ModuleLoadEntry | undefined,
): void {
  const key = fullName(placeholder);
  try {
    const manifestSchema = canonicalizeManifestArgSchema(placeholder.args, `Manifest command ${key}`);
    const moduleSchema = canonicalizeManifestArgSchema(hydrated.args, `Hydrated command ${key}`);
    if (manifestSchema === moduleSchema) return;
  } catch (error) {
    if (loadedEntry) rollbackCommandRegistration(loadedEntry, key);
    invalidateLazyModule((placeholder as InternalCliCommand)._modulePath, loadedEntry);
    if (!(error instanceof ManifestSchemaError)) throw error;
    throw new CommandExecutionError(
      `Conditional adapter ${key} has an unsafe argument schema: ${error.message}`,
      'Use only JSON-safe defaults and string choices, then rebuild the CLI manifest.',
    );
  }
  if (loadedEntry) rollbackCommandRegistration(loadedEntry, key);
  invalidateLazyModule((placeholder as InternalCliCommand)._modulePath, loadedEntry);
  throw new CommandExecutionError(
    `Conditional adapter ${key} argument schema does not match its manifest`,
    'Rebuild the CLI manifest so defaults, coercion, and validation use the adapter module schema.',
  );
}

async function hydrateConditionalCommand(cmd: CliCommand): Promise<CliCommand> {
  const internal = cmd as InternalCliCommand;
  const key = fullName(cmd);
  if (cmd.browser !== 'conditional') {
    throw new CommandExecutionError(
      `Conditional adapter placeholder ${key} has invalid browser metadata`,
      'Rebuild the CLI manifest with the current byCLI version.',
    );
  }
  const placeholderResolver = cmd.requiresBrowser;
  let loadedEntry: ModuleLoadEntry | undefined;
  try {
    loadedEntry = await loadLazyModule(internal);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CommandExecutionError(
      `Failed to hydrate conditional adapter ${key}: ${getErrorMessage(error)}`,
      'Rebuild or reinstall the adapter so its manifest and module are both available.',
    );
  }

  const hydrated = loadedEntry?.registeredCommands.get(key);
  const invalidReplacement = !hydrated
    || hydrated === cmd
    || fullName(hydrated) !== key
    || hydrated.browser !== 'conditional';
  if (invalidReplacement) {
    if (loadedEntry) rollbackCommandRegistration(loadedEntry, key);
    invalidateLazyModule(internal._modulePath, loadedEntry);
    throw new CommandExecutionError(
      `Conditional adapter ${key} did not register a valid hydrated conditional command`,
      'Ensure the module registers the same site/name with a browser predicate and is rebuilt with the current byCLI version.',
    );
  }
  const hydratedInternal = hydrated as InternalCliCommand;
  if (
    typeof hydrated.requiresBrowser !== 'function'
    || hydrated.requiresBrowser === placeholderResolver
    || hydratedInternal._hydrateBeforeBrowserRouting === true
    || hydratedInternal._lazy === true
    || hydratedInternal._modulePath !== undefined
  ) {
    if (loadedEntry) rollbackCommandRegistration(loadedEntry, key);
    invalidateLazyModule(internal._modulePath, loadedEntry);
    throw new CommandExecutionError(
      `Conditional adapter ${key} did not register a valid hydrated conditional command`,
      'Ensure the module registers the same site/name with a browser predicate and is rebuilt with the current byCLI version.',
    );
  }
  assertMatchingArgSchema(cmd, hydrated, loadedEntry);
  if (loadedEntry) finalizeCommandRegistration(loadedEntry, key);
  return hydrated;
}

function runCommandFunc(cmd: CliCommand, page: IPage | null, kwargs: CommandArgs, debug: boolean): Promise<unknown> {
  if (cmd.browser === false) return cmd.func!(kwargs, debug);
  if (cmd.browser === 'conditional') return cmd.func!(page, kwargs, debug);
  if (!page) {
    throw new CommandExecutionError(`Command ${fullName(cmd)} requires a browser session but none was provided`);
  }
  return (cmd as BrowserCliCommand).func!(page, kwargs, debug);
}

function resolveBrowserRequirement(cmd: CliCommand, kwargs: CommandArgs): boolean {
  if (cmd.browser !== 'conditional') return cmd.browser;
  try {
    return Boolean(cmd.requiresBrowser(kwargs));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CommandExecutionError(
      `Browser requirement evaluation failed for ${fullName(cmd)}: ${getErrorMessage(error)}`,
    );
  }
}

function resolvePreNav(cmd: CliCommand): string | null {
  if (cmd.navigateBefore === false) return null;
  if (typeof cmd.navigateBefore === 'string') return cmd.navigateBefore;
  // strategy → navigateBefore expansion already happened in normalizeCommand().
  return null;
}

function urlMatchesDomain(url: string | null | undefined, domain: string | undefined): boolean {
  if (!url || !domain) return false;
  try {
    const hostname = new URL(url).hostname;
    return hostname === domain || hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function isDomainRootPreNav(preNavUrl: string, domain: string | undefined): boolean {
  if (!domain) return false;
  try {
    const parsed = new URL(preNavUrl);
    const hostnameMatches = parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`);
    const rootPath = parsed.pathname === '' || parsed.pathname === '/';
    return hostnameMatches && rootPath && parsed.search === '' && parsed.hash === '';
  } catch {
    return false;
  }
}

async function shouldRunPreNav(cmd: CliCommand, page: IPage, siteSession: SiteSessionMode, preNavUrl: string): Promise<boolean> {
  if (siteSession !== 'persistent' || !cmd.domain) return true;
  if (!isDomainRootPreNav(preNavUrl, cmd.domain)) return true;
  const currentUrl = await page.getCurrentUrl?.().catch(() => null);
  return !urlMatchesDomain(currentUrl, cmd.domain);
}

export async function executeCommand(
  cmd: CliCommand,
  rawKwargs: CommandArgs,
  debug: boolean = false,
  opts: {
    prepared?: boolean;
    profile?: string;
    trace?: string;
    keepTab?: string;
    windowMode?: string;
    siteSession?: string;
    adapterSession?: string;
    adapterQueueTimeout?: string;
    onTraceExport?: (trace: ObservationExportResult) => void;
  } = {},
): Promise<unknown> {
  const initialTraceCommand = cmd as InternalCliCommand;
  let kwargs = opts.prepared
    ? rawKwargs
    : prepareCommandArgsOrThrowArgumentError(cmd, rawKwargs);

  if ((cmd as InternalCliCommand)._hydrateBeforeBrowserRouting) {
    cmd = await hydrateConditionalCommand(cmd);
    // Manifest placeholders cannot serialize adapter validators. The matching
    // schema above guarantees coercion/defaults stay valid; run only the real
    // module validator here so custom validation has exactly one side effect.
    try {
      cmd.validateArgs?.(kwargs);
    } catch (error) {
      if (error instanceof ArgumentError) throw error;
      throw new ArgumentError(getErrorMessage(error));
    }
  }

  const traceMode = normalizeTraceMode(opts.trace);

  const hookCtx: HookContext = {
    command: fullName(cmd),
    args: kwargs,
    startedAt: Date.now(),
  };
  await emitHook('onBeforeExecute', hookCtx);
  kwargs = hookCtx.args;

  let result: unknown;
  try {
    const resolvedBrowser = resolveBrowserRequirement(cmd, kwargs);
    const adapterSession = normalizeAdapterSession(cmd, resolvedBrowser, opts.adapterSession);
    const adapterQueueTimeoutSeconds = normalizeAdapterQueueTimeout(opts.adapterQueueTimeout, adapterSession);
    const userTimeoutSec = readUserTimeoutSeconds(cmd, kwargs);
    if (shouldUseBrowserSession(cmd, resolvedBrowser)) {
      const electron = isElectronApp(cmd.site);
      let cdpEndpoint: string | undefined;

      if (electron) {
        // Electron apps: respect manual endpoint override, then try auto-detect
        const manualEndpoint = process.env.BYCLI_CDP_ENDPOINT;
        if (manualEndpoint) {
          const port = Number(new URL(manualEndpoint).port);
          if (!await probeCDP(port)) {
            throw new CommandExecutionError(
              `CDP not reachable at ${manualEndpoint}`,
              'Check that the app is running with --remote-debugging-port and the endpoint is correct.',
            );
          }
          cdpEndpoint = manualEndpoint;
        } else {
          cdpEndpoint = await resolveElectronEndpoint(cmd.site);
        }
      }

      const BrowserFactory = getBrowserFactory(cmd.site);
      const contextId = resolveProfileContextId(opts.profile);
      const internal = cmd as InternalCliCommand;
      const siteSession = resolveSiteSession(cmd, opts.siteSession);
      assertAdapterSessionLifecycle(siteSession, adapterSession);
      const session = resolveAdapterBrowserSession(cmd, siteSession, adapterSession);
      const keepTab = resolveKeepTab(siteSession, opts.keepTab);
      const windowMode = resolveBrowserWindowMode('background', opts.windowMode);
      const executeInBrowser = () => browserSession(BrowserFactory, async (page) => {
        // BrowserBridge.connect() has started/probed the daemon by this point. Resolve
        // the daemon's canonical profile before acquiring a profile-scoped lease.
        const leaseContextId = adapterSession
          ? await resolveAdapterLeaseContextId(contextId)
          : undefined;
        if (leaseContextId) page.setContextId?.(leaseContextId);
        const executeOnPage = async () => {
        const observation = traceMode === 'off'
          ? null
          : new ObservationSession({
            scope: {
              contextId,
              session: adapterSession ? adapterSessionDiagnosticKey(cmd.site, adapterSession) : session,
              target: page.getActivePage?.(),
              site: cmd.site,
              command: fullName(cmd),
              adapterSourcePath: resolveAdapterSourcePath(internal)
                ?? resolveAdapterSourcePath(initialTraceCommand),
            },
          });
        if (observation) {
          observation.record({
            stream: 'action',
            name: 'command',
            phase: 'start',
            data: { args: kwargs },
          });
          await page.startNetworkCapture?.().catch(() => false);
        }
        const preNavUrl = resolvePreNav(cmd);
        if (preNavUrl && await shouldRunPreNav(cmd, page, siteSession, preNavUrl)) {
          observation?.record({
            stream: 'action',
            name: 'pre_navigate',
            phase: 'start',
            data: { url: preNavUrl },
          });
          // Navigate directly — the extension's handleNavigate already has a fast-path
          // that skips navigation if the tab is already at the target URL.
          // This avoids an extra exec round-trip (getCurrentUrl) on first command and
          // lets the extension create the automation window with the target URL directly
          // instead of about:blank.
          try {
            await page.goto(preNavUrl);
            observation?.record({
              stream: 'action',
              name: 'pre_navigate',
              phase: 'end',
              data: { url: preNavUrl },
            });
          } catch (err) {
            observation?.record({
              stream: 'action',
              name: 'pre_navigate',
              phase: 'error',
              data: { url: preNavUrl, error: err instanceof Error ? err.message : String(err) },
            });
            const wrapped = new CommandExecutionError(
              `Pre-navigation to ${preNavUrl} failed: ${err instanceof Error ? err.message : err}`,
              'Check that the site is reachable and the browser extension is running.',
            );
            if (observation && (traceMode === 'on' || traceMode === 'retain-on-failure')) {
              observation.record({
                stream: 'error',
                message: wrapped.message,
                stack: wrapped.stack,
                code: wrapped.code,
                hint: wrapped.hint,
              });
              await collectObservationEvidence(observation, page).catch(() => {});
              exportTraceArtifact(observation, 'failure', wrapped, opts.onTraceExport);
            }
            throw wrapped;
          }
        }
        try {
          const browserTimeout = userTimeoutSec !== null
            ? userTimeoutSec + RUNTIME_TIMEOUT_PADDING_SECONDS
            : DEFAULT_BROWSER_COMMAND_TIMEOUT;
          const commandOperation = runCommand(cmd, page, kwargs, debug);
          const result = adapterSession
            ? await settleAdapterOperationAfterTimeout(
                commandOperation,
                browserTimeout * 1_000,
                new TimeoutError(fullName(cmd), browserTimeout),
                async () => { await page.closeWindow?.().catch(() => {}); },
              )
            : await runWithTimeout(commandOperation, {
                timeout: browserTimeout,
                label: fullName(cmd),
              });
          observation?.record({
            stream: 'action',
            name: 'command',
            phase: 'end',
          });
          if (observation && traceMode === 'on') {
            await collectObservationEvidence(observation, page).catch(() => {});
            exportTraceArtifact(observation, 'success', undefined, opts.onTraceExport);
          }
          // Adapter commands are one-shot — release the current tab lease immediately
          // instead of waiting for the 30s idle timeout. The automation container
          // window stays open for reuse.
          if (!keepTab) await page.closeWindow?.().catch(() => {});
          return result;
        } catch (err) {
          if (observation) {
            observation.record({
              stream: 'action',
              name: 'command',
              phase: 'error',
              data: { error: err instanceof Error ? err.message : String(err) },
            });
            observation.record({
              stream: 'error',
              message: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            });
            if (traceMode === 'on' || traceMode === 'retain-on-failure') {
              await collectObservationEvidence(observation, page).catch(() => {});
              exportTraceArtifact(observation, 'failure', err, opts.onTraceExport);
            }
          }
          // Release the tab lease on failure too — without this, the lease lingers
          // until the extension's idle timer fires (unreliable on Windows where
          // MV3 service workers may be suspended before setTimeout triggers).
          if (!keepTab) await page.closeWindow?.().catch(() => {});
          throw err;
        }
        };
        if (!adapterSession) return executeOnPage();
        return withAdapterCommandLease({
          requestId: crypto.randomUUID(),
          contextId: leaseContextId!,
          surface: 'adapter',
          site: cmd.site,
          adapterSession,
          sessionKey: session,
          queueTimeoutMs: (adapterQueueTimeoutSeconds ?? 300) * 1_000,
          maxParallel: cmd.adapterConcurrency?.maxParallel ?? 1,
        }, executeOnPage, {
          onLeaseLost: async () => { await page.closeWindow?.().catch(() => {}); },
        });
      }, { session, cdpEndpoint, contextId, windowMode, surface: 'adapter', siteSession });
      result = await executeInBrowser();
    } else {
      // Non-browser commands: enforce a timeout only when the command exposes
      // a `--timeout` arg (and the resolved value is positive). Without that
      // arg there is no meaningful default — non-browser cmds are diverse
      // enough that a hard cap would do more harm than good.
      if (userTimeoutSec !== null) {
        const ceiling = userTimeoutSec + RUNTIME_TIMEOUT_PADDING_SECONDS;
        result = await runWithTimeout(runCommand(cmd, null, kwargs, debug), {
          timeout: ceiling,
          label: fullName(cmd),
          hint: `Pass a higher --timeout value (currently ${userTimeoutSec}s)`,
        });
      } else {
        result = await runCommand(cmd, null, kwargs, debug);
      }
    }
  } catch (err) {
    hookCtx.error = err;
    hookCtx.finishedAt = Date.now();
    await emitHook('onAfterExecute', hookCtx);
    throw err;
  }

  hookCtx.finishedAt = Date.now();
  await emitHook('onAfterExecute', hookCtx, result);
  return result;
}

async function collectObservationEvidence(session: ObservationSession, page: IPage): Promise<void> {
  const target = page.getActivePage?.() ?? session.scope.target;
  const [url, snapshot, networkEntries, consoleMessages, screenshot] = await Promise.all([
    page.getCurrentUrl?.().catch(() => null) ?? Promise.resolve(null),
    page.snapshot().catch(() => undefined),
    page.readNetworkCapture?.().catch(() => []) ?? Promise.resolve([]),
    page.consoleMessages('all').catch(() => []),
    page.screenshot({ format: 'png' }).catch(() => undefined),
  ]);

  if (snapshot !== undefined || url !== undefined) {
    session.record({ stream: 'state', url, target, snapshot, label: 'final' });
  }
  for (const entry of Array.isArray(networkEntries) ? networkEntries : []) {
    const record = entry as Record<string, unknown>;
    session.record({
      stream: 'network',
      url: String(record.url ?? ''),
      method: typeof record.method === 'string' ? record.method : undefined,
      status: typeof record.responseStatus === 'number' ? record.responseStatus : undefined,
      contentType: typeof record.responseContentType === 'string' ? record.responseContentType : undefined,
      size: typeof record.responseBodyFullSize === 'number' ? record.responseBodyFullSize : undefined,
      requestHeaders: record.requestHeaders as Record<string, unknown> | undefined,
      responseHeaders: record.responseHeaders as Record<string, unknown> | undefined,
      requestBody: record.requestBodyPreview,
      responseBody: record.responsePreview,
      ts: typeof record.timestamp === 'number' ? record.timestamp : undefined,
    });
  }
  for (const message of Array.isArray(consoleMessages) ? consoleMessages : []) {
    if (message && typeof message === 'object') {
      const record = message as Record<string, unknown>;
      session.record({
        stream: 'console',
        level: String(record.type ?? record.level ?? 'log'),
        text: String(record.text ?? record.message ?? ''),
        ts: typeof record.timestamp === 'number' ? record.timestamp : undefined,
      });
    } else {
      session.record({ stream: 'console', level: 'log', text: String(message) });
    }
  }
  if (typeof screenshot === 'string' && screenshot) {
    session.record({ stream: 'screenshot', format: 'png', data: screenshot, label: 'final' });
  }
}

function exportTraceArtifact(
  session: ObservationSession,
  status: ObservationExportStatus,
  error?: unknown,
  onTraceExport?: (trace: ObservationExportResult) => void,
): ObservationExportResult | undefined {
  try {
    const trace = exportObservationSession(session, { error, status });
    if (status === 'failure' && error !== undefined) {
      attachTraceReceipt(error, trace.receipt);
    } else {
      process.stderr.write(`byCLI trace artifact: ${trace.dir}\n`);
    }
    try {
      onTraceExport?.(trace);
    } catch (err) {
      log.warn(`[trace] Trace export callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return trace;
  } catch (err) {
    log.warn(`[trace] Failed to export trace artifact: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export function prepareCommandArgs(
  cmd: CliCommand,
  rawKwargs: CommandArgs,
): CommandArgs {
  const kwargs = coerceAndValidateArgs(cmd.args, rawKwargs);
  cmd.validateArgs?.(kwargs);
  return kwargs;
}

/** Prepare adapter arguments using the execution boundary's public error contract. */
export function prepareCommandArgsOrThrowArgumentError(
  cmd: CliCommand,
  rawKwargs: CommandArgs,
): CommandArgs {
  try {
    return prepareCommandArgs(cmd, rawKwargs);
  } catch (err) {
    if (err instanceof ArgumentError) throw err;
    throw new ArgumentError(getErrorMessage(err));
  }
}

/**
 * Runtime ceiling padding (seconds) added on top of the user's `--timeout`.
 * The adapter's polling loop typically uses the full user value; the padding
 * gives us room for the adapter to return + closeWindow + trace export before
 * the runtime kills the Promise.
 */
const RUNTIME_TIMEOUT_PADDING_SECONDS = 30;

function normalizeSiteSession(raw: unknown): SiteSessionMode | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (raw === 'ephemeral' || raw === 'persistent') return raw;
  throw new ArgumentError(`--site-session must be one of: ephemeral, persistent. Received: "${String(raw)}"`);
}

function resolveSiteSession(cmd: CliCommand, rawOption?: unknown): SiteSessionMode {
  return normalizeSiteSession(rawOption) ?? cmd.siteSession ?? 'ephemeral';
}

function normalizeAdapterSession(
  cmd: CliCommand,
  resolvedBrowser: boolean,
  rawOption?: unknown,
): string | undefined {
  if (rawOption === undefined || rawOption === null || rawOption === '') return undefined;
  if (!resolvedBrowser || cmd.adapterConcurrency?.isolatedTabs !== true) {
    throw new AdapterCoordinationError(
      'ADAPTER_SESSION_NOT_SUPPORTED',
      `${fullName(cmd)} does not support named Adapter sessions`,
    );
  }
  const value = String(rawOption);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new AdapterCoordinationError(
      'INVALID_ADAPTER_SESSION',
      '--adapter-session must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}',
    );
  }
  return value;
}

function normalizeAdapterQueueTimeout(rawOption: unknown, adapterSession: string | undefined): number | undefined {
  if (rawOption === undefined || rawOption === null || rawOption === '') {
    return adapterSession ? 300 : undefined;
  }
  if (!adapterSession) {
    throw new AdapterCoordinationError(
      'INVALID_ADAPTER_QUEUE_TIMEOUT',
      '--adapter-queue-timeout requires --adapter-session',
    );
  }
  const value = typeof rawOption === 'string' && /^\d+$/.test(rawOption) ? Number(rawOption) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > 3600) {
    throw new AdapterCoordinationError(
      'INVALID_ADAPTER_QUEUE_TIMEOUT',
      '--adapter-queue-timeout must be an integer between 1 and 3600 seconds',
    );
  }
  return value;
}

function assertAdapterSessionLifecycle(siteSession: SiteSessionMode, adapterSession: string | undefined): void {
  if (adapterSession && siteSession !== 'persistent') {
    throw new AdapterCoordinationError(
      'ADAPTER_SESSION_REQUIRES_PERSISTENT',
      '--adapter-session requires --site-session persistent',
    );
  }
}

function resolveAdapterBrowserSession(cmd: CliCommand, siteSession: SiteSessionMode, adapterSession?: string): string {
  if (siteSession === 'persistent') {
    return adapterSession ? `site:${cmd.site}:${adapterSession}` : `site:${cmd.site}`;
  }
  return `site:${cmd.site}:${crypto.randomUUID()}`;
}

function adapterSessionDiagnosticKey(site: string, adapterSession: string): string {
  const digest = crypto.createHash('sha256').update(adapterSession).digest('hex').slice(0, 12);
  return `site:${site}:adapter-${digest}`;
}

function normalizeBooleanOption(name: string, raw: unknown): boolean | null {
  if (raw === undefined || raw === '') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ArgumentError(`${name} must be one of: true, false. Received: "${String(raw)}"`);
}

function resolveKeepTab(siteSession: SiteSessionMode, rawOption?: unknown): boolean {
  if (siteSession === 'persistent') return true;
  return normalizeBooleanOption('--keep-tab', rawOption) ?? false;
}

function normalizeWindowMode(name: string, raw: unknown): BrowserWindowMode | null {
  if (raw === undefined || raw === '') return null;
  if (raw === 'foreground' || raw === 'background') return raw;
  throw new ArgumentError(`${name} must be one of: foreground, background. Received: "${String(raw)}"`);
}

function resolveBrowserWindowMode(defaultMode: BrowserWindowMode = 'background', rawOption?: unknown): BrowserWindowMode {
  return normalizeWindowMode('--window', rawOption)
    ?? normalizeWindowMode('BYCLI_WINDOW', process.env.BYCLI_WINDOW)
    ?? defaultMode;
}

/**
 * Resolve the user-controllable `--timeout` arg, in seconds.
 *
 * Convention: a command opts into runtime-enforced timeouts by declaring an
 * arg named `timeout`. The arg's `default` flows through `prepareCommandArgs`
 * into `kwargs.timeout`, so by the time runtime enforcement runs, the value
 * is the merged user-supplied-or-default seconds.
 *
 * Returns the parsed positive integer (seconds), or null if the command does
 * not expose a `timeout` arg. Declaring `timeout` opts into runtime timeout
 * enforcement, so invalid values must fail upfront instead of silently
 * disabling the runtime ceiling.
 */
function readUserTimeoutSeconds(cmd: CliCommand, kwargs: CommandArgs): number | null {
  if (!cmd.args.some(a => a.name === 'timeout')) return null;
  const raw = kwargs.timeout;
  if (raw === undefined || raw === null || raw === '') {
    throw new ArgumentError(`Argument "timeout" must be a positive integer. Received: "${String(raw)}"`);
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ArgumentError(`Argument "timeout" must be a positive integer. Received: "${String(raw)}"`);
  }
  return parsed;
}
