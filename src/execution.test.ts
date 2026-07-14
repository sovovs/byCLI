import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CliCommand, InternalCliCommand } from './registry.js';
import {
  _getLazyModuleFingerprintReadCountForTests,
  _resetLazyModuleStateForTests,
  executeCommand,
  prepareCommandArgs,
} from './execution.js';
import { ArgumentError, CliError, TimeoutError, toEnvelope } from './errors.js';
import { cli, getRegistry, registerCommand, Strategy } from './registry.js';
import { withTimeoutMs } from './runtime.js';
import * as runtime from './runtime.js';
import * as capRouting from './capabilityRouting.js';
import { clearAllHooks, onAfterExecute, onBeforeExecute, type HookContext } from './hooks.js';
import { registryMutationKeys } from './registry-transaction.js';

describe('executeCommand — conditional browser routing', () => {
  it('keeps ordinary static manifest commands on the lazy run path', async () => {
    _resetLazyModuleStateForTests();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-static-lazy-'));
    const site = `static-lazy-${Date.now()}`;
    const key = `${site}/status`;
    const modulePath = path.join(root, 'status.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    const funcTracker = vi.fn(async () => []);
    (globalThis as any).__staticLazyFunc = funcTracker;
    fs.writeFileSync(modulePath, `
import { cli, Strategy } from ${JSON.stringify(registryUrl)};
cli({
  site: ${JSON.stringify(site)}, name: 'status', access: 'read',
  strategy: Strategy.PUBLIC, browser: false,
  func: async (args, debug) => globalThis.__staticLazyFunc(args, debug),
});
`);
    const placeholder: InternalCliCommand = {
      site, name: 'status', access: 'read', description: '', args: [],
      browser: false, _lazy: true, _modulePath: modulePath,
    };
    registerCommand(placeholder);
    const browserSessionSpy = vi.spyOn(runtime, 'browserSession');

    try {
      await executeCommand(placeholder, {});
      await executeCommand(placeholder, {});
      expect(funcTracker).toHaveBeenCalledWith({}, false);
      expect(funcTracker).toHaveBeenCalledTimes(2);
      expect(_getLazyModuleFingerprintReadCountForTests()).toBe(0);
      expect(browserSessionSpy).not.toHaveBeenCalled();
    } finally {
      getRegistry().delete(key);
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__staticLazyFunc;
      vi.restoreAllMocks();
    }
  });

  it('cache-busts a changed successful user adapter and caches the new generation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-user-lazy-reload-'));
    const previousConfigDir = process.env.BYCLI_CONFIG_DIR;
    process.env.BYCLI_CONFIG_DIR = root;
    const site = `static-reload-${Date.now()}`;
    const key = `${site}/status`;
    const moduleDir = path.join(root, 'clis', site);
    const modulePath = path.join(moduleDir, 'status.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    fs.mkdirSync(moduleDir, { recursive: true });
    Object.assign(globalThis, { __reloadImports: 0, __reloadResults: [] });
    const writeVersion = (version: number) => fs.writeFileSync(modulePath, `
import { cli, Strategy } from ${JSON.stringify(registryUrl)};
globalThis.__reloadImports += 1;
cli({
  site: ${JSON.stringify(site)}, name: 'status', access: 'read',
  strategy: Strategy.PUBLIC, browser: false,
  func: async () => { globalThis.__reloadResults.push(${version}); return ${version}; },
});
`);
    writeVersion(1);
    const placeholder: InternalCliCommand = {
      site, name: 'status', access: 'read', description: '', args: [],
      browser: false, _lazy: true, _modulePath: modulePath,
    };
    registerCommand(placeholder);

    try {
      await expect(executeCommand(placeholder, {})).resolves.toBe(1);
      const originalStat = fs.statSync(modulePath);
      writeVersion(2);
      expect(fs.statSync(modulePath).size).toBe(originalStat.size);
      fs.utimesSync(modulePath, originalStat.atime, originalStat.mtime);
      await expect(Promise.all([
        executeCommand(placeholder, {}),
        executeCommand(placeholder, {}),
      ])).resolves.toEqual([2, 2]);
      await expect(executeCommand(placeholder, {})).resolves.toBe(2);
      expect((globalThis as any).__reloadImports).toBe(2);
      expect((globalThis as any).__reloadResults).toEqual([1, 2, 2, 2]);
    } finally {
      getRegistry().delete(key);
      fs.rmSync(root, { recursive: true, force: true });
      if (previousConfigDir === undefined) delete process.env.BYCLI_CONFIG_DIR;
      else process.env.BYCLI_CONFIG_DIR = previousConfigDir;
      delete (globalThis as any).__reloadImports;
      delete (globalThis as any).__reloadResults;
    }
  });

  it('does not let a stale rejected import delete a newer successful generation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-user-stale-import-'));
    const previousConfigDir = process.env.BYCLI_CONFIG_DIR;
    process.env.BYCLI_CONFIG_DIR = root;
    const site = `stale-import-${Date.now()}`;
    const key = `${site}/status`;
    const moduleDir = path.join(root, 'clis', site);
    const modulePath = path.join(moduleDir, 'status.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    fs.mkdirSync(moduleDir, { recursive: true });
    let markOldStarted!: () => void;
    const oldStarted = new Promise<void>(resolve => { markOldStarted = resolve; });
    let rejectOld!: (reason: Error) => void;
    const oldGate = new Promise<never>((_resolve, reject) => { rejectOld = reject; });
    Object.assign(globalThis, { __oldImportStarted: markOldStarted, __oldImportGate: oldGate, __newImportCount: 0 });
    fs.writeFileSync(modulePath, `
globalThis.__oldImportStarted();
await globalThis.__oldImportGate;
`);
    const placeholder: InternalCliCommand = {
      site, name: 'status', access: 'read', description: '', args: [],
      browser: false, _lazy: true, _modulePath: modulePath,
    };
    registerCommand(placeholder);

    try {
      const staleExecution = executeCommand(placeholder, {});
      await oldStarted;
      fs.writeFileSync(modulePath, `
import { cli, Strategy } from ${JSON.stringify(registryUrl)};
globalThis.__newImportCount += 1;
cli({
  site: ${JSON.stringify(site)}, name: 'status', access: 'read',
  strategy: Strategy.PUBLIC, browser: false, func: async () => 'fresh',
});
`);
      const future = new Date(Date.now() + 2_000);
      fs.utimesSync(modulePath, future, future);

      const freshExecution = executeCommand(placeholder, {});
      await new Promise(resolve => setTimeout(resolve, 25));
      expect((globalThis as any).__newImportCount).toBe(0);
      rejectOld(new Error('stale import failed'));
      await expect(staleExecution).rejects.toMatchObject({ code: 'ADAPTER_LOAD' });
      await expect(freshExecution).resolves.toBe('fresh');
      await expect(executeCommand(placeholder, {})).resolves.toBe('fresh');
      expect((globalThis as any).__newImportCount).toBe(1);
    } finally {
      getRegistry().delete(key);
      fs.rmSync(root, { recursive: true, force: true });
      if (previousConfigDir === undefined) delete process.env.BYCLI_CONFIG_DIR;
      else process.env.BYCLI_CONFIG_DIR = previousConfigDir;
      delete (globalThis as any).__oldImportStarted;
      delete (globalThis as any).__oldImportGate;
      delete (globalThis as any).__newImportCount;
    }
  });

  it('serializes import generations so a stale successful registration cannot overwrite fresh state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-user-stale-success-'));
    const previousConfigDir = process.env.BYCLI_CONFIG_DIR;
    process.env.BYCLI_CONFIG_DIR = root;
    const site = `stale-success-${Date.now()}`;
    const key = `${site}/status`;
    const moduleDir = path.join(root, 'clis', site);
    const modulePath = path.join(moduleDir, 'status.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    fs.mkdirSync(moduleDir, { recursive: true });
    let markOldStarted!: () => void;
    const oldStarted = new Promise<void>(resolve => { markOldStarted = resolve; });
    let releaseOld!: () => void;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    let markFreshStarted!: () => void;
    const freshStarted = new Promise<void>(resolve => { markFreshStarted = resolve; });
    const sentinelPredicate = vi.fn(() => { throw new Error('placeholder predicate ran'); });
    Object.assign(globalThis, {
      __staleSuccessStarted: markOldStarted,
      __staleSuccessGate: oldGate,
      __registrationOrder: [],
      __freshSuccessImports: 0,
      __freshSuccessStarted: markFreshStarted,
    });
    fs.writeFileSync(modulePath, `
import { cli } from ${JSON.stringify(registryUrl)};
globalThis.__staleSuccessStarted();
await globalThis.__staleSuccessGate;
globalThis.__registrationOrder.push('stale');
cli({
  site: ${JSON.stringify(site)}, name: 'status', access: 'read',
  browser: () => false, func: async () => 'stale',
});
`);
    const placeholder: InternalCliCommand = {
      site, name: 'status', access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: sentinelPredicate,
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);

    try {
      const staleExecution = executeCommand(placeholder, {});
      await oldStarted;
      fs.writeFileSync(modulePath, `
import { cli } from ${JSON.stringify(registryUrl)};
globalThis.__freshSuccessStarted();
globalThis.__freshSuccessImports += 1;
globalThis.__registrationOrder.push('fresh');
cli({
  site: ${JSON.stringify(site)}, name: 'status', access: 'read',
  browser: () => false, func: async () => 'fresh',
});
`);
      const future = new Date(Date.now() + 2_000);
      fs.utimesSync(modulePath, future, future);
      const freshExecution = executeCommand(placeholder, {});

      const stateBeforeRelease = await Promise.race([
        freshStarted.then(() => 'started'),
        new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 100)),
      ]);
      expect(stateBeforeRelease).toBe('blocked');
      expect((globalThis as any).__freshSuccessImports).toBe(0);
      releaseOld();
      await expect(Promise.all([staleExecution, freshExecution])).resolves.toEqual(['stale', 'fresh']);
      expect((globalThis as any).__registrationOrder).toEqual(['stale', 'fresh']);
      expect((globalThis as any).__freshSuccessImports).toBe(1);
      expect(getRegistry().get(key)?.browser).toBe('conditional');
      await expect(executeCommand(placeholder, {})).resolves.toBe('fresh');
      expect((globalThis as any).__freshSuccessImports).toBe(1);
      expect(sentinelPredicate).not.toHaveBeenCalled();
    } finally {
      releaseOld();
      getRegistry().delete(key);
      fs.rmSync(root, { recursive: true, force: true });
      if (previousConfigDir === undefined) delete process.env.BYCLI_CONFIG_DIR;
      else process.env.BYCLI_CONFIG_DIR = previousConfigDir;
      delete (globalThis as any).__staleSuccessStarted;
      delete (globalThis as any).__staleSuccessGate;
      delete (globalThis as any).__registrationOrder;
      delete (globalThis as any).__freshSuccessImports;
      delete (globalThis as any).__freshSuccessStarted;
    }
  });

  it('serializes competing registrations from different lazy modules', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-cross-module-imports-'));
    const site = `cross-module-${Date.now()}`;
    const key = `${site}/status`;
    const firstPath = path.join(root, 'first.mjs');
    const secondPath = path.join(root, 'second.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>(resolve => { markSecondStarted = resolve; });
    const firstSentinel = vi.fn(() => { throw new Error('first sentinel ran'); });
    const secondSentinel = vi.fn(() => { throw new Error('second sentinel ran'); });
    Object.assign(globalThis, {
      __crossFirstStarted: markFirstStarted,
      __crossFirstGate: firstGate,
      __crossSecondStarted: markSecondStarted,
      __crossRegistrationOrder: [],
    });
    fs.writeFileSync(firstPath, `
import { cli } from ${JSON.stringify(registryUrl)};
globalThis.__crossFirstStarted();
await globalThis.__crossFirstGate;
globalThis.__crossRegistrationOrder.push('first');
cli({ site: ${JSON.stringify(site)}, name: 'status', access: 'read', browser: () => false, func: async () => 'first' });
`);
    fs.writeFileSync(secondPath, `
import { cli } from ${JSON.stringify(registryUrl)};
globalThis.__crossSecondStarted();
globalThis.__crossRegistrationOrder.push('second');
cli({ site: ${JSON.stringify(site)}, name: 'status', access: 'read', browser: () => false, func: async () => 'second' });
`);
    const first: InternalCliCommand = {
      site, name: 'status', access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: firstSentinel,
      _lazy: true, _modulePath: firstPath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(first);

    try {
      const firstExecution = executeCommand(first, {});
      await firstStarted;
      const second: InternalCliCommand = {
        site, name: 'status', access: 'read', description: '', args: [],
        browser: 'conditional', requiresBrowser: secondSentinel,
        _lazy: true, _modulePath: secondPath, _hydrateBeforeBrowserRouting: true,
      };
      registerCommand(second);
      const secondExecution = executeCommand(second, {});
      const stateBeforeRelease = await Promise.race([
        secondStarted.then(() => 'started'),
        new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 100)),
      ]);
      expect(stateBeforeRelease).toBe('blocked');
      releaseFirst();
      await expect(Promise.all([firstExecution, secondExecution])).resolves.toEqual(['first', 'second']);
      expect((globalThis as any).__crossRegistrationOrder).toEqual(['first', 'second']);
      expect(getRegistry().get(key)?.func).toBeDefined();
      expect(firstSentinel).not.toHaveBeenCalled();
      expect(secondSentinel).not.toHaveBeenCalled();
    } finally {
      releaseFirst();
      getRegistry().delete(key);
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__crossFirstStarted;
      delete (globalThis as any).__crossFirstGate;
      delete (globalThis as any).__crossSecondStarted;
      delete (globalThis as any).__crossRegistrationOrder;
    }
  });

  it('isolates malformed rollback from an overlapping failing module transaction', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-overlap-rollback-'));
    const firstSite = `overlap-first-${Date.now()}`;
    const secondSite = `overlap-second-${Date.now()}`;
    const firstPath = path.join(root, 'first.mjs');
    const secondPath = path.join(root, 'second.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>(resolve => { markSecondStarted = resolve; });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    Object.assign(globalThis, { __overlapSecondStarted: markSecondStarted, __overlapSecondGate: secondGate });
    fs.writeFileSync(firstPath, `
import { cli, Strategy } from ${JSON.stringify(registryUrl)};
cli({ site: ${JSON.stringify(firstSite)}, name: 'list', aliases: ['bad-first'], access: 'read', strategy: Strategy.PUBLIC, browser: false, func: async () => 'bad' });
`);
    fs.writeFileSync(secondPath, `
import { cli } from ${JSON.stringify(registryUrl)};
globalThis.__overlapSecondStarted();
await globalThis.__overlapSecondGate;
cli({ site: ${JSON.stringify(secondSite)}, name: 'list', aliases: ['bad-second'], access: 'read', browser: () => false, func: async () => 'bad' });
throw new Error('second import failure');
`);
    const first: InternalCliCommand = {
      site: firstSite, name: 'list', aliases: ['prior-first'], access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: () => false,
      _lazy: true, _modulePath: firstPath, _hydrateBeforeBrowserRouting: true,
    };
    const second: InternalCliCommand = {
      site: secondSite, name: 'list', aliases: ['prior-second'], access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: () => false,
      _lazy: true, _modulePath: secondPath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(first);
    registerCommand(second);

    try {
      const firstExecution = executeCommand(first, {}).catch(error => error);
      const secondExecution = executeCommand(second, {}).catch(error => error);
      await secondStarted;
      await expect(firstExecution).resolves.toMatchObject({ code: 'COMMAND_EXEC' });
      expect(getRegistry().get(`${firstSite}/list`)).toBe(first);
      expect(getRegistry().get(`${firstSite}/prior-first`)).toBe(first);
      expect(getRegistry().get(`${firstSite}/bad-first`)).toBeUndefined();

      releaseSecond();
      await expect(secondExecution).resolves.toMatchObject({ code: 'ADAPTER_LOAD' });
      expect(getRegistry().get(`${secondSite}/list`)).toBe(second);
      expect(getRegistry().get(`${secondSite}/prior-second`)).toBe(second);
      expect(getRegistry().get(`${secondSite}/bad-second`)).toBeUndefined();

      fs.writeFileSync(secondPath, `
import { cli } from ${JSON.stringify(registryUrl)};
cli({ site: ${JSON.stringify(secondSite)}, name: 'list', aliases: ['fresh-second'], access: 'read', browser: () => false, func: async () => 'fresh' });
`);
      await expect(executeCommand(second, {})).resolves.toBe('fresh');
      expect(getRegistry().get(`${secondSite}/fresh-second`)).toBe(getRegistry().get(`${secondSite}/list`));
    } finally {
      releaseSecond();
      for (const [site, names] of [
        [firstSite, ['list', 'prior-first', 'bad-first']],
        [secondSite, ['list', 'prior-second', 'bad-second', 'fresh-second']],
      ] as const) {
        for (const name of names) getRegistry().delete(`${site}/${name}`);
      }
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__overlapSecondStarted;
      delete (globalThis as any).__overlapSecondGate;
    }
  });

  it('hydrates a conditional manifest placeholder before routing and validates once with its matching schema', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-conditional-hydrate-'));
    const site = `conditional-hydrate-${Date.now()}`;
    const key = `${site}/list`;
    const modulePath = path.join(root, 'list.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    const sentinelPredicate = vi.fn(() => { throw new Error('placeholder predicate ran'); });
    const resolverTracker = vi.fn((args: Record<string, unknown>) => args['auth-source'] !== 'env');
    const funcTracker = vi.fn(async () => []);
    const validationTracker = vi.fn();
    Object.assign(globalThis, { __hydrateResolver: resolverTracker, __hydrateFunc: funcTracker, __hydrateValidate: validationTracker });
    fs.writeFileSync(modulePath, `
import { cli } from ${JSON.stringify(registryUrl)};
cli({
  site: ${JSON.stringify(site)}, name: 'list', access: 'read',
  browser: args => globalThis.__hydrateResolver(args),
  args: [
    { name: 'auth-source', default: 'env', choices: ['browser', 'env'] },
    { name: 'limit', type: 'int', default: 10 },
    { name: 'config', default: [{ value: 1 }, { value: 1 }] },
  ],
  validateArgs: args => globalThis.__hydrateValidate(args),
  func: async (page, args, debug) => globalThis.__hydrateFunc(page, args, debug),
});
`);
    const placeholder: InternalCliCommand = {
      site, name: 'list', access: 'read', description: '',
      browser: 'conditional', requiresBrowser: sentinelPredicate,
      args: [
        { name: 'auth-source', default: 'env', choices: ['browser', 'env'] },
        { name: 'limit', type: 'int', default: 10 },
        { name: 'config', default: [{ value: 1 }, { value: 1 }] },
      ],
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);
    const browserSessionSpy = vi.spyOn(runtime, 'browserSession');

    try {
      await executeCommand(placeholder, { limit: '3' });

      expect(browserSessionSpy).not.toHaveBeenCalled();
      expect(resolverTracker).toHaveBeenCalledWith(expect.objectContaining({
        'auth-source': 'env', limit: 3, config: [{ value: 1 }, { value: 1 }],
      }));
      expect(funcTracker).toHaveBeenCalledWith(null, expect.objectContaining({
        'auth-source': 'env', limit: 3, config: [{ value: 1 }, { value: 1 }],
      }), false);
      expect(validationTracker).toHaveBeenCalledTimes(1);
      expect(sentinelPredicate).not.toHaveBeenCalled();
    } finally {
      getRegistry().delete(key);
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__hydrateResolver;
      delete (globalThis as any).__hydrateFunc;
      delete (globalThis as any).__hydrateValidate;
      vi.restoreAllMocks();
    }
  });

  it('preserves typed adapter-load failures for conditional hydration like static lazy loading', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-conditional-import-error-'));
    const conditionalSite = `conditional-import-error-${Date.now()}`;
    const staticSite = `${conditionalSite}-static`;
    const conditionalPath = path.join(root, 'conditional.mjs');
    const staticPath = path.join(root, 'static.mjs');
    fs.writeFileSync(conditionalPath, 'this is not valid javascript !!!');
    fs.writeFileSync(staticPath, 'this is not valid javascript !!!');
    const sentinelPredicate = vi.fn(() => { throw new Error('placeholder predicate ran'); });
    const conditional: InternalCliCommand = {
      site: conditionalSite, name: 'list', access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: sentinelPredicate,
      _lazy: true, _modulePath: conditionalPath, _hydrateBeforeBrowserRouting: true,
    };
    const staticCommand: InternalCliCommand = {
      site: staticSite, name: 'list', access: 'read', description: '', args: [],
      browser: false, _lazy: true, _modulePath: staticPath,
    };
    registerCommand(conditional);
    registerCommand(staticCommand);

    try {
      const conditionalError = await executeCommand(conditional, {}).catch(error => error);
      const staticError = await executeCommand(staticCommand, {}).catch(error => error);
      if (!(staticError instanceof CliError)) throw new Error('expected typed static adapter load error');
      expect(conditionalError).toMatchObject({
        code: 'ADAPTER_LOAD', exitCode: 69,
        hint: 'Check that the adapter file exists and has no syntax errors.',
      });
      expect(conditionalError).toMatchObject({
        code: staticError.code, exitCode: staticError.exitCode, hint: staticError.hint,
      });
      expect(sentinelPredicate).not.toHaveBeenCalled();

      const retryFunc = vi.fn(async () => []);
      const registryUrl = new URL('./registry.ts', import.meta.url).href;
      (globalThis as any).__syntaxRetryFunc = retryFunc;
      fs.writeFileSync(conditionalPath, `
import { cli } from ${JSON.stringify(registryUrl)};
cli({
  site: ${JSON.stringify(conditionalSite)}, name: 'list', access: 'read',
  browser: () => false,
  func: async (page, args, debug) => globalThis.__syntaxRetryFunc(page, args, debug),
});
`);
      await expect(executeCommand(conditional, {})).resolves.toEqual([]);
      expect(retryFunc).toHaveBeenCalledOnce();
      expect(sentinelPredicate).not.toHaveBeenCalled();
    } finally {
      getRegistry().delete(`${conditionalSite}/list`);
      getRegistry().delete(`${staticSite}/list`);
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__syntaxRetryFunc;
    }
  });

  it('rolls back registry and aliases when a module registers and then throws', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-register-then-throw-'));
    const site = `register-then-throw-${Date.now()}`;
    const key = `${site}/list`;
    const modulePath = path.join(root, 'list.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    const sentinelPredicate = vi.fn(() => { throw new Error('placeholder predicate ran'); });
    fs.writeFileSync(modulePath, `
import { cli } from ${JSON.stringify(registryUrl)};
cli({
  site: ${JSON.stringify(site)}, name: 'list', aliases: ['bad-alias'], access: 'read',
  browser: () => false, func: async () => 'bad',
});
throw new Error('top-level failure after registration');
`);
    const placeholder: InternalCliCommand = {
      site, name: 'list', aliases: ['old-alias'], access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: sentinelPredicate,
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);

    try {
      await expect(executeCommand(placeholder, {})).rejects.toMatchObject({
        code: 'ADAPTER_LOAD', exitCode: 69,
      });
      expect(getRegistry().get(key)).toBe(placeholder);
      expect(getRegistry().get(`${site}/old-alias`)).toBe(placeholder);
      expect(getRegistry().get(`${site}/bad-alias`)).toBeUndefined();
      expect(sentinelPredicate).not.toHaveBeenCalled();

      fs.writeFileSync(modulePath, `
import { cli } from ${JSON.stringify(registryUrl)};
cli({
  site: ${JSON.stringify(site)}, name: 'list', aliases: ['fresh-alias'], access: 'read',
  browser: () => false, func: async () => 'fresh',
});
`);
      await expect(executeCommand(placeholder, {})).resolves.toBe('fresh');
      const fresh = getRegistry().get(key);
      expect(fresh).not.toBe(placeholder);
      expect(getRegistry().get(`${site}/fresh-alias`)).toBe(fresh);
      expect(getRegistry().get(`${site}/old-alias`)).toBeUndefined();
    } finally {
      getRegistry().delete(key);
      getRegistry().delete(`${site}/old-alias`);
      getRegistry().delete(`${site}/bad-alias`);
      getRegistry().delete(`${site}/fresh-alias`);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not attribute an ordinary external registration to a paused failing import', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-external-during-import-'));
    const site = `external-during-import-${Date.now()}`;
    const key = `${site}/list`;
    const modulePath = path.join(root, 'list.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let releaseImport!: () => void;
    const gate = new Promise<void>(resolve => { releaseImport = resolve; });
    Object.assign(globalThis, { __externalImportStarted: markStarted, __externalImportGate: gate });
    fs.writeFileSync(modulePath, `
import { cli } from ${JSON.stringify(registryUrl)};
globalThis.__externalImportStarted();
await globalThis.__externalImportGate;
cli({ site: ${JSON.stringify(site)}, name: 'list', aliases: ['bad-alias'], access: 'read', browser: () => false, func: async () => 'bad' });
throw new Error('fail after paused registration');
`);
    const sentinel = vi.fn(() => { throw new Error('sentinel ran'); });
    const placeholder: InternalCliCommand = {
      site, name: 'list', aliases: ['old-alias'], access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: sentinel,
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);

    try {
      const failingExecution = executeCommand(placeholder, {});
      await started;
      const ordinary = cli({
        site, name: 'ordinary', access: 'read', browser: false, func: async () => 'ordinary',
      });
      releaseImport();
      await expect(failingExecution).rejects.toMatchObject({ code: 'ADAPTER_LOAD' });
      expect(getRegistry().get(`${site}/ordinary`)).toBe(ordinary);
      await expect(executeCommand(ordinary, {})).resolves.toBe('ordinary');
      expect(getRegistry().get(key)).toBe(placeholder);
      expect(getRegistry().get(`${site}/bad-alias`)).toBeUndefined();
    } finally {
      releaseImport();
      for (const name of ['list', 'old-alias', 'bad-alias', 'ordinary']) getRegistry().delete(`${site}/${name}`);
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__externalImportStarted;
      delete (globalThis as any).__externalImportGate;
    }
  });

  it('rolls back each still-owned key when one alias is externally replaced before import failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-partial-alias-takeover-'));
    const site = `partial-alias-takeover-${Date.now()}`;
    const modulePath = path.join(root, 'list.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    let markRegistered!: () => void;
    const registered = new Promise<void>(resolve => { markRegistered = resolve; });
    let releaseImport!: () => void;
    const gate = new Promise<void>(resolve => { releaseImport = resolve; });
    Object.assign(globalThis, {
      __partialAliasRegistered: markRegistered,
      __partialAliasGate: gate,
    });
    fs.writeFileSync(modulePath, `
import { cli } from ${JSON.stringify(registryUrl)};
cli({
  site: ${JSON.stringify(site)}, name: 'list', aliases: ['claimed-alias', 'other-alias'],
  access: 'read', browser: () => false, func: async () => 'failed import',
});
globalThis.__partialAliasRegistered();
await globalThis.__partialAliasGate;
throw new Error('fail after external alias takeover');
`);
    const placeholder: InternalCliCommand = {
      site, name: 'list', aliases: ['old-alias'], access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: () => false,
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);

    try {
      const failingExecution = executeCommand(placeholder, {});
      await registered;
      const externalAlias = cli({
        site, name: 'claimed-alias', access: 'read', browser: false,
        func: async () => 'external alias',
      });
      releaseImport();
      await expect(failingExecution).rejects.toMatchObject({ code: 'ADAPTER_LOAD' });

      expect(getRegistry().get(`${site}/claimed-alias`)).toBe(externalAlias);
      expect(getRegistry().get(`${site}/list`)).toBe(placeholder);
      expect(getRegistry().get(`${site}/old-alias`)).toBe(placeholder);
      expect(getRegistry().get(`${site}/other-alias`)).toBeUndefined();
    } finally {
      releaseImport();
      for (const name of ['list', 'old-alias', 'claimed-alias', 'other-alias']) {
        getRegistry().delete(`${site}/${name}`);
      }
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__partialAliasRegistered;
      delete (globalThis as any).__partialAliasGate;
    }
  });

  it('rejects late timed-out module register and direct Map writes without touching external commands', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-timeout-late-write-'));
    const site = `timeout-late-write-${Date.now()}`;
    const modulePath = path.join(root, 'list.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    const previousTimeout = process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS;
    process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS = '25';
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let releaseImport!: () => void;
    const gate = new Promise<void>(resolve => { releaseImport = resolve; });
    let markLateDone!: () => void;
    const lateDone = new Promise<void>(resolve => { markLateDone = resolve; });
    (globalThis as any).__lateNeverSettles = new Promise(() => {});
    Object.assign(globalThis, {
      __lateImportStarted: markStarted, __lateImportGate: gate, __lateImportDone: markLateDone,
    });
    fs.writeFileSync(modulePath, `
import { cli, getRegistry } from ${JSON.stringify(registryUrl)};
globalThis.__lateImportStarted();
await globalThis.__lateImportGate;
try {
  cli({ site: ${JSON.stringify(site)}, name: 'list', aliases: ['late-alias'], access: 'read', browser: () => false, func: async () => 'late' });
} catch (error) {
  globalThis.__lateRegistrationError = error.message;
}
globalThis.__lateMapMutationErrors = [];
for (const operation of [
  () => getRegistry().set(${JSON.stringify(`${site}/direct-late`)}, { site: ${JSON.stringify(site)}, name: 'direct-late' }),
  () => getRegistry().delete(${JSON.stringify(`${site}/list`)}),
  () => getRegistry().clear(),
]) {
  try {
    operation();
  } catch (error) {
    globalThis.__lateMapMutationErrors.push(error.message);
  }
}
globalThis.__lateImportDone();
await globalThis.__lateNeverSettles;
`);
    const sentinel = vi.fn(() => { throw new Error('sentinel ran'); });
    const placeholder: InternalCliCommand = {
      site, name: 'list', access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: sentinel,
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);

    try {
      const timedOut = executeCommand(placeholder, {});
      await started;
      await expect(timedOut).rejects.toMatchObject({ code: 'ADAPTER_LOAD' });
      const ordinary = cli({
        site, name: 'ordinary-late', access: 'read', browser: false, func: async () => 'ordinary',
      });
      releaseImport();
      await lateDone;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(getRegistry().get(`${site}/ordinary-late`)).toBe(ordinary);
      expect(getRegistry().get(`${site}/list`)).toBe(placeholder);
      expect(getRegistry().get(`${site}/late-alias`)).toBeUndefined();
      expect(getRegistry().get(`${site}/direct-late`)).toBeUndefined();
      expect((globalThis as any).__lateRegistrationError).toMatch(/transaction.*closed/i);
      expect((globalThis as any).__lateMapMutationErrors).toHaveLength(3);
      for (const error of (globalThis as any).__lateMapMutationErrors) {
        expect(error).toMatch(/transaction.*closed/i);
      }
    } finally {
      releaseImport();
      _resetLazyModuleStateForTests();
      for (const name of ['list', 'late-alias', 'direct-late', 'ordinary-late']) getRegistry().delete(`${site}/${name}`);
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__lateImportStarted;
      delete (globalThis as any).__lateImportGate;
      delete (globalThis as any).__lateImportDone;
      delete (globalThis as any).__lateNeverSettles;
      delete (globalThis as any).__lateRegistrationError;
      delete (globalThis as any).__lateMapMutationErrors;
      if (previousTimeout === undefined) delete process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS;
      else process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS = previousTimeout;
    }
  });

  it('rolls back writes made before a registration import times out', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-timeout-prior-write-'));
    const site = `timeout-prior-write-${Date.now()}`;
    const modulePath = path.join(root, 'list.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    const previousTimeout = process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS;
    process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS = '25';
    (globalThis as any).__timeoutPriorNever = new Promise(() => {});
    fs.writeFileSync(modulePath, `
import { cli } from ${JSON.stringify(registryUrl)};
cli({ site: ${JSON.stringify(site)}, name: 'list', aliases: ['timed-alias'], access: 'read', browser: () => false, func: async () => 'timed' });
await globalThis.__timeoutPriorNever;
`);
    const placeholder: InternalCliCommand = {
      site, name: 'list', aliases: ['prior-alias'], access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: () => false,
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);
    try {
      await expect(executeCommand(placeholder, {})).rejects.toMatchObject({ code: 'ADAPTER_LOAD' });
      expect(getRegistry().get(`${site}/list`)).toBe(placeholder);
      expect(getRegistry().get(`${site}/prior-alias`)).toBe(placeholder);
      expect(getRegistry().get(`${site}/timed-alias`)).toBeUndefined();
    } finally {
      _resetLazyModuleStateForTests();
      for (const name of ['list', 'prior-alias', 'timed-alias']) getRegistry().delete(`${site}/${name}`);
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__timeoutPriorNever;
      if (previousTimeout === undefined) delete process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS;
      else process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS = previousTimeout;
    }
  });

  it('rejects registration work scheduled after an import transaction closes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-delayed-registration-'));
    const site = `delayed-registration-${Date.now()}`;
    const key = `${site}/list`;
    const modulePath = path.join(root, 'list.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    let markDelayed!: () => void;
    const delayed = new Promise<void>(resolve => { markDelayed = resolve; });
    Object.assign(globalThis, { __delayedRegistrationDone: markDelayed, __delayedRegistrationError: undefined });
    fs.writeFileSync(modulePath, `
import { cli } from ${JSON.stringify(registryUrl)};
cli({ site: ${JSON.stringify(site)}, name: 'list', access: 'read', browser: () => false, func: async () => 'main' });
setTimeout(() => {
  try {
    cli({ site: ${JSON.stringify(site)}, name: 'delayed', access: 'read', browser: false, func: async () => 'delayed' });
  } catch (error) {
    globalThis.__delayedRegistrationError = error.message;
  } finally {
    globalThis.__delayedRegistrationDone();
  }
}, 0);
`);
    const placeholder: InternalCliCommand = {
      site, name: 'list', access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: () => false,
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);

    try {
      await expect(executeCommand(placeholder, {})).resolves.toBe('main');
      await delayed;
      expect(getRegistry().get(`${site}/delayed`)).toBeUndefined();
      expect((globalThis as any).__delayedRegistrationError).toMatch(/transaction.*closed/i);
    } finally {
      getRegistry().delete(key);
      getRegistry().delete(`${site}/delayed`);
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__delayedRegistrationDone;
      delete (globalThis as any).__delayedRegistrationError;
    }
  });

  it('rejects a conditional hydration module that does not replace its placeholder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-conditional-malformed-'));
    const site = `conditional-malformed-${Date.now()}`;
    const key = `${site}/list`;
    const modulePath = path.join(root, 'list.mjs');
    fs.writeFileSync(modulePath, 'export const unrelated = true;\n');
    const sentinelPredicate = vi.fn(() => { throw new Error('placeholder predicate ran'); });
    const placeholder: InternalCliCommand = {
      site, name: 'list', access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: sentinelPredicate,
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);
    const browserSessionSpy = vi.spyOn(runtime, 'browserSession');

    try {
      await expect(executeCommand(placeholder, {})).rejects.toMatchObject({
        code: 'COMMAND_EXEC',
        message: expect.stringContaining(key),
      });
      expect(sentinelPredicate).not.toHaveBeenCalled();
      expect(browserSessionSpy).not.toHaveBeenCalled();
      expect(getRegistry().get(key)).toBe(placeholder);
    } finally {
      getRegistry().delete(key);
      fs.rmSync(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });

  it('shares concurrent conditional hydration without evaluating the sentinel', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-conditional-concurrent-'));
    const site = `conditional-concurrent-${Date.now()}`;
    const key = `${site}/list`;
    const modulePath = path.join(root, 'list.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    const sentinelPredicate = vi.fn(() => { throw new Error('placeholder predicate ran'); });
    const funcTracker = vi.fn(async () => []);
    Object.assign(globalThis, { __hydrateImportCount: 0, __concurrentHydrateFunc: funcTracker });
    fs.writeFileSync(modulePath, `
import { cli } from ${JSON.stringify(registryUrl)};
globalThis.__hydrateImportCount += 1;
cli({
  site: ${JSON.stringify(site)}, name: 'list', access: 'read',
  browser: args => args['auth-source'] !== 'env',
  args: [{ name: 'auth-source', default: 'env' }],
  func: async (page, args, debug) => globalThis.__concurrentHydrateFunc(page, args, debug),
});
`);
    const placeholder: InternalCliCommand = {
      site, name: 'list', access: 'read', description: '',
      browser: 'conditional', requiresBrowser: sentinelPredicate,
      args: [{ name: 'auth-source', default: 'env' }],
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);
    const browserSessionSpy = vi.spyOn(runtime, 'browserSession');

    try {
      await Promise.all([
        executeCommand(placeholder, {}),
        executeCommand(placeholder, {}),
      ]);
      expect((globalThis as any).__hydrateImportCount).toBe(1);
      expect(funcTracker).toHaveBeenCalledTimes(2);
      expect(sentinelPredicate).not.toHaveBeenCalled();
      expect(browserSessionSpy).not.toHaveBeenCalled();
      await executeCommand(placeholder, {});
      expect((globalThis as any).__hydrateImportCount).toBe(1);
      expect(funcTracker).toHaveBeenCalledTimes(3);
    } finally {
      getRegistry().delete(key);
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__hydrateImportCount;
      delete (globalThis as any).__concurrentHydrateFunc;
      vi.restoreAllMocks();
    }
  });

  it('rejects a hydrated module whose argument schema is stale before validation or routing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-conditional-schema-'));
    const site = `conditional-schema-${Date.now()}`;
    const key = `${site}/list`;
    const modulePath = path.join(root, 'list.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    const sentinelPredicate = vi.fn(() => { throw new Error('placeholder predicate ran'); });
    const validationTracker = vi.fn();
    (globalThis as any).__schemaHydrateValidate = validationTracker;
    fs.writeFileSync(modulePath, `
import { cli } from ${JSON.stringify(registryUrl)};
cli({
  site: ${JSON.stringify(site)}, name: 'list', aliases: ['bad-alias'], access: 'read',
  browser: () => false,
  args: [{ name: 'auth-source', default: 'browser' }],
  validateArgs: args => globalThis.__schemaHydrateValidate(args),
  func: async () => [],
});
`);
    const placeholder: InternalCliCommand = {
      site, name: 'list', aliases: ['old-alias'], access: 'read', description: '',
      browser: 'conditional', requiresBrowser: sentinelPredicate,
      args: [{ name: 'auth-source', default: 'env' }],
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);
    const browserSessionSpy = vi.spyOn(runtime, 'browserSession');

    try {
      await expect(executeCommand(placeholder, {})).rejects.toMatchObject({
        code: 'COMMAND_EXEC',
        message: expect.stringContaining('argument schema does not match'),
      });
      expect(validationTracker).not.toHaveBeenCalled();
      expect(sentinelPredicate).not.toHaveBeenCalled();
      expect(browserSessionSpy).not.toHaveBeenCalled();
      expect(getRegistry().get(key)).toBe(placeholder);
      expect(getRegistry().get(`${site}/old-alias`)).toBe(placeholder);
      expect(getRegistry().get(`${site}/bad-alias`)).toBeUndefined();
    } finally {
      getRegistry().delete(key);
      getRegistry().delete(`${site}/old-alias`);
      getRegistry().delete(`${site}/bad-alias`);
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__schemaHydrateValidate;
      vi.restoreAllMocks();
    }
  });

  it.each([
    ['extra property', () => Object.assign([], { meta: true })],
    ['symbol property', () => {
      const value: unknown[] = [];
      Object.defineProperty(value, Symbol('meta'), { value: true, enumerable: true });
      return value;
    }],
    ['accessor', () => {
      const value: unknown[] = [];
      Object.defineProperty(value, '0', { get: () => true, enumerable: true, configurable: true });
      return value;
    }],
    ['non-enumerable property', () => {
      const value: unknown[] = [];
      Object.defineProperty(value, 'meta', { value: true, enumerable: false });
      return value;
    }],
  ])('rejects hydrated array defaults with unsafe %s before routing', async (_label, makeDefault) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-conditional-array-schema-'));
    const site = `conditional-array-schema-${Date.now()}-${Math.random()}`;
    const key = `${site}/list`;
    const modulePath = path.join(root, 'list.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    const sentinelPredicate = vi.fn(() => { throw new Error('placeholder predicate ran'); });
    (globalThis as any).__unsafeHydratedArray = makeDefault();
    fs.writeFileSync(modulePath, `
import { cli } from ${JSON.stringify(registryUrl)};
cli({
  site: ${JSON.stringify(site)}, name: 'list', access: 'read',
  browser: () => false,
  args: [{ name: 'unsafe-array', default: globalThis.__unsafeHydratedArray }],
  func: async () => [],
});
`);
    const placeholder: InternalCliCommand = {
      site, name: 'list', access: 'read', description: '',
      browser: 'conditional', requiresBrowser: sentinelPredicate,
      args: [{ name: 'unsafe-array', default: [] }],
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);
    const browserSessionSpy = vi.spyOn(runtime, 'browserSession');

    try {
      await expect(executeCommand(placeholder, {})).rejects.toMatchObject({
        code: 'COMMAND_EXEC', message: expect.stringContaining('unsafe argument schema'),
      });
      expect(sentinelPredicate).not.toHaveBeenCalled();
      expect(browserSessionSpy).not.toHaveBeenCalled();
    } finally {
      getRegistry().delete(key);
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__unsafeHydratedArray;
      vi.restoreAllMocks();
    }
  });

  it.each([
    ['shared default reference', () => {
      const shared = { value: 1 };
      return [{ name: 'shared', default: [shared, shared] }];
    }],
    ['sparse args container', () => {
      const args = new Array(2);
      args[1] = { name: 'present' };
      return args;
    }],
    ['unsafe choices container', () => [{
      name: 'choice', choices: Object.assign(['one'], { meta: true }),
    }]],
  ])('rejects hydrated %s transactionally', async (_label, makeArgs) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-conditional-unsafe-schema-'));
    const site = `conditional-unsafe-schema-${Date.now()}-${Math.random()}`;
    const key = `${site}/list`;
    const modulePath = path.join(root, 'list.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    const sentinelPredicate = vi.fn(() => { throw new Error('placeholder predicate ran'); });
    (globalThis as any).__unsafeHydratedArgs = makeArgs();
    fs.writeFileSync(modulePath, `
import { cli } from ${JSON.stringify(registryUrl)};
cli({
  site: ${JSON.stringify(site)}, name: 'list', aliases: ['bad-alias'], access: 'read',
  browser: () => false, args: globalThis.__unsafeHydratedArgs, func: async () => [],
});
`);
    const placeholder: InternalCliCommand = {
      site, name: 'list', aliases: ['old-alias'], access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: sentinelPredicate,
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);

    try {
      await expect(executeCommand(placeholder, {})).rejects.toMatchObject({
        code: 'COMMAND_EXEC', message: expect.stringContaining('unsafe argument schema'),
      });
      expect(getRegistry().get(key)).toBe(placeholder);
      expect(getRegistry().get(`${site}/old-alias`)).toBe(placeholder);
      expect(getRegistry().get(`${site}/bad-alias`)).toBeUndefined();
      expect(sentinelPredicate).not.toHaveBeenCalled();
    } finally {
      getRegistry().delete(key);
      getRegistry().delete(`${site}/old-alias`);
      getRegistry().delete(`${site}/bad-alias`);
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__unsafeHydratedArgs;
    }
  });

  it('rejects a static replacement for a conditional manifest placeholder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-conditional-static-'));
    const site = `conditional-static-${Date.now()}`;
    const key = `${site}/list`;
    const modulePath = path.join(root, 'list.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    const sentinelPredicate = vi.fn(() => { throw new Error('placeholder predicate ran'); });
    fs.writeFileSync(modulePath, `
import { cli, Strategy } from ${JSON.stringify(registryUrl)};
cli({
  site: ${JSON.stringify(site)}, name: 'list', access: 'read',
  strategy: Strategy.PUBLIC, browser: false, aliases: ['bad-alias'], func: async () => [],
});
`);
    const placeholder: InternalCliCommand = {
      site, name: 'list', aliases: ['old-alias'], access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: sentinelPredicate,
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);
    const browserSessionSpy = vi.spyOn(runtime, 'browserSession');

    try {
      await expect(executeCommand(placeholder, {})).rejects.toMatchObject({
        code: 'COMMAND_EXEC',
        message: expect.stringContaining('valid hydrated conditional command'),
      });
      expect(sentinelPredicate).not.toHaveBeenCalled();
      expect(browserSessionSpy).not.toHaveBeenCalled();
      expect(getRegistry().get(key)).toBe(placeholder);
      expect(getRegistry().get(`${site}/old-alias`)).toBe(placeholder);
      expect(getRegistry().get(`${site}/bad-alias`)).toBeUndefined();

      const retryFunc = vi.fn(async () => []);
      Object.assign(globalThis, { __staticRetryImports: 0, __staticRetryFunc: retryFunc });
      fs.writeFileSync(modulePath, `
import { cli } from ${JSON.stringify(registryUrl)};
globalThis.__staticRetryImports += 1;
cli({
  site: ${JSON.stringify(site)}, name: 'list', access: 'read',
  browser: () => false,
  func: async (page, args, debug) => globalThis.__staticRetryFunc(page, args, debug),
});
`);
      await Promise.all([executeCommand(placeholder, {}), executeCommand(placeholder, {})]);
      expect((globalThis as any).__staticRetryImports).toBe(1);
      expect(retryFunc).toHaveBeenCalledTimes(2);
      expect(sentinelPredicate).not.toHaveBeenCalled();
    } finally {
      getRegistry().delete(key);
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__staticRetryImports;
      delete (globalThis as any).__staticRetryFunc;
      vi.restoreAllMocks();
    }
  });

  it('times out a stuck registration import, poisons lazy retries, and leaves ordinary commands usable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-import-timeout-'));
    const site = `import-timeout-${Date.now()}`;
    const key = `${site}/list`;
    const modulePath = path.join(root, 'list.mjs');
    const previousTimeout = process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS;
    process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS = '25';
    (globalThis as any).__neverSettlingImport = new Promise(() => {});
    fs.writeFileSync(modulePath, 'await globalThis.__neverSettlingImport;\n');
    const sentinelPredicate = vi.fn(() => { throw new Error('placeholder predicate ran'); });
    const placeholder: InternalCliCommand = {
      site, name: 'list', access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: sentinelPredicate,
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);

    try {
      const startedAt = Date.now();
      await expect(executeCommand(placeholder, {})).rejects.toMatchObject({
        code: 'ADAPTER_LOAD', exitCode: 69,
        hint: expect.stringContaining('Restart byCLI'),
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);

      fs.writeFileSync(modulePath, 'export const corrected = true;\n');
      await expect(executeCommand(placeholder, {})).rejects.toMatchObject({
        code: 'ADAPTER_LOAD',
        hint: expect.stringContaining('Restart byCLI'),
      });

      const ordinary = cli({
        site, name: 'ordinary', access: 'read', browser: false,
        func: async () => 'still-usable',
      });
      await expect(executeCommand(ordinary, {})).resolves.toBe('still-usable');
      expect(sentinelPredicate).not.toHaveBeenCalled();
    } finally {
      _resetLazyModuleStateForTests();
      getRegistry().delete(key);
      getRegistry().delete(`${site}/ordinary`);
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__neverSettlingImport;
      if (previousTimeout === undefined) delete process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS;
      else process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS = previousTimeout;
    }
  });

  it('reuses an unchanged successful hot-reload entry after poison but rejects a changed reload', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-poison-cache-'));
    const previousConfigDir = process.env.BYCLI_CONFIG_DIR;
    const previousTimeout = process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS;
    process.env.BYCLI_CONFIG_DIR = root;
    process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS = '5000';
    const site = `poison-cache-${Date.now()}`;
    const moduleDir = path.join(root, 'clis', site);
    const successPath = path.join(moduleDir, 'success.mjs');
    const timeoutPath = path.join(moduleDir, 'timeout.mjs');
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(successPath, `
import { cli, Strategy } from ${JSON.stringify(registryUrl)};
cli({ site: ${JSON.stringify(site)}, name: 'success', access: 'read', strategy: Strategy.PUBLIC, browser: false, func: async () => 'cached' });
`);
    (globalThis as any).__poisonNever = new Promise(() => {});
    fs.writeFileSync(timeoutPath, 'await globalThis.__poisonNever;\n');
    const success: InternalCliCommand = {
      site, name: 'success', access: 'read', description: '', args: [],
      browser: false, _lazy: true, _modulePath: successPath,
    };
    const timeout: InternalCliCommand = {
      site, name: 'timeout', access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: () => false,
      _lazy: true, _modulePath: timeoutPath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(success);
    registerCommand(timeout);
    try {
      await expect(executeCommand(success, {})).resolves.toBe('cached');
      process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS = '25';
      await expect(executeCommand(timeout, {})).rejects.toMatchObject({ code: 'ADAPTER_LOAD' });
      await expect(executeCommand(success, {})).resolves.toBe('cached');

      fs.appendFileSync(successPath, '\n// changed after poison\n');
      await expect(executeCommand(success, {})).rejects.toMatchObject({
        code: 'ADAPTER_LOAD', hint: expect.stringContaining('Restart byCLI'),
      });
    } finally {
      _resetLazyModuleStateForTests();
      for (const name of ['success', 'timeout']) getRegistry().delete(`${site}/${name}`);
      fs.rmSync(root, { recursive: true, force: true });
      delete (globalThis as any).__poisonNever;
      if (previousConfigDir === undefined) delete process.env.BYCLI_CONFIG_DIR;
      else process.env.BYCLI_CONFIG_DIR = previousConfigDir;
      if (previousTimeout === undefined) delete process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS;
      else process.env.BYCLI_ADAPTER_IMPORT_TIMEOUT_MS = previousTimeout;
    }
  });

  it('routes and executes with the same final args after onBeforeExecute mutates them', async () => {
    const resolver = vi.fn((args: Record<string, unknown>) => args['auth-source'] !== 'env');
    const func = vi.fn(async (_page: unknown, _args: Record<string, unknown>, _debug?: boolean) => []);
    const mockPage = { closeWindow: vi.fn().mockResolvedValue(undefined) } as any;
    const browserSessionSpy = vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn) => fn(mockPage));
    let hookArgs: Record<string, unknown> | undefined;
    onBeforeExecute((ctx) => {
      ctx.args = { ...ctx.args, 'auth-source': 'env' };
      hookArgs = ctx.args;
    });
    const cmd = cli({
      site: 'test-execution', name: 'conditional-hook-mutation', access: 'read',
      browser: resolver,
      args: [{ name: 'auth-source', default: 'browser', choices: ['browser', 'env'] }],
      func,
    });

    try {
      await executeCommand(cmd, {});

      expect(resolver).toHaveBeenCalledOnce();
      expect(resolver.mock.calls[0]?.[0]).toBe(hookArgs);
      expect(browserSessionSpy).not.toHaveBeenCalled();
      expect(func.mock.calls[0]?.[1]).toBe(hookArgs);
      expect(func).toHaveBeenCalledWith(null, { 'auth-source': 'env' }, false);
    } finally {
      clearAllHooks();
      vi.restoreAllMocks();
    }
  });

  it('resolves after defaults and skips the browser for environment authentication', async () => {
    const resolver = vi.fn((args: Record<string, unknown>) => args['auth-source'] !== 'env');
    const func = vi.fn(async () => []);
    const mockPage = { closeWindow: vi.fn().mockResolvedValue(undefined) } as any;
    const browserSessionSpy = vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn) => fn(mockPage));
    const cmd = cli({
      site: 'test-execution',
      name: 'conditional-env',
      access: 'read',
      strategy: Strategy.COOKIE,
      browser: resolver,
      args: [{ name: 'auth-source', default: 'browser', choices: ['browser', 'env'] }],
      func,
    });

    try {
      await executeCommand(cmd, { 'auth-source': 'env' });

      expect(resolver).toHaveBeenCalledOnce();
      expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ 'auth-source': 'env' }));
      expect(browserSessionSpy).not.toHaveBeenCalled();
      expect(func).toHaveBeenCalledWith(null, expect.objectContaining({ 'auth-source': 'env' }), false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('resolves after defaults and opens one browser session for browser authentication', async () => {
    const resolver = vi.fn((args: Record<string, unknown>) => (
      args['auth-source'] !== 'env' && args['browser-enabled'] === true
    ));
    const func = vi.fn(async () => []);
    const mockPage = { closeWindow: vi.fn().mockResolvedValue(undefined) } as any;
    const browserSessionSpy = vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn) => fn(mockPage));
    const cmd = cli({
      site: 'test-execution',
      name: 'conditional-browser',
      access: 'read',
      strategy: Strategy.INTERCEPT,
      browser: resolver,
      args: [
        { name: 'auth-source', default: 'browser', choices: ['browser', 'env'] },
        { name: 'browser-enabled', type: 'boolean' },
      ],
      func,
    });

    try {
      await executeCommand(cmd, { 'browser-enabled': 'true' });

      expect(resolver).toHaveBeenCalledOnce();
      expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
        'auth-source': 'browser',
        'browser-enabled': true,
      }));
      expect(browserSessionSpy).toHaveBeenCalledOnce();
      expect(func).toHaveBeenCalledWith(mockPage, expect.objectContaining({
        'auth-source': 'browser',
        'browser-enabled': true,
      }), false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('preserves typed errors thrown by a browser requirement resolver', async () => {
    const browserSessionSpy = vi.spyOn(runtime, 'browserSession');
    const before = vi.fn();
    let afterContext: HookContext | undefined;
    onBeforeExecute(before);
    onAfterExecute((ctx) => { afterContext = ctx; });
    const cmd = cli({
      site: 'test-execution',
      name: 'conditional-typed-error',
      access: 'read',
      browser: () => { throw new ArgumentError('bad auth-source'); },
      func: async () => [],
    });

    try {
      const error = await executeCommand(cmd, {}).catch((caught) => caught);
      expect(error).toMatchObject({ code: 'ARGUMENT', exitCode: 2 });
      expect(before).toHaveBeenCalledOnce();
      expect(afterContext).toMatchObject({ error, finishedAt: expect.any(Number) });
      expect(browserSessionSpy).not.toHaveBeenCalled();
    } finally {
      clearAllHooks();
      vi.restoreAllMocks();
    }
  });

  it('wraps unknown browser requirement resolver failures as command execution errors', async () => {
    const browserSessionSpy = vi.spyOn(runtime, 'browserSession');
    const before = vi.fn();
    let afterContext: HookContext | undefined;
    onBeforeExecute(before);
    onAfterExecute((ctx) => { afterContext = ctx; });
    const cmd = cli({
      site: 'test-execution',
      name: 'conditional-unknown-error',
      access: 'read',
      browser: () => { throw new Error('predicate bug'); },
      func: async () => [],
    });

    try {
      const error = await executeCommand(cmd, {}).catch((caught) => caught);
      expect(error).toMatchObject({ code: 'COMMAND_EXEC', exitCode: 1 });
      expect(before).toHaveBeenCalledOnce();
      expect(afterContext).toMatchObject({ error, finishedAt: expect.any(Number) });
      expect(browserSessionSpy).not.toHaveBeenCalled();
    } finally {
      clearAllHooks();
      vi.restoreAllMocks();
    }
  });
});

