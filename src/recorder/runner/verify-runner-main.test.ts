import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  executeAdapterForVerify, runVerifyRunner, loadAdapterByName,
  setActiveLeaseCleanup, releaseActiveLease, type BrowserAdapterRunner, type RunnerInput,
} from './verify-runner-main.js';
import { cli, type CliCommand } from '../../registry.js';
import { ArgumentError } from '../../errors.js';
import type { RunnerEvent } from '@sovovs/bycli-recorder-core';

const baseInput = (over: Partial<RunnerInput> = {}): RunnerInput => ({
  requestId: 'req_test', name: 'demo/search', adapterPath: '/unused', ...over,
});

describe('executeAdapterForVerify (validate + run, M6a non-browser + M6b browser)', () => {
  it('runs a non-browser adapter and reports rows + fieldCount', async () => {
    const command = { site: 'demo', name: 'search', access: 'read', browser: false,
      args: [], func: async () => [{ title: 'a' }, { title: 'b' }] } as unknown as CliCommand;
    const r = await executeAdapterForVerify(command, { name: 'demo/search', fixture: 'ignore', seedArgs: {} });
    expect(r.ok).toBe(true);
    expect(r.data.stage).toBe('execute');
    expect(r.data.rows).toBe(2);
    expect(r.data.fieldCount).toBe(1); // count only, never key names (Codex M7c)
    expect(r.data.fixture).toEqual({ status: 'ignored' });
  });

  it('passes seed args through to the adapter func', async () => {
    let received: unknown;
    const command = { site: 'demo', name: 'search', access: 'read', browser: false,
      args: [], func: async (args: unknown) => { received = args; return [{ q: 'x' }]; } } as unknown as CliCommand;
    await executeAdapterForVerify(command, { name: 'demo/search', seedArgs: { keyword: '张三' } });
    expect(received).toEqual({ keyword: '张三' });
  });

  it('evaluates a conditional resolver once and runs its function with null when the seed selects no browser', async () => {
    const resolver = vi.fn((args: Record<string, unknown>) => args['auth-source'] !== 'env');
    const func = vi.fn(async (_page: unknown, _args: Record<string, unknown>, _debug?: boolean) => []);
    const browserRunner = vi.fn<BrowserAdapterRunner>();
    const command = cli({
      site: 'verify-conditional', name: 'env', access: 'read',
      browser: resolver,
      args: [
        { name: 'auth-source', default: 'env', choices: ['browser', 'env'] },
        { name: 'limit', type: 'int' },
      ],
      func,
    });

    const r = await executeAdapterForVerify(command, {
      name: 'verify-conditional/env', seedArgs: { limit: '5' }, browserRunner,
    });

    expect(r.ok).toBe(true);
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith({ 'auth-source': 'env', limit: 5 });
    expect(browserRunner).not.toHaveBeenCalled();
    expect(func).toHaveBeenCalledWith(null, { 'auth-source': 'env', limit: 5 }, false);
    expect(func.mock.calls[0]?.[1]).toBe(resolver.mock.calls[0]?.[0]);
  });

  it('evaluates a conditional resolver once and runs its function with a page through browserRunner', async () => {
    const resolver = vi.fn((args: Record<string, unknown>) => args['browser-enabled'] === true);
    const func = vi.fn(async (_page: unknown, _args: Record<string, unknown>, _debug?: boolean) => []);
    const mockPage = { marker: 'page' } as any;
    let runnerArgs: Record<string, unknown> | undefined;
    const browserRunner: BrowserAdapterRunner = vi.fn(async (browserCommand, opts) => {
      runnerArgs = opts.seedArgs;
      return browserCommand.func!(mockPage, opts.seedArgs, false);
    });
    const command = cli({
      site: 'verify-conditional', name: 'browser', access: 'read',
      browser: resolver,
      args: [
        { name: 'auth-source', default: 'browser', choices: ['browser', 'env'] },
        { name: 'browser-enabled', type: 'boolean' },
      ],
      func,
    });

    const r = await executeAdapterForVerify(command, {
      name: 'verify-conditional/browser', seedArgs: { 'browser-enabled': 'true' }, browserRunner,
    });

    expect(r.ok).toBe(true);
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith({ 'auth-source': 'browser', 'browser-enabled': true });
    expect(browserRunner).toHaveBeenCalledOnce();
    expect(runnerArgs).toBe(resolver.mock.calls[0]?.[0]);
    expect(func).toHaveBeenCalledWith(mockPage, { 'auth-source': 'browser', 'browser-enabled': true }, false);
  });

  it('preserves a typed conditional resolver error code in the verify envelope', async () => {
    const command = cli({
      site: 'verify-conditional', name: 'typed-error', access: 'read',
      browser: () => { throw new ArgumentError('bad auth-source'); },
      func: async () => [],
    });

    const r = await executeAdapterForVerify(command, { name: 'verify-conditional/typed-error', seedArgs: {} });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'ARGUMENT', message: 'bad auth-source' });
  });

  it('classifies an unknown conditional resolver failure as an adapter runtime error', async () => {
    const command = cli({
      site: 'verify-conditional', name: 'unknown-error', access: 'read',
      browser: () => { throw new Error('predicate bug'); },
      func: async () => [],
    });

    const r = await executeAdapterForVerify(command, { name: 'verify-conditional/unknown-error', seedArgs: {} });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'adapter_runtime_error', message: 'predicate bug' });
  });

  it('returns the typed argument envelope when seed argument preparation fails', async () => {
    const resolver = vi.fn(() => false);
    const func = vi.fn(async () => []);
    const command = cli({
      site: 'verify-conditional', name: 'invalid-seed', access: 'read',
      browser: resolver,
      args: [{ name: 'limit', type: 'int' }],
      func,
    });

    const r = await executeAdapterForVerify(command, {
      name: 'verify-conditional/invalid-seed', seedArgs: { limit: 'not-a-number' },
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'ARGUMENT' });
    expect(resolver).not.toHaveBeenCalled();
    expect(func).not.toHaveBeenCalled();
  });

  it('browser adapter → runs via injected browserRunner (M6b), reports rows + fieldCount', async () => {
    // The runner owns the Page; the adapter func must NOT be called directly here.
    const command = { site: 'demo', name: 'x', access: 'read', browser: true,
      args: [], func: async () => { throw new Error('func must go through the page-bearing browserRunner'); } } as unknown as CliCommand;
    let seen: { seedArgs: Record<string, unknown>; contextId?: string; preNavUrl: string | null } | undefined;
    const browserRunner = async (_cmd: unknown, o: { seedArgs: Record<string, unknown>; contextId?: string; preNavUrl: string | null }) => { seen = o; return [{ title: 'a' }, { title: 'b' }]; };
    const r = await executeAdapterForVerify(command, { name: 'demo/x', seedArgs: { q: 'hi' }, browserRunner });
    expect(r.ok).toBe(true);
    expect(r.data.rows).toBe(2);
    expect(r.data.fieldCount).toBe(1); // count only, never key names (Codex M7c)
    expect(seen?.seedArgs).toEqual({ q: 'hi' });
  });

  it('string navigateBefore → preNavUrl passed to runner; true/undefined → null', async () => {
    const mk = (navigateBefore: unknown) => ({ site: 'demo', name: 'x', access: 'read', browser: true, args: [], navigateBefore,
      func: async () => [] } as unknown as CliCommand);
    let preNavUrl: string | null | undefined;
    const browserRunner = async (_c: unknown, o: { preNavUrl: string | null }) => { preNavUrl = o.preNavUrl; return []; };
    await executeAdapterForVerify(mk('https://demo.com/feed'), { name: 'demo/x', seedArgs: {}, browserRunner });
    expect(preNavUrl).toBe('https://demo.com/feed');
    await executeAdapterForVerify(mk(true), { name: 'demo/x', seedArgs: {}, browserRunner });
    expect(preNavUrl).toBeNull();
    await executeAdapterForVerify(mk(undefined), { name: 'demo/x', seedArgs: {}, browserRunner });
    expect(preNavUrl).toBeNull();
  });

  it('passes contextId through to the browserRunner', async () => {
    const command = { site: 'demo', name: 'x', access: 'read', browser: true, args: [], func: async () => [] } as unknown as CliCommand;
    let ctx: string | undefined = 'unset';
    const browserRunner = async (_c: unknown, o: { contextId?: string }) => { ctx = o.contextId; return []; };
    await executeAdapterForVerify(command, { name: 'demo/x', seedArgs: {}, contextId: 'work', browserRunner });
    expect(ctx).toBe('work');
  });

  it('omitted browser flag is treated as browser → goes through browserRunner', async () => {
    const command = { site: 'demo', name: 'x', access: 'read', args: [], func: async () => [] } as unknown as CliCommand;
    let called = false;
    const browserRunner = async () => { called = true; return [{ a: 1 }]; };
    const r = await executeAdapterForVerify(command, { name: 'demo/x', seedArgs: {}, browserRunner });
    expect(called).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('browser adapter error preserves its code (e.g. auth_required)', async () => {
    const command = { site: 'demo', name: 'x', access: 'read', browser: true, args: [], func: async () => [] } as unknown as CliCommand;
    const browserRunner = async () => { throw Object.assign(new Error('login'), { code: 'auth_required' }); };
    const r = await executeAdapterForVerify(command, { name: 'demo/x', seedArgs: {}, browserRunner });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('auth_required');
      expect(r.data.stage).toBe('execute');
    }
  });

  it('missing command (not found after load) → runner_protocol_error', async () => {
    const r = await executeAdapterForVerify(undefined, { name: 'demo/missing', seedArgs: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('runner_protocol_error');
      expect(r.error.message).toContain('not found');
    }
  });

  it('adapter func throwing a plain error → adapter_runtime_error', async () => {
    const command = { site: 'demo', name: 'x', access: 'read', browser: false,
      args: [], func: async () => { throw new Error('boom'); } } as unknown as CliCommand;
    const r = await executeAdapterForVerify(command, { name: 'demo/x', seedArgs: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('adapter_runtime_error');
      expect(r.error.message).toBe('boom');
    }
  });

  it('adapter func throwing an error WITH a code preserves that code (e.g. auth_required)', async () => {
    const command = { site: 'demo', name: 'x', access: 'read', browser: false,
      args: [], func: async () => { throw Object.assign(new Error('login'), { code: 'auth_required' }); } } as unknown as CliCommand;
    const r = await executeAdapterForVerify(command, { name: 'demo/x', seedArgs: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('auth_required');
  });

  it('update fixture policy → fixture.status updated', async () => {
    const command = { site: 'demo', name: 'x', access: 'read', browser: false, args: [], func: async () => [] } as unknown as CliCommand;
    const r = await executeAdapterForVerify(command, { name: 'demo/x', fixture: 'update', seedArgs: {} });
    expect(r.data.fixture).toEqual({ status: 'updated' });
  });
});

describe('runVerifyRunner (orchestration: started → exactly one result)', () => {
  it('emits started then a success result for a non-browser adapter', async () => {
    const events: RunnerEvent[] = [];
    const command = { site: 'demo', name: 'search', access: 'read', browser: false,
      args: [], func: async () => [{ title: 'a' }] } as unknown as CliCommand;
    await runVerifyRunner(baseInput(), (e) => events.push(e), async () => command);

    expect(events[0].type).toBe('started');
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1); // one and only one terminal result
    expect(results[0]).toMatchObject({ type: 'result', ok: true, requestId: 'req_test' });
  });

  it('a load failure becomes a single terminal result (never throws)', async () => {
    const events: RunnerEvent[] = [];
    await runVerifyRunner(baseInput(), (e) => events.push(e), async () => { throw new Error('cannot import'); });

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false });
    if (results[0].type === 'result') expect(results[0].error?.code).toBe('adapter_runtime_error');
  });

  it('Codex M7c #4: redacts an adapter-evaluation load error, keeps a runner-side one verbatim', async () => {
    // tagged by loadAdapterByName: the adapter module threw on import → message may echo adapter-file contents
    const ev1: RunnerEvent[] = [];
    await runVerifyRunner(baseInput(), (e) => ev1.push(e),
      async () => { throw Object.assign(new Error('boom token=sk-LIVE-9 from adapter source'), { adapterEvaluation: true }); });
    const r1 = ev1.find((e) => e.type === 'result');
    if (r1?.type === 'result') {
      expect(r1.error?.message).not.toContain('sk-LIVE-9'); // adapter-controlled → redacted
      expect(r1.error?.code).toBe('adapter_runtime_error');
    }
    expect(JSON.stringify(ev1)).not.toContain('sk-LIVE-9');

    // untagged = runner-side resolve failure → verbatim for debuggability
    const ev2: RunnerEvent[] = [];
    await runVerifyRunner(baseInput(), (e) => ev2.push(e), async () => { throw new Error('ENOENT: no such adapter path'); });
    const r2 = ev2.find((e) => e.type === 'result');
    if (r2?.type === 'result') expect(r2.error?.message).toContain('ENOENT');
  });

  it('does not leak raw seed args into emitted events', async () => {
    const events: RunnerEvent[] = [];
    const command = { site: 'demo', name: 'search', access: 'read', browser: false,
      args: [], func: async () => [{ title: 'a' }] } as unknown as CliCommand;
    await runVerifyRunner(baseInput({ executionSeedArgs: { secret: 'TOPSECRET-TOKEN' } }),
      (e) => events.push(e), async () => command);
    expect(JSON.stringify(events)).not.toContain('TOPSECRET-TOKEN');
  });

  it('threads the injected browserRunner through to a browser adapter (M6b)', async () => {
    const events: RunnerEvent[] = [];
    const command = { site: 'demo', name: 'x', access: 'read', browser: true, args: [], func: async () => [] } as unknown as CliCommand;
    let called = false;
    const browserRunner = async () => { called = true; return [{ title: 'a' }]; };
    await runVerifyRunner(baseInput({ name: 'demo/x' }), (e) => events.push(e), async () => command, browserRunner);
    expect(called).toBe(true);
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true });
  });

  it('threads contextId from input.json into the browserRunner (M6b)', async () => {
    const command = { site: 'demo', name: 'x', access: 'read', browser: true, args: [], func: async () => [] } as unknown as CliCommand;
    let ctx: string | undefined = 'unset';
    const browserRunner = async (_c: unknown, o: { contextId?: string }) => { ctx = o.contextId; return []; };
    await runVerifyRunner(baseInput({ name: 'demo/x', contextId: 'profileA' }), () => {}, async () => command, browserRunner);
    expect(ctx).toBe('profileA');
  });
});

