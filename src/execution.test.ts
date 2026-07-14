import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CliCommand, InternalCliCommand } from './registry.js';
import { executeCommand, prepareCommandArgs } from './execution.js';
import { ArgumentError, CliError, TimeoutError, toEnvelope } from './errors.js';
import { cli, getRegistry, registerCommand, Strategy } from './registry.js';
import { withTimeoutMs } from './runtime.js';
import * as runtime from './runtime.js';
import * as capRouting from './capabilityRouting.js';
import { clearAllHooks, onAfterExecute, onBeforeExecute, type HookContext } from './hooks.js';

describe('executeCommand — conditional browser routing', () => {
  it('keeps ordinary static manifest commands on the lazy run path', async () => {
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
      expect(funcTracker).toHaveBeenCalledWith({}, false);
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
      writeVersion(2);
      const future = new Date(Date.now() + 2_000);
      fs.utimesSync(modulePath, future, future);
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

      await expect(executeCommand(placeholder, {})).resolves.toBe('fresh');
      rejectOld(new Error('stale import failed'));
      await expect(staleExecution).rejects.toMatchObject({ code: 'ADAPTER_LOAD' });
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
      ],
      _lazy: true, _modulePath: modulePath, _hydrateBeforeBrowserRouting: true,
    };
    registerCommand(placeholder);
    const browserSessionSpy = vi.spyOn(runtime, 'browserSession');

    try {
      await executeCommand(placeholder, { limit: '3' });

      expect(browserSessionSpy).not.toHaveBeenCalled();
      expect(resolverTracker).toHaveBeenCalledWith(expect.objectContaining({ 'auth-source': 'env', limit: 3 }));
      expect(funcTracker).toHaveBeenCalledWith(null, expect.objectContaining({ 'auth-source': 'env', limit: 3 }), false);
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
  site: ${JSON.stringify(site)}, name: 'list', access: 'read',
  browser: () => false,
  args: [{ name: 'auth-source', default: 'browser' }],
  validateArgs: args => globalThis.__schemaHydrateValidate(args),
  func: async () => [],
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
      await expect(executeCommand(placeholder, {})).rejects.toMatchObject({
        code: 'COMMAND_EXEC',
        message: expect.stringContaining('argument schema does not match'),
      });
      expect(validationTracker).not.toHaveBeenCalled();
      expect(sentinelPredicate).not.toHaveBeenCalled();
      expect(browserSessionSpy).not.toHaveBeenCalled();
    } finally {
      getRegistry().delete(key);
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
  strategy: Strategy.PUBLIC, browser: false, func: async () => [],
});
`);
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
        message: expect.stringContaining('valid hydrated conditional command'),
      });
      expect(sentinelPredicate).not.toHaveBeenCalled();
      expect(browserSessionSpy).not.toHaveBeenCalled();

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
