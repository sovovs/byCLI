/**
 * Verify runner — child-process entry (`bycli internal verify-runner --jsonl`, 08).
 *
 * Runs ONE user adapter in an isolated child process (08 boundary: user adapter JS
 * never executes in the API/Local Service main process). The runner reads input.json,
 * loads the target adapter by path, validates it, runs it (M6a: non-browser adapters
 * only), and emits the 08 JSONL protocol on stdout: `started` → … → exactly one
 * terminal `result`. stderr is diagnostic only.
 *
 * M6a scope (甲 · prove the mechanism): non-browser adapters actually execute; browser
 * adapters report not-yet (their Page must come from the daemon — M6b). The spawn /
 * input.json security / timeout / byte-cap mechanism lives in `runner-port.ts`.
 *
 * SECURITY (07:123-124): raw executionSeedArgs arrive via input.json (0600) and are used
 * as the adapter's call args; they are never echoed into the emitted result/started events.
 */

import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getRegistry, fullName, type BrowserCliCommand, type CliCommand, type InternalCliCommand } from '../../registry.js';
import type { RunnerEvent, RunnerResultEvent } from '@sovovs/bycli-recorder-core';

/** Parsed input.json (written by RunnerPort; raw seed args are execution-only). */
export interface RunnerInput {
  requestId: string;
  name: string;
  /** Resolved adapter module file to import. */
  adapterPath: string;
  /** Browser profile contextId for browser adapters (M6b). Omitted → daemon default profile. */
  contextId?: string;
  /** Raw seed args — used as the adapter call args, never echoed into events. */
  executionSeedArgs?: Record<string, unknown>;
  fixture?: 'ignore' | 'match' | 'update';
  trace?: 'off' | 'retain-on-failure' | 'always';
}

type ResultData = NonNullable<RunnerResultEvent['data']>;
type ResultError = NonNullable<RunnerResultEvent['error']>;

// ── Lease cleanup on signal / orphan watchdog (Codex #4, #7) ────────────────
// A browser adapter holds a daemon-side tab lease. If the parent SIGTERMs/cancels this child
// (timeout/cancel) or this child is orphaned (parent crashed → no SIGTERM, and on win32 the reaper
// has no portable way to kill it), the adapter's own `finally closeWindow` may not run, leaking the
// lease until idle-expiry. We track the active page cleanup so a SIGTERM handler can release it
// before exit, and a self-watchdog force-exits an orphaned child so a leaked runner never runs forever.
let activeLeaseCleanup: (() => Promise<void>) | null = null;

/** Register the current run's lease cleanup (browser runner). Returns a disposer that clears it. */
export function setActiveLeaseCleanup(cleanup: () => Promise<void>): () => void {
  activeLeaseCleanup = cleanup;
  return () => { if (activeLeaseCleanup === cleanup) activeLeaseCleanup = null; };
}

/** Run + clear the active lease cleanup, bounded so a hung cleanup never blocks exit. Best-effort. */
export async function releaseActiveLease(maxWaitMs = 1000): Promise<void> {
  const cleanup = activeLeaseCleanup;
  activeLeaseCleanup = null;
  if (!cleanup) return;
  await Promise.race([
    Promise.resolve().then(cleanup).catch(() => { /* best-effort */ }),
    new Promise<void>((resolve) => { const t = setTimeout(resolve, maxWaitMs); t.unref?.(); }),
  ]);
}

/**
 * Install the signal + watchdog backstops (#4, #7). On SIGTERM/SIGINT (parent timeout/cancel) release
 * the browser lease, then exit. The self-watchdog force-exits an ORPHANED child (parent crashed → no
 * SIGTERM; on win32 the reaper cannot kill it) after `maxRuntimeMs`, so a leaked child never runs
 * forever. The parent sets `maxRuntimeMs` above its own timeout, so the watchdog only fires when orphaned.
 */