describe('loadAdapterByName (real dynamic import + registry lookup)', () => {
  const fixturePath = fileURLToPath(new URL('./__fixtures__/nonbrowser-adapter.mjs', import.meta.url));
  const browserFixturePath = fileURLToPath(new URL('./__fixtures__/browser-adapter.mjs', import.meta.url));

  it('imports a real adapter file (cli() side-effect) and finds it by name', async () => {
    const cmd = await loadAdapterByName(fixturePath, 'smokefix/echo');
    expect(cmd).toBeDefined();
    expect(cmd!.browser).toBe(false);
  });

  it('imports the real browser fixture → browser:true (M6b smoke adapter)', async () => {
    const cmd = await loadAdapterByName(browserFixturePath, 'm6bsmoke/probe');
    expect(cmd).toBeDefined();
    expect(cmd!.browser).toBe(true); // routes through the browser branch / connect-back
  });

  it('end-to-end: load → execute the real fixture adapter', async () => {
    const cmd = await loadAdapterByName(fixturePath, 'smokefix/echo');
    const r = await executeAdapterForVerify(cmd, { name: 'smokefix/echo', seedArgs: { q: 'hi' } });
    expect(r.ok).toBe(true);
    expect(r.data.rows).toBe(1);
    expect(r.data.fieldCount).toBe(1); // count only, never key names (Codex M7c)
  });
});

describe('lease cleanup on signal / watchdog (Codex #4)', () => {
  it('releaseActiveLease runs the registered cleanup once, then clears it', async () => {
    let calls = 0;
    setActiveLeaseCleanup(async () => { calls += 1; });
    await releaseActiveLease();
    expect(calls).toBe(1);
    await releaseActiveLease(); // already cleared → no-op (the signal + watchdog both call this)
    expect(calls).toBe(1);
  });

  it('the disposer clears the cleanup so a completed run leaves nothing to release', async () => {
    let calls = 0;
    const dispose = setActiveLeaseCleanup(async () => { calls += 1; });
    dispose(); // browser runner's finally already closed the window
    await releaseActiveLease();
    expect(calls).toBe(0);
  });

  it('releaseActiveLease is bounded — a hung cleanup does not block exit', async () => {
    setActiveLeaseCleanup(() => new Promise<void>(() => { /* never resolves */ }));
    await releaseActiveLease(20); // resolves via the timeout race, not the hung cleanup
    await releaseActiveLease();   // cleared
  });
});