describe('executeCommand — non-browser timeout', () => {
  it('applies the user --timeout arg as the ceiling for non-browser commands', async () => {
    const runWithTimeoutSpy = vi.spyOn(runtime, 'runWithTimeout');
    const cmd = cli({
      site: 'test-execution',
      name: 'non-browser-timeout', access: 'read',
      description: 'test non-browser --timeout enforcement',
      browser: false,
      strategy: Strategy.PUBLIC,
      args: [
        { name: 'timeout', type: 'int', required: false, default: 5, help: 'Max seconds' },
      ],
      func: async () => [{ ok: true }],
    });

    await executeCommand(cmd, {});

    expect(runWithTimeoutSpy).toHaveBeenCalledTimes(1);
    // Ceiling = user-supplied/default timeout + 30s padding (adapter return room).
    expect(runWithTimeoutSpy.mock.calls[0]?.[1]).toMatchObject({
      timeout: 35,
      label: 'test-execution/non-browser-timeout',
    });
    vi.restoreAllMocks();
  });

  it('fires a TimeoutError when the inner adapter exceeds the --timeout ceiling', async () => {
    const cmd = cli({
      site: 'test-execution',
      name: 'non-browser-timeout-fires', access: 'read',
      description: 'test that the ceiling actually cancels the adapter',
      browser: false,
      strategy: Strategy.PUBLIC,
      args: [
        { name: 'timeout', type: 'int', required: false, default: 1, help: 'Max seconds' },
      ],
      func: () => new Promise(() => {}),
    });

    // Spy on runWithTimeout to intercept and pass a tiny ceiling so the test
    // doesn't have to wait the real (1+30)s. We still verify the TimeoutError
    // surface — code, label, hint — that users see.
    vi.spyOn(runtime, 'runWithTimeout').mockImplementation(async (promise, opts) => {
      return runtime.withTimeoutMs(
        promise as Promise<unknown>,
        50,
        () => new TimeoutError(opts.label ?? 'op', opts.timeout, opts.hint),
      ) as never;
    });

    const error = await executeCommand(cmd, {}).catch((err) => err);

    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({
      code: 'TIMEOUT',
      hint: 'Pass a higher --timeout value (currently 1s)',
    });
    vi.restoreAllMocks();
  });

  it('runs non-browser commands without a ceiling when no --timeout arg is declared', async () => {
    const runWithTimeoutSpy = vi.spyOn(runtime, 'runWithTimeout');
    const cmd = cli({
      site: 'test-execution',
      name: 'non-browser-no-timeout', access: 'read',
      description: 'test that omitting --timeout means no ceiling',
      browser: false,
      strategy: Strategy.PUBLIC,
      func: async () => [{ ok: true }],
    });

    await executeCommand(cmd, {});

    expect(runWithTimeoutSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('rejects invalid --timeout values instead of silently disabling the non-browser ceiling', async () => {
    const runWithTimeoutSpy = vi.spyOn(runtime, 'runWithTimeout');
    const cmd = cli({
      site: 'test-execution',
      name: 'non-browser-invalid-timeout', access: 'read',
      description: 'test invalid --timeout fails upfront',
      browser: false,
      strategy: Strategy.PUBLIC,
      args: [
        { name: 'timeout', type: 'int', required: false, default: 5, help: 'Max seconds' },
      ],
      func: async () => [{ ok: true }],
    });

    await expect(executeCommand(cmd, { timeout: 0 })).rejects.toBeInstanceOf(ArgumentError);
    await expect(executeCommand(cmd, { timeout: -1 })).rejects.toBeInstanceOf(ArgumentError);
    await expect(executeCommand(cmd, { timeout: 1.5 })).rejects.toBeInstanceOf(ArgumentError);
    expect(runWithTimeoutSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('applies the user --timeout arg as the ceiling for browser commands (with +30s padding)', async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const mockPage = { closeWindow } as any;

    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn) => fn(mockPage));
    const runWithTimeoutSpy = vi.spyOn(runtime, 'runWithTimeout');

    const cmd = cli({
      site: 'test-execution',
      name: 'browser-with-timeout', access: 'read',
      description: 'test browser --timeout enforcement',
      browser: true,
      strategy: Strategy.PUBLIC,
      args: [
        { name: 'timeout', type: 'int', required: false, default: 5, help: 'Max seconds' },
      ],
      func: async () => [{ ok: true }],
    });

    await executeCommand(cmd, {});

    expect(runWithTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(runWithTimeoutSpy.mock.calls[0]?.[1]).toMatchObject({
      timeout: 35,
      label: 'test-execution/browser-with-timeout',
    });
    vi.restoreAllMocks();
  });

  it('falls back to DEFAULT_BROWSER_COMMAND_TIMEOUT for browser commands without a --timeout arg', async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const mockPage = { closeWindow } as any;

    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn) => fn(mockPage));
    const runWithTimeoutSpy = vi.spyOn(runtime, 'runWithTimeout');

    const cmd = cli({
      site: 'test-execution',
      name: 'browser-no-timeout', access: 'read',
      description: 'test browser fallback to global default',
      browser: true,
      strategy: Strategy.PUBLIC,
      func: async () => [{ ok: true }],
    });

    await executeCommand(cmd, {});

    expect(runWithTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(runWithTimeoutSpy.mock.calls[0]?.[1]).toMatchObject({
      timeout: runtime.DEFAULT_BROWSER_COMMAND_TIMEOUT,
      label: 'test-execution/browser-no-timeout',
    });
    vi.restoreAllMocks();
  });

  it('reuses a persistent site browser session and keeps the tab lease open', async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const mockPage = { closeWindow } as any;
    const sessionOpts: Array<{ session?: string; idleTimeout?: number; windowMode?: string; siteSession?: string }> = [];

    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn, opts) => {
      sessionOpts.push(opts ?? {});
      return fn(mockPage);
    });

    const cmd = cli({
      site: 'test-execution',
      name: 'site-session-persistent', access: 'read',
      description: 'test persistent site session',
      browser: true,
      strategy: Strategy.PUBLIC,
      siteSession: 'persistent',
      func: async () => [{ ok: true }],
    });

    await executeCommand(cmd, {});
    await executeCommand(cmd, {}, false, { keepTab: 'false' });

    expect(sessionOpts).toHaveLength(2);
    expect(sessionOpts[0]).toMatchObject({ session: 'site:test-execution', windowMode: 'background', siteSession: 'persistent' });
    expect(sessionOpts[1]).toMatchObject({ session: 'site:test-execution', windowMode: 'background', siteSession: 'persistent' });
    expect(sessionOpts[0]?.idleTimeout).toBeUndefined();
    expect(sessionOpts[1]?.idleTimeout).toBeUndefined();
    expect(closeWindow).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('keeps default browser commands on one-shot adapter sessions', async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const mockPage = { closeWindow } as any;
    const sessionOpts: Array<{ session?: string; idleTimeout?: number; windowMode?: string }> = [];

    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn, opts) => {
      sessionOpts.push(opts ?? {});
      return fn(mockPage);
    });

    const cmd = cli({
      site: 'test-execution',
      name: 'site-session-default', access: 'read',
      description: 'test default one-shot browser session',
      browser: true,
      strategy: Strategy.PUBLIC,
      func: async () => [{ ok: true }],
    });

    await executeCommand(cmd, {});
    await executeCommand(cmd, {});

    expect(sessionOpts).toHaveLength(2);
    expect(sessionOpts[0]?.session).toMatch(/^site:test-execution:/);
    expect(sessionOpts[1]?.session).toMatch(/^site:test-execution:/);
    expect(sessionOpts[0]?.session).not.toBe(sessionOpts[1]?.session);
    expect(sessionOpts[0]?.idleTimeout).toBeUndefined();
    expect(sessionOpts[1]?.idleTimeout).toBeUndefined();
    expect(sessionOpts[0]?.windowMode).toBe('background');
    expect(sessionOpts[1]?.windowMode).toBe('background');
    expect(closeWindow).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('lets user --site-session ephemeral override adapter persistent metadata', async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const mockPage = { closeWindow } as any;
    const sessionOpts: Array<{ session?: string; idleTimeout?: number }> = [];

    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn, opts) => {
      sessionOpts.push(opts ?? {});
      return fn(mockPage);
    });

    try {
      const cmd = cli({
        site: 'test-execution',
        name: 'site-session-override-ephemeral', access: 'read',
        description: 'test user site-session override',
        browser: true,
        strategy: Strategy.PUBLIC,
        siteSession: 'persistent',
        func: async () => [{ ok: true }],
      });

      await executeCommand(cmd, {}, false, { siteSession: 'ephemeral' });

      expect(sessionOpts).toHaveLength(1);
      expect(sessionOpts[0]?.session).toMatch(/^site:test-execution:/);
      expect(sessionOpts[0]?.idleTimeout).toBeUndefined();
      expect(closeWindow).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('skips repeated domain pre-navigation for persistent site sessions', async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const goto = vi.fn().mockResolvedValue(undefined);
    const mockPage = {
      closeWindow,
      goto,
      getCurrentUrl: vi.fn().mockResolvedValue('https://grok.com/chat/abc'),
    } as any;

    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn) => fn(mockPage));

    const cmd = cli({
      site: 'test-execution',
      name: 'site-session-skip-prenav', access: 'read',
      description: 'test reused same-domain tabs do not reset conversation state',
      browser: true,
      strategy: Strategy.COOKIE,
      domain: 'grok.com',
      siteSession: 'persistent',
      func: async () => [{ ok: true }],
    });

    await executeCommand(cmd, {});

    expect(goto).not.toHaveBeenCalled();
    expect(closeWindow).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('keeps explicit path pre-navigation for persistent site sessions', async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const goto = vi.fn().mockResolvedValue(undefined);
    const mockPage = {
      closeWindow,
      goto,
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.com/other'),
    } as any;

    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn) => fn(mockPage));

    const cmd = cli({
      site: 'test-execution',
      name: 'site-session-path-prenav', access: 'read',
      description: 'test explicit path pre-navigation still runs',
      browser: true,
      strategy: Strategy.COOKIE,
      domain: 'example.com',
      navigateBefore: 'https://example.com/dashboard',
      siteSession: 'persistent',
      func: async () => [{ ok: true }],
    });

    await executeCommand(cmd, {});

    expect(goto).toHaveBeenCalledWith('https://example.com/dashboard');
    expect(closeWindow).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('respects navigateBefore=false so adapter range validation fails before browser navigation', async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const goto = vi.fn().mockResolvedValue(undefined);
    const mockPage = {
      closeWindow,
      goto,
      getCurrentUrl: vi.fn().mockResolvedValue('about:blank'),
    } as any;

    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn) => fn(mockPage));

    const cmd = cli({
      site: 'test-execution',
      name: 'browser-invalid-limit-no-prenav', access: 'read',
      description: 'test adapter range validation can fail before pre-nav',
      browser: true,
      strategy: Strategy.COOKIE,
      domain: 'www.facebook.com',
      navigateBefore: false,
      args: [
        { name: 'limit', type: 'int', required: false, default: 15, help: 'Limit' },
      ],
      func: async (_page, args) => {
        const limit = Number(args.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new ArgumentError('--limit must be a positive integer in [1, 100]');
        }
        return [{ ok: true }];
      },
    });

    await expect(executeCommand(cmd, { limit: 0 })).rejects.toBeInstanceOf(ArgumentError);
    expect(goto).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('rejects invalid --timeout values instead of falling back to the browser default', async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const mockPage = { closeWindow } as any;

    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn) => fn(mockPage));
    const runWithTimeoutSpy = vi.spyOn(runtime, 'runWithTimeout');

    const cmd = cli({
      site: 'test-execution',
      name: 'browser-invalid-timeout', access: 'read',
      description: 'test invalid browser --timeout fails upfront',
      browser: true,
      strategy: Strategy.PUBLIC,
      args: [
        { name: 'timeout', type: 'int', required: false, default: 5, help: 'Max seconds' },
      ],
      func: async () => [{ ok: true }],
    });

    await expect(executeCommand(cmd, { timeout: 0 })).rejects.toBeInstanceOf(ArgumentError);
    await expect(executeCommand(cmd, { timeout: -1 })).rejects.toBeInstanceOf(ArgumentError);
    await expect(executeCommand(cmd, { timeout: 1.5 })).rejects.toBeInstanceOf(ArgumentError);
    expect(runWithTimeoutSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('rejects invalid browser --timeout before opening a session or pre-navigating', async () => {
    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
    const browserSessionSpy = vi.spyOn(runtime, 'browserSession');

    const cmd = cli({
      site: 'test-execution',
      name: 'browser-invalid-timeout-prenav', access: 'read',
      description: 'test invalid browser --timeout fails before session setup',
      browser: true,
      strategy: Strategy.PUBLIC,
      navigateBefore: 'https://example.com/',
      args: [
        { name: 'timeout', type: 'int', required: false, default: 5, help: 'Max seconds' },
      ],
      func: async () => [{ ok: true }],
    });

    await expect(executeCommand(cmd, { timeout: 0 })).rejects.toBeInstanceOf(ArgumentError);
    expect(browserSessionSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('calls closeWindow on browser command failure', async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const mockPage = { closeWindow } as any;

    // Mock shouldUseBrowserSession to return true
    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);

    // Mock browserSession to invoke the callback with our mock page
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn) => {
      return fn(mockPage);
    });

    const cmd = cli({
      site: 'test-execution',
      name: 'browser-close-on-error', access: 'read',
      description: 'test closeWindow on failure',
      browser: true,
      strategy: Strategy.PUBLIC,
      func: async () => { throw new Error('adapter failure'); },
    });

    await expect(executeCommand(cmd, {})).rejects.toThrow('adapter failure');
    expect(closeWindow).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
  });

  it('skips closeWindow when --keep-tab=true (success path)', async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const mockPage = { closeWindow } as any;

    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn) => fn(mockPage));

    try {
      const cmd = cli({
        site: 'test-execution',
        name: 'browser-keep-tab-success', access: 'read',
        description: 'test closeWindow skipped with --keep-tab on success',
        browser: true,
        strategy: Strategy.PUBLIC,
        func: async () => [{ ok: true }],
      });

      await executeCommand(cmd, {}, false, { keepTab: 'true' });
      expect(closeWindow).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('skips closeWindow when --keep-tab=true (failure path)', async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const mockPage = { closeWindow } as any;

    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn) => fn(mockPage));

    try {
      const cmd = cli({
        site: 'test-execution',
        name: 'browser-keep-tab-failure', access: 'read',
        description: 'test closeWindow skipped with --keep-tab on failure',
        browser: true,
        strategy: Strategy.PUBLIC,
        func: async () => { throw new Error('adapter failure'); },
      });

      await expect(executeCommand(cmd, {}, false, { keepTab: 'true' })).rejects.toThrow('adapter failure');
      expect(closeWindow).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('lets browser common options override adapter window and keep-tab defaults', async () => {
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const mockPage = { closeWindow } as any;
    const sessionOpts: Array<{ windowMode?: string }> = [];

    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn, opts) => {
      sessionOpts.push(opts ?? {});
      return fn(mockPage);
    });

    const cmd = cli({
      site: 'test-execution',
      name: 'browser-window-options', access: 'read',
      description: 'test browser common options',
      browser: true,
      strategy: Strategy.PUBLIC,
      func: async () => [{ ok: true }],
    });

    await executeCommand(cmd, {}, false, {
      windowMode: 'foreground',
      keepTab: 'true',
    });

    expect(sessionOpts[0]).toMatchObject({ windowMode: 'foreground' });
    expect(closeWindow).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('does not re-run custom validation when args are already prepared', async () => {
    const validateArgs = vi.fn();
    const cmd: CliCommand = {
      site: 'test-execution',
      name: 'prepared-validation', access: 'read',
      description: 'test prepared validation path',
      browser: false,
      strategy: Strategy.PUBLIC,
      args: [],
      validateArgs,
      func: async () => [],
    };

    const kwargs = prepareCommandArgs(cmd, {});
    await executeCommand(cmd, kwargs, false, { prepared: true });

    expect(validateArgs).toHaveBeenCalledTimes(1);
  });

  it('exports a profile-scoped trace artifact on browser command failure when requested', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-exec-trace-'));
    const prevConfigDir = process.env.BYCLI_CONFIG_DIR;
    process.env.BYCLI_CONFIG_DIR = baseDir;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const mockPage = {
      closeWindow,
      startNetworkCapture: vi.fn().mockResolvedValue(true),
      readNetworkCapture: vi.fn().mockResolvedValue([
        {
          url: 'https://api.example.com/data?token=secret',
          method: 'GET',
          responseStatus: 500,
          responseContentType: 'application/json',
          responsePreview: JSON.stringify({ password: 'secret', ok: false }),
          requestHeaders: { authorization: 'Bearer secret' },
          timestamp: Date.now(),
        },
      ]),
      consoleMessages: vi.fn().mockResolvedValue([{ type: 'error', text: 'boom password=secret', timestamp: Date.now() }]),
      snapshot: vi.fn().mockResolvedValue({ html: '<input type="password" value="secret">' }),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png').toString('base64')),
      getCurrentUrl: vi.fn().mockResolvedValue('https://api.example.com/app'),
      getActivePage: vi.fn().mockReturnValue('tab-1'),
    } as any;

    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn) => fn(mockPage));

    try {
      const cmd = cli({
        site: 'test-execution',
        name: 'browser-trace-failure', access: 'read',
        description: 'test trace export',
        browser: true,
        strategy: Strategy.PUBLIC,
        func: async () => { throw new Error('adapter failure'); },
      });

      const thrown = await executeCommand(cmd, {}, false, { trace: 'retain-on-failure' }).catch((err) => err);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('adapter failure');

      const tracesRoot = path.join(baseDir, 'profiles', 'default', 'traces');
      const traceId = fs.readdirSync(tracesRoot)[0];
      const traceDir = path.join(tracesRoot, traceId);
      expect(fs.existsSync(path.join(traceDir, 'trace.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(traceDir, 'receipt.json'))).toBe(true);
      const trace = fs.readFileSync(path.join(traceDir, 'trace.jsonl'), 'utf-8');
      expect(trace).toContain('token=[REDACTED]');
      expect(trace).toContain('"authorization":"[REDACTED]"');
      expect(trace).not.toContain('password=secret');
      expect(stderrSpy.mock.calls.flat().join('\n')).not.toContain('___BYCLI_TRACE___');

      expect(toEnvelope(thrown).trace).toMatchObject({
        traceId,
        dir: traceDir,
        summaryPath: path.join(traceDir, 'summary.md'),
        receiptPath: path.join(traceDir, 'receipt.json'),
        status: 'failure',
      });
      expect(closeWindow).toHaveBeenCalledTimes(1);
    } finally {
      if (prevConfigDir === undefined) delete process.env.BYCLI_CONFIG_DIR;
      else process.env.BYCLI_CONFIG_DIR = prevConfigDir;
      stderrSpy.mockRestore();
      fs.rmSync(baseDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });

  it('keeps manifest placeholder provenance when conditional hydration creates a trace', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-conditional-trace-source-'));
    const modulePath = path.join(baseDir, 'conditional.mjs');
    const site = `conditional-trace-source-${Date.now()}`;
    const key = `${site}/list`;
    const registryUrl = new URL('./registry.ts', import.meta.url).href;
    const previousConfigDir = process.env.BYCLI_CONFIG_DIR;
    process.env.BYCLI_CONFIG_DIR = baseDir;
    fs.writeFileSync(modulePath, `
import { cli } from ${JSON.stringify(registryUrl)};
cli({
  site: ${JSON.stringify(site)}, name: 'list', access: 'read', browser: () => true,
  func: async () => [{ ok: true }],
});
`);
    const placeholder: InternalCliCommand = {
      site, name: 'list', access: 'read', description: '', args: [],
      browser: 'conditional', requiresBrowser: () => { throw new Error('sentinel ran'); },
      source: `manifest:${site}/list`,
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);
    const onTraceExport = vi.fn();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const mockPage = {
      closeWindow: vi.fn().mockResolvedValue(undefined),
      startNetworkCapture: vi.fn().mockResolvedValue(true),
      readNetworkCapture: vi.fn().mockResolvedValue([]),
      consoleMessages: vi.fn().mockResolvedValue([]),
      snapshot: vi.fn().mockResolvedValue('snapshot'),
      screenshot: vi.fn().mockResolvedValue(undefined),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.com'),
      getActivePage: vi.fn().mockReturnValue('tab-conditional-trace'),
    } as any;
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn) => fn(mockPage));

    try {
      await expect(executeCommand(placeholder, {}, false, { trace: 'on', onTraceExport }))
        .resolves.toEqual([{ ok: true }]);
      expect(onTraceExport).toHaveBeenCalledWith(expect.objectContaining({
        receipt: expect.objectContaining({
          scope: expect.objectContaining({ adapterSourcePath: modulePath }),
        }),
      }));
      getRegistry().delete(key);
      expect(registryMutationKeys()).not.toContain(key);
    } finally {
      _resetLazyModuleStateForTests();
      getRegistry().delete(key);
      if (previousConfigDir === undefined) delete process.env.BYCLI_CONFIG_DIR;
      else process.env.BYCLI_CONFIG_DIR = previousConfigDir;
      fs.rmSync(baseDir, { recursive: true, force: true });
      stderrSpy.mockRestore();
      vi.restoreAllMocks();
    }
  });

  it('exports a trace receipt on browser command success when trace is on', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-exec-trace-success-'));
    const prevConfigDir = process.env.BYCLI_CONFIG_DIR;
    process.env.BYCLI_CONFIG_DIR = baseDir;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const onTraceExport = vi.fn();
    const closeWindow = vi.fn().mockResolvedValue(undefined);
    const mockPage = {
      closeWindow,
      startNetworkCapture: vi.fn().mockResolvedValue(true),
      readNetworkCapture: vi.fn().mockResolvedValue([]),
      consoleMessages: vi.fn().mockResolvedValue([]),
      snapshot: vi.fn().mockResolvedValue('snapshot'),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png').toString('base64')),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.com'),
      getActivePage: vi.fn().mockReturnValue('tab-1'),
    } as any;

    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn) => fn(mockPage));

    try {
      const cmd = cli({
        site: 'test-execution',
        name: 'browser-trace-success', access: 'read',
        description: 'test trace export on success',
        browser: true,
        strategy: Strategy.PUBLIC,
        func: async () => [{ ok: true }],
      });

      await expect(executeCommand(cmd, {}, false, { trace: 'on', onTraceExport })).resolves.toEqual([{ ok: true }]);

      const stderr = stderrSpy.mock.calls.flat().join('\n');
      expect(stderr).toContain('byCLI trace artifact:');
      const tracesRoot = path.join(baseDir, 'profiles', 'default', 'traces');
      const traceId = fs.readdirSync(tracesRoot)[0];
      const receipt = JSON.parse(fs.readFileSync(path.join(tracesRoot, traceId, 'receipt.json'), 'utf-8'));
      expect(receipt.status).toBe('success');
      expect(receipt.traceDir).toContain(path.join(baseDir, 'profiles', 'default', 'traces'));
      expect(receipt.scope).toMatchObject({
        site: 'test-execution',
        command: 'test-execution/browser-trace-success',
      });
      expect(receipt.error).toBeUndefined();
      expect(onTraceExport).toHaveBeenCalledWith(expect.objectContaining({
        traceId,
        receipt: expect.objectContaining({ status: 'success' }),
      }));
      expect(closeWindow).toHaveBeenCalledTimes(1);
    } finally {
      if (prevConfigDir === undefined) delete process.env.BYCLI_CONFIG_DIR;
      else process.env.BYCLI_CONFIG_DIR = prevConfigDir;
      stderrSpy.mockRestore();
      fs.rmSync(baseDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });

  it('keeps the original adapter error when trace export fails', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-exec-trace-fail-'));
    const blockedPath = path.join(baseDir, 'not-a-dir');
    fs.writeFileSync(blockedPath, 'file');
    const prevConfigDir = process.env.BYCLI_CONFIG_DIR;
    process.env.BYCLI_CONFIG_DIR = blockedPath;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const mockPage = {
      closeWindow: vi.fn().mockResolvedValue(undefined),
      startNetworkCapture: vi.fn().mockResolvedValue(true),
      readNetworkCapture: vi.fn().mockResolvedValue([]),
      consoleMessages: vi.fn().mockResolvedValue([]),
      snapshot: vi.fn().mockResolvedValue('snapshot'),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('png').toString('base64')),
      getCurrentUrl: vi.fn().mockResolvedValue('https://example.com'),
      getActivePage: vi.fn().mockReturnValue('tab-1'),
    } as any;

    vi.spyOn(capRouting, 'shouldUseBrowserSession').mockReturnValue(true);
    vi.spyOn(runtime, 'browserSession').mockImplementation(async (_Factory, fn) => fn(mockPage));

    try {
      const cmd = cli({
        site: 'test-execution',
        name: 'browser-trace-export-fails', access: 'read',
        description: 'test trace export failure handling',
        browser: true,
        strategy: Strategy.PUBLIC,
        func: async () => { throw new Error('adapter failure'); },
      });

      await expect(executeCommand(cmd, {}, false, { trace: 'retain-on-failure' })).rejects.toThrow('adapter failure');
      expect(stderrSpy.mock.calls.flat().join('\n')).toContain('[trace] Failed to export trace artifact');
    } finally {
      if (prevConfigDir === undefined) delete process.env.BYCLI_CONFIG_DIR;
      else process.env.BYCLI_CONFIG_DIR = prevConfigDir;
      stderrSpy.mockRestore();
      fs.rmSync(baseDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});