export function installRunnerBackstops(maxRuntimeMs: number): void {
  const onSignal = (code: number): void => { void releaseActiveLease().finally(() => process.exit(code)); };
  process.once('SIGTERM', () => onSignal(143));
  process.once('SIGINT', () => onSignal(130));
  if (maxRuntimeMs > 0) {
    const wd = setTimeout(() => { void releaseActiveLease().finally(() => process.exit(1)); }, maxRuntimeMs);
    wd.unref?.(); // never keep an otherwise-idle process alive just for the watchdog
  }
}

/** Map an input fixture policy to the runner's emitted fixture.status. M6a does not
 * compare against a stored fixture, so nothing is "matched" — update→updated else ignored. */
function fixtureStatus(policy: RunnerInput['fixture']): ResultData['fixture'] {
  return { status: policy === 'update' ? 'updated' : 'ignored' };
}

/** Fixed text replacing an adapter-evaluation (module top-level throw) error message, which could
 * echo adapter-file contents — the structured code is kept, the raw text withheld (Codex M7c). */
const REDACTED_ADAPTER_LOAD_MESSAGE =
  'adapter failed to load (details withheld to avoid leaking adapter-file contents)';

/** Derive the field COUNT of the first object row — never the key names, which could be seed values
 * if the adapter keys its output on one (Codex M7c). The names are not even computed/returned. */
function fieldCountOf(rows: unknown): number | undefined {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const first = rows[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    return Object.keys(first as Record<string, unknown>).length;
  }
  return undefined;
}

/**
 * Load an adapter by importing its module (which registers via `cli()`), then look it up
 * in the registry by name. Mirrors execution.ts's lazy-import pattern (118-135).
 */
export async function loadAdapterByName(adapterPath: string, name: string): Promise<CliCommand | undefined> {
  const url = pathToFileURL(adapterPath).href; // runner-side; a bad path surfaces verbatim
  try {
    await import(url);
  } catch (e) {
    // The adapter module's top-level code threw during evaluation (a SyntaxError, or a deliberate
    // `throw` that could echo adapter-file contents) — tag it so runVerifyRunner redacts the message
    // (Codex M7c). Runner-side failures (bad path / resolve) are NOT tagged and surface verbatim.
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { adapterEvaluation: true });
  }
  return getRegistry().get(name);
}

/**
 * The browser-adapter execution seam (M6b). A browser adapter's `func` needs an IPage; the
 * default implementation connects BACK to the running daemon for one. Injectable so unit
 * tests can exercise executeAdapterForVerify without a real daemon/browser.
 */
export type BrowserAdapterRunner = (
  command: BrowserCliCommand,
  opts: { seedArgs: Record<string, unknown>; contextId?: string; preNavUrl: string | null },
) => Promise<unknown>;

/**
 * Default browser runner (M6b): construct a daemon-backed Page DIRECTLY — not via
 * BrowserBridge, whose connect() would health-check and spawn/restart a daemon. The child
 * process must only ever attach to the daemon that spawned it (BYCLI_DAEMON_PORT), never
 * manage daemon lifecycle. Uses an ephemeral per-run session + background automation window,
 * and always releases the tab lease in `finally`.
 */
async function defaultBrowserAdapterRunner(
  command: BrowserCliCommand,
  opts: { seedArgs: Record<string, unknown>; contextId?: string; preNavUrl: string | null },
): Promise<unknown> {
  const { Page } = await import('../../browser/page.js');
  const session = `site:${command.site}:${randomUUID()}`;
  const page = new Page(session, undefined, opts.contextId, 'background', 'adapter', 'ephemeral');
  // Register the lease cleanup so a SIGTERM/cancel/watchdog (#4, #7) can release the tab before exit.
  const dispose = setActiveLeaseCleanup(async () => { await page.closeWindow?.(); });
  try {
    if (opts.preNavUrl) await page.goto(opts.preNavUrl);
    return await command.func!(page, opts.seedArgs, false);
  } finally {
    dispose();
    await page.closeWindow?.().catch(() => { /* best-effort; lease idle-expires otherwise */ });
  }
}

/**
 * Validate + run a loaded adapter for verify, returning the terminal result fields. Non-browser
 * adapters run with no page; browser adapters (M6b) go through `browserRunner` (default: a
 * daemon-backed Page). Result/error shaping is shared across both. `browserRunner` is
 * injectable so unit tests run without a real daemon.
 */
export async function executeAdapterForVerify(
  command: CliCommand | undefined,
  opts: {
    name: string;
    fixture?: RunnerInput['fixture'];
    trace?: RunnerInput['trace'];
    seedArgs: Record<string, unknown>;
    contextId?: string;
    browserRunner?: BrowserAdapterRunner;
  },
): Promise<{ ok: true; data: ResultData } | { ok: false; data: ResultData; error: ResultError }> {
  const trace: ResultData['trace'] = { policy: opts.trace ?? 'retain-on-failure', retained: false, path: null };

  if (!command) {
    return { ok: false, data: { stage: 'load', trace }, error: { code: 'runner_protocol_error', message: `adapter "${opts.name}" not found after load` } };
  }
  if (typeof command.func !== 'function') {
    return { ok: false, data: { stage: 'load', trace }, error: { code: 'runner_protocol_error', message: `adapter "${opts.name}" has no func` } };
  }

  try {
    let rows: unknown;
    if (command.browser === false) {
      rows = await command.func(opts.seedArgs, false);
    } else {
      // M6b: browser adapter connects back to the daemon for a Page. navigateBefore is a
      // string only when a concrete pre-nav URL was derived (e.g. COOKIE strategy + domain);
      // `true`/`undefined` mean "adapter handles its own navigation".
      const runner = opts.browserRunner ?? defaultBrowserAdapterRunner;
      rows = await runner(command, {
        seedArgs: opts.seedArgs,
        contextId: opts.contextId,
        preNavUrl: typeof command.navigateBefore === 'string' ? command.navigateBefore : null,
      });
    }
    const data: ResultData = {
      stage: 'execute',
      rows: Array.isArray(rows) ? rows.length : undefined,
      fieldCount: fieldCountOf(rows),
      fixture: fixtureStatus(opts.fixture),
      trace,
    };
    return { ok: true, data };
  } catch (e) {
    // A thrown CliError may carry a code (e.g. auth_required); otherwise it is a runtime error.
    const code = (e as { code?: unknown })?.code;
    const errorCode = typeof code === 'string' && code ? code : 'adapter_runtime_error';
    return {
      ok: false,
      data: { stage: 'execute', trace },
      error: { code: errorCode, message: e instanceof Error ? e.message : String(e) },
    };
  }
}

/**
 * Orchestrate one verify run: emit `started`, load + execute the adapter, emit exactly
 * one terminal `result`. `emit` is injected (stdout JSONL in production, a collector in
 * tests); `load` is injected so unit tests can supply an in-memory command. Never throws —
 * any failure becomes a terminal result so the parent always sees one and only one.
 */
export async function runVerifyRunner(
  input: RunnerInput,
  emit: (event: RunnerEvent) => void,
  load: (adapterPath: string, name: string) => Promise<CliCommand | undefined> = loadAdapterByName,
  browserRunner?: BrowserAdapterRunner,
): Promise<void> {
  emit({ type: 'started', requestId: input.requestId, pid: process.pid, stage: 'load' });
  try {
    const command = await load(input.adapterPath, input.name);
    const r = await executeAdapterForVerify(command, {
      name: input.name,
      fixture: input.fixture,
      trace: input.trace,
      seedArgs: input.executionSeedArgs ?? {},
      contextId: input.contextId,
      browserRunner,
    });
    emit({ type: 'result', requestId: input.requestId, ok: r.ok, data: r.data, error: r.ok ? null : r.error });
  } catch (e) {
    // Load failure → single terminal result. An adapter-evaluation error (tagged by loadAdapterByName)
    // is adapter-controlled and may echo adapter-file contents, so its message is redacted; a
    // runner-side failure (bad path / resolve) is runner-generated and surfaces verbatim (Codex M7c).
    const adapterEval = (e as { adapterEvaluation?: unknown })?.adapterEvaluation === true;
    const message = adapterEval ? REDACTED_ADAPTER_LOAD_MESSAGE : (e instanceof Error ? e.message : String(e));
    emit({
      type: 'result', requestId: input.requestId, ok: false,
      data: { stage: 'load', trace: { policy: input.trace ?? 'retain-on-failure', retained: false, path: null } },
      error: { code: 'adapter_runtime_error', message, hint: 'adapter failed to load' },
    });
  }
}

// ── CLI entry (invoked from main.ts fast-path) ──────────────────────────────

function parseArgs(argv: string[]): { requestId?: string; name?: string; input?: string; protocolFd?: number; maxRuntimeMs?: number } {
  const out: { requestId?: string; name?: string; input?: string; protocolFd?: number; maxRuntimeMs?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--request-id') out.requestId = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--input') out.input = argv[++i];
    else if (a === '--protocol-fd') { const n = Number(argv[++i]); if (Number.isInteger(n) && n > 0) out.protocolFd = n; }
    else if (a === '--max-runtime-ms') { const n = Number(argv[++i]); if (Number.isInteger(n) && n > 0) out.maxRuntimeMs = n; }
    // --jsonl is the only supported transport; ignore the flag.
  }
  return out;
}

/**
 * Entry point for `bycli internal verify-runner --jsonl --request-id … --name … --input …`.
 * Writes JSONL events to the dedicated protocol fd (`--protocol-fd`, set by the parent RunnerPort
 * so the adapter's stdout/stderr cannot pollute or forge the protocol — Codex #3); without the flag
 * (standalone debugging) it falls back to stdout. Sets a non-zero exit code on a failed run.
 */
export async function runVerifyRunnerCli(argv: string[]): Promise<void> {
  const { requestId, name, input, protocolFd, maxRuntimeMs } = parseArgs(argv);
  // Signal + orphan-watchdog backstops (#4, #7): release the browser lease on SIGTERM/cancel, and
  // self-terminate if orphaned. Installed before any adapter runs so it covers the whole lifetime.
  installRunnerBackstops(maxRuntimeMs ?? 0);
  // fs.writeSync is synchronous → preserves JSONL line ordering and applies backpressure naturally.
  const emit = (event: RunnerEvent): void => {
    const line = JSON.stringify(event) + '\n';
    if (protocolFd !== undefined) fs.writeSync(protocolFd, line);
    else process.stdout.write(line);
  };

  if (!requestId || !name || !input) {
    // Cannot form a valid started/result without these; report on stderr and fail closed.
    process.stderr.write('verify-runner: missing --request-id/--name/--input\n');
    process.exitCode = 1;
    return;
  }

  let parsed: RunnerInput;
  try {
    parsed = JSON.parse(fs.readFileSync(input, 'utf-8')) as RunnerInput;
  } catch (e) {
    emit({ type: 'result', requestId, ok: false, data: { stage: 'load' }, error: { code: 'runner_protocol_error', message: `cannot read input.json: ${e instanceof Error ? e.message : String(e)}` } });
    process.exitCode = 1;
    return;
  }

  // Defense: the input.json requestId/name must match the argv (no cross-wired runs).
  if (parsed.requestId !== requestId || parsed.name !== name) {
    emit({ type: 'result', requestId, ok: false, data: { stage: 'load' }, error: { code: 'runner_protocol_error', message: 'input.json requestId/name mismatch' } });
    process.exitCode = 1;
    return;
  }

  let failed = false;
  await runVerifyRunner(parsed, (event) => {
    if (event.type === 'result' && !event.ok) failed = true;
    emit(event);
  });
  if (failed) process.exitCode = 1;
}
