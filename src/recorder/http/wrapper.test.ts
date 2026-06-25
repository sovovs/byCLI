// M9a tests — High-Level HTTP wrapper shell:gate(X-byCLI + Origin + token)、init 202+poll、
// request status ownership + TTL、loopback config。驱动真实 createWrapperApp(node:http server),
// 用 node:http 原始请求(undici fetch 禁设 Origin,原始 http 才能测 Origin 门禁);init 注入 fake
// createDraft(不写盘)。
import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
import { createWrapperApp, drainInflight, type WrapperDeps } from './wrapper-server.js';
import { httpStatusForHighLevel } from './wrapper-envelope.js';
import { WrapperRegistry } from './wrapper-registry.js';
import { loadWrapperConfig } from './wrapper-config.js';
import type { WrapperConfig } from './wrapper-config.js';
import type { createAdapterDraft } from '../highlevel/init.js';

const TOKEN = 'test-token-1234567890';

function makeCfg(over: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    HOST: '127.0.0.1',
    PORT: 0,
    ALLOWED_ORIGINS: [],
    TOKEN,
    DAEMON_PORT: 19825,
    LOG_LEVEL: 'error',
    REQUEST_TERMINAL_STATUS_TTL_MS: 1_800_000,
    REQUEST_POLL_AFTER_MS: 1000,
    REQUEST_WAIT_MS_MAX: 25_000,
    BODY_LIMIT_BYTES: 262_144,
    ANALYZE_TIMEOUT_MS: 30_000,
    ...over,
  } as WrapperConfig;
}

const okDraft = (() => ({
  ok: true,
  report: {
    adapterPath: '/x.js',
    reportPath: '/x-report.json',
    warnings: [],
    responsibleUseAcknowledgedAt: 0,
    releaseChannel: 'stable',
    localExperimentProfile: 'off',
    configSnapshotVersion: 1,
  },
  dryRun: { kind: 'create', preview: '' },
})) as unknown as typeof createAdapterDraft;

const failDraft = (code: 'validation_failed' | 'responsible_use_required', reason: string) =>
  (() => ({ ok: false, errorCode: code, reason })) as unknown as typeof createAdapterDraft;

// Fake RunnerPortWithLifecycle for verify tests — exercises the real verifyAdapter (name validate +
// HMAC evidence derivation) while stubbing the subprocess. onStart captures the input (seed-leak test);
// startThrow forces startVerify rejections; status drives getRunStatus projection.
type FakeRunnerOpts = {
  onStart?: (input: Record<string, unknown>) => void;
  startThrow?: { code?: string; message?: string };
  status?: { status: string; summary: unknown } | null;
};
function makeFakeRunner(opts: FakeRunnerOpts): NonNullable<WrapperDeps['runner']> {
  const fallback = { status: 'succeeded', summary: { ok: true, stage: 'execute', fieldCount: 1 } };
  return {
    startVerify: async (input: Record<string, unknown>) => {
      opts.onStart?.(input);
      if (opts.startThrow) {
        const e = new Error(opts.startThrow.message ?? 'fail');
        if (opts.startThrow.code) (e as { code?: string }).code = opts.startThrow.code;
        throw e;
      }
      return { requestId: (input.requestId as string) ?? 'gen' };
    },
    getVerifyStatus: async () => null,
    cancelVerify: async () => ({ cancelled: false }),
    // resolve immediately so handleVerify 的后台收尾(#1)能 finalize;值不重要(收尾读 getRunStatus)。
    whenSettled: () => Promise.resolve(('status' in opts ? opts.status?.summary : fallback.summary) ?? null),
    activeCount: () => 0,
    queuedCount: () => 0,
    getRunStatus: () => ('status' in opts ? opts.status : fallback),
  } as unknown as NonNullable<WrapperDeps['runner']>;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function start(cfg: WrapperConfig, deps: WrapperDeps = {}): Promise<number> {
  const { server } = createWrapperApp(cfg, deps);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

interface Resp { status: number; json: any }
function call(port: number, method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port, method, path, headers: opts.headers ?? {} }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }));
    });
    r.on('error', reject);
    if (opts.body !== undefined) r.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    r.end();
  });
}

const auth = (token: string = TOKEN): Record<string, string> => ({ 'X-byCLI': '1', 'X-byCLI-Token': token });

describe('M9a wrapper — gate (X-byCLI + Origin + token)', () => {
  it('missing X-byCLI header → 403 auth_failed', async () => {
    const port = await start(makeCfg());
    const r = await call(port, 'GET', '/health');
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('auth_failed');
  });

  it('X-byCLI present but missing token → 403', async () => {
    const port = await start(makeCfg());
    const r = await call(port, 'GET', '/health', { headers: { 'X-byCLI': '1' } });
    expect(r.status).toBe(403);
  });

  it('wrong token → 403', async () => {
    const port = await start(makeCfg());
    const r = await call(port, 'GET', '/health', { headers: { 'X-byCLI': '1', 'X-byCLI-Token': 'nope' } });
    expect(r.status).toBe(403);
  });

  it('all three present → 200', async () => {
    const port = await start(makeCfg());
    const r = await call(port, 'GET', '/health', { headers: auth() });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('ok');
  });

  it('disallowed Origin → 403 even with valid header+token', async () => {
    const port = await start(makeCfg());
    const r = await call(port, 'GET', '/health', { headers: { ...auth(), Origin: 'http://evil.example' } });
    expect(r.status).toBe(403);
  });

  it('allowlisted Origin → 200', async () => {
    const port = await start(makeCfg({ ALLOWED_ORIGINS: ['http://127.0.0.1:8000'] }));
    const r = await call(port, 'GET', '/health', { headers: { ...auth(), Origin: 'http://127.0.0.1:8000' } });
    expect(r.status).toBe(200);
  });
});

describe('M9a wrapper — init 202 + poll', () => {
  it('valid init → 202 + requestId; poll → succeeded with report', async () => {
    const port = await start(makeCfg(), { createDraft: okDraft });
    const acc = await call(port, 'POST', '/v1/adapters/init', { headers: auth(), body: { name: 'site/cmd', domain: 'x.com', strategy: 'PUBLIC' } });
    expect(acc.status).toBe(202);
    expect(acc.json.schemaVersion).toBe('high-level.v1');
    expect(acc.json.requestId).toMatch(/^req_/);
    const st = await call(port, 'GET', `/v1/requests/${acc.json.requestId}`, { headers: auth() });
    expect(st.status).toBe(200);
    expect(st.json.type).toBe('init');
    expect(st.json.status).toBe('succeeded');
    expect(st.json.result.report.adapterPath).toBe('/x.js');
  });

  it('missing name → 202; poll → failed validation_failed', async () => {
    const port = await start(makeCfg(), { createDraft: okDraft });
    const acc = await call(port, 'POST', '/v1/adapters/init', { headers: auth(), body: {} });
    expect(acc.status).toBe(202);
    const st = await call(port, 'GET', `/v1/requests/${acc.json.requestId}`, { headers: auth() });
    expect(st.json.status).toBe('failed');
    expect(st.json.error.code).toBe('validation_failed');
  });

  it('write without responsibleUseAcknowledgedAt → poll failed responsible_use_required', async () => {
    const port = await start(makeCfg(), { createDraft: failDraft('responsible_use_required', 'ack required') });
    const acc = await call(port, 'POST', '/v1/adapters/init', { headers: auth(), body: { name: 'site/cmd', domain: 'x.com', strategy: 'COOKIE', writePolicy: 'write' } });
    const st = await call(port, 'GET', `/v1/requests/${acc.json.requestId}`, { headers: auth() });
    expect(st.json.status).toBe('failed');
    expect(st.json.error.code).toBe('responsible_use_required');
  });
});

describe('M9a wrapper — request status ownership + TTL', () => {
  it('unknown requestId → 404 request_not_found', async () => {
    const port = await start(makeCfg());
    const r = await call(port, 'GET', '/v1/requests/req_doesnotexist', { headers: auth() });
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('request_not_found');
  });

  it('terminal record expires after TTL → 404', async () => {
    let clock = 1_000_000;
    const port = await start(makeCfg({ REQUEST_TERMINAL_STATUS_TTL_MS: 60_000 }), { createDraft: okDraft, now: () => clock });
    const acc = await call(port, 'POST', '/v1/adapters/init', { headers: auth(), body: { name: 'site/cmd', domain: 'x.com', strategy: 'PUBLIC' } });
    const id = acc.json.requestId;
    // before TTL: present
    const before = await call(port, 'GET', `/v1/requests/${id}`, { headers: auth() });
    expect(before.status).toBe(200);
    // advance past TTL
    clock += 60_001;
    const after = await call(port, 'GET', `/v1/requests/${id}`, { headers: auth() });
    expect(after.status).toBe(404);
    expect(after.json.error.code).toBe('request_not_found');
  });
});

describe('M9b wrapper — verify (202 + runner 代理 + seed 不泄漏)', () => {
  const VERIFY = (port: number, body: unknown) =>
    call(port, 'POST', '/v1/adapters/verify', { headers: auth(), body });
  const POLL = (port: number, id: string) => call(port, 'GET', `/v1/requests/${id}`, { headers: auth() });

  it('valid verify → 202; poll → succeeded with summary (runner-proxied)', async () => {
    const runner = makeFakeRunner({ status: { status: 'succeeded', summary: { ok: true, stage: 'execute', fieldCount: 1 } } });
    const port = await start(makeCfg(), { runner, sessionKeyFor: () => 'k' });
    const acc = await VERIFY(port, { name: 'site/cmd' });
    expect(acc.status).toBe(202);
    expect(acc.json.requestId).toMatch(/^req_/);
    const st = await POLL(port, acc.json.requestId);
    expect(st.status).toBe(200);
    expect(st.json.type).toBe('verify');
    expect(st.json.status).toBe('succeeded');
    expect(st.json.result.ok).toBe(true);
    expect(st.json.result.fieldCount).toBe(1);
  });

  it('runner queue_full → poll failed queue_full', async () => {
    const runner = makeFakeRunner({ startThrow: { code: 'queue_full', message: 'full' } });
    const port = await start(makeCfg(), { runner, sessionKeyFor: () => 'k' });
    const acc = await VERIFY(port, { name: 'site/cmd' });
    const st = await POLL(port, acc.json.requestId);
    expect(st.json.status).toBe('failed');
    expect(st.json.error.code).toBe('queue_full');
  });

  it('generic runner failure → runner_protocol_error', async () => {
    const runner = makeFakeRunner({ startThrow: { message: 'boom' } });
    const port = await start(makeCfg(), { runner, sessionKeyFor: () => 'k' });
    const acc = await VERIFY(port, { name: 'site/cmd' });
    const st = await POLL(port, acc.json.requestId);
    expect(st.json.status).toBe('failed');
    expect(st.json.error.code).toBe('runner_protocol_error');
  });

  it('bad adapter name → validation_failed (runner never started)', async () => {
    let started = false;
    const runner = makeFakeRunner({ onStart: () => { started = true; } });
    const port = await start(makeCfg(), { runner, sessionKeyFor: () => 'k' });
    const acc = await VERIFY(port, { name: 'noslash' });
    const st = await POLL(port, acc.json.requestId);
    expect(st.json.status).toBe('failed');
    expect(st.json.error.code).toBe('validation_failed');
    expect(started).toBe(false);
  });

  it('in-flight running status projected from runner', async () => {
    const runner = makeFakeRunner({ status: { status: 'running', summary: null } });
    const port = await start(makeCfg(), { runner, sessionKeyFor: () => 'k' });
    const acc = await VERIFY(port, { name: 'site/cmd' });
    const st = await POLL(port, acc.json.requestId);
    expect(st.json.status).toBe('running');
  });

  it('async terminal failure projects summary.error to top-level RequestStatus.error (Codex M9 Med)', async () => {
    const runner = makeFakeRunner({ status: { status: 'failed', summary: { ok: false, stage: 'execute', error: { code: 'adapter_runtime_error', message: 'boom' } } } });
    const port = await start(makeCfg(), { runner, sessionKeyFor: () => 'k' });
    const acc = await VERIFY(port, { name: 'site/cmd' });
    const st = await POLL(port, acc.json.requestId);
    expect(st.json.status).toBe('failed');
    expect(st.json.error.code).toBe('adapter_runtime_error'); // top-level error (was null before the fix)
    expect(st.json.result.error.code).toBe('adapter_runtime_error'); // summary still carries the detail
  });

  it('raw executionSeedArgs never leaks to 202/status/logs — only reaches runner', async () => {
    const CANARY = 'CANARY-7Q9Z-secret-value';
    let captured: Record<string, unknown> | null = null;
    const logs: string[] = [];
    const runner = makeFakeRunner({
      onStart: (i) => { captured = i; },
      status: { status: 'succeeded', summary: { ok: true, stage: 'execute', fieldCount: 1 } },
    });
    const port = await start(makeCfg({ LOG_LEVEL: 'info' }), { runner, sessionKeyFor: () => 'k', logSink: (l) => logs.push(l) });
    const acc = await VERIFY(port, { name: 'site/cmd', executionSeedArgs: { password: CANARY } });
    expect(JSON.stringify(acc.json)).not.toContain(CANARY); // 202 body clean
    const st = await POLL(port, acc.json.requestId);
    expect(JSON.stringify(st.json)).not.toContain(CANARY); // RequestStatus/summary clean
    expect(logs.join('\n')).not.toContain(CANARY); // structured logs clean
    // proves the raw seed DID reach the runner (input.json responsibility), not silently dropped:
    expect((captured as any)?.rawSeedArgs?.password).toBe(CANARY);
    // and the HMAC evidence carries NO raw value:
    expect(JSON.stringify((captured as any)?.evidenceSeedArgs)).not.toContain(CANARY);
  });
});

describe('M9c wrapper — analyze (202 + 后台 daemon-backed Page)', () => {
  const fakeAnalyze = (impl: (input: { url: string; session: string; contextId: string; settleMs?: number }) => Promise<unknown>): NonNullable<WrapperDeps['analyzeRunner']> =>
    impl as unknown as NonNullable<WrapperDeps['analyzeRunner']>;
  const POST = (port: number, body: unknown) => call(port, 'POST', '/v1/browser/analyze', { headers: auth(), body });
  // analyze 后台异步 finalize → poll 用 waitMs long-poll 等终态
  const POLL = (port: number, id: string) => call(port, 'GET', `/v1/requests/${id}?waitMs=2000`, { headers: auth() });
  const REQ = { url: 'https://example.com', session: 'sess-1', contextId: 'ctx-1' };

  it('valid analyze → 202; poll → succeeded with report', async () => {
    const analyzeRunner = fakeAnalyze(async (i) => ({ requestedUrl: i.url, pattern: 'A', confidence: 'high' }));
    const port = await start(makeCfg(), { analyzeRunner });
    const acc = await POST(port, REQ);
    expect(acc.status).toBe(202);
    expect(acc.json.requestId).toMatch(/^req_/);
    const st = await POLL(port, acc.json.requestId);
    expect(st.status).toBe(200);
    expect(st.json.type).toBe('analyze');
    expect(st.json.status).toBe('succeeded');
    expect(st.json.result.pattern).toBe('A');
  });

  it('daemon unavailable → poll failed daemon_unavailable', async () => {
    const analyzeRunner = fakeAnalyze(async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:19825'), { code: 'daemon_unavailable' }); });
    const port = await start(makeCfg(), { analyzeRunner });
    const acc = await POST(port, REQ);
    const st = await POLL(port, acc.json.requestId);
    expect(st.json.status).toBe('failed');
    expect(st.json.error.code).toBe('daemon_unavailable');
  });

  it('analyze timeout → poll status timeout / analyze_timeout', async () => {
    const analyzeRunner = fakeAnalyze(async () => { throw Object.assign(new Error('analyze timed out after 30000ms'), { code: 'analyze_timeout' }); });
    const port = await start(makeCfg(), { analyzeRunner });
    const acc = await POST(port, REQ);
    const st = await POLL(port, acc.json.requestId);
    expect(st.json.status).toBe('timeout');
    expect(st.json.error.code).toBe('analyze_timeout');
  });

  it('missing required fields → failed validation_failed (runner never called)', async () => {
    let called = false;
    const analyzeRunner = fakeAnalyze(async () => { called = true; return {}; });
    const port = await start(makeCfg(), { analyzeRunner });
    const acc = await POST(port, { url: 'https://example.com' }); // no session/contextId
    expect(acc.status).toBe(202);
    const st = await POLL(port, acc.json.requestId);
    expect(st.json.status).toBe('failed');
    expect(st.json.error.code).toBe('validation_failed');
    expect(called).toBe(false);
  });
});

describe('M9 review fixes — registry 生命周期', () => {
  // #1: verify 即便客户端从不轮询,也要在 runner settle 时后台 finalize(否则卡 running + 泄漏)。
  it('verify finalizes in background WITHOUT any GET poll (no stuck-running leak)', async () => {
    const runner = makeFakeRunner({ status: { status: 'succeeded', summary: { ok: true, stage: 'execute', fieldCount: 1 } } });
    const { server, ctx } = createWrapperApp(makeCfg(), { runner, sessionKeyFor: () => 'k' });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const acc = await call(port, 'POST', '/v1/adapters/verify', { headers: auth(), body: { name: 'site/cmd' } });
    const id = acc.json.requestId;
    // 等后台 whenSettled().then 跑完(微任务+一拍);全程不调 GET /v1/requests
    await new Promise((r) => setTimeout(r, 30));
    const rec = ctx.registry.getRecord(id);
    expect(rec?.status).toBe('succeeded'); // 后台已收尾,非靠轮询
  });

  // shutdown drain:在飞 analyze 被追踪进 ctx.inflight,settle 后移除;drain 等它们(或超 grace)。
  it('analyze background job is tracked in inflight and removed on settle', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const analyzeRunner = (async () => { await gate; return { pattern: 'A' }; }) as unknown as NonNullable<WrapperDeps['analyzeRunner']>;
    const { server, ctx } = createWrapperApp(makeCfg(), { analyzeRunner });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    await call(port, 'POST', '/v1/browser/analyze', { headers: auth(), body: { url: 'https://x.com', session: 's', contextId: 'c' } });
    expect(ctx.inflight.size).toBe(1); // tracked while the background Page work runs
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.inflight.size).toBe(0); // removed on settle (drain would have nothing to wait for)
  });

  it('drainInflight waits for jobs, but gives up after the grace window', async () => {
    expect(await drainInflight(new Set(), 1000)).toBeUndefined(); // empty → immediate
    const done: boolean[] = [];
    const quick = new Set<Promise<unknown>>();
    const j = new Promise<void>((r) => setTimeout(() => { done.push(true); r(); }, 15));
    quick.add(j);
    await drainInflight(quick, 1000);
    expect(done).toEqual([true]); // waited for the job
    const t0 = Date.now();
    await drainInflight(new Set<Promise<unknown>>([new Promise(() => {})]), 30); // job never resolves
    expect(Date.now() - t0).toBeLessThan(500); // returned at grace, not hung
  });

  // #2: 周期 sweep 回收已过 TTL 的终态记录(getRecord 只在访问时删)。
  it('sweepExpired removes terminal records past TTL', () => {
    let clock = 1_000_000;
    const reg = new WrapperRegistry({ terminalTtlMs: 60_000, pollAfterMs: 1000, now: () => clock });
    reg.createRequest({ requestId: 'a', type: 'init' });
    reg.createRequest({ requestId: 'b', type: 'init' });
    reg.createRequest({ requestId: 'c', type: 'verify', runnerId: 'c' }); // 留 running(不 finalize)
    reg.finalizeRequest('a', { status: 'succeeded' });
    reg.finalizeRequest('b', { status: 'failed' });
    clock += 60_001; // 过 TTL
    expect(reg.sweepExpired()).toBe(2); // a,b 终态过期被清;c 仍 running(expiresAt=null)不动
    // 不经 getRecord 访问也已删:再 sweep 为 0,且 c 仍在
    expect(reg.sweepExpired()).toBe(0);
    expect(reg.getRecord('c')?.status).toBe('running');
  });
});

describe('M9 wrapper — /metrics loopback (M8 复审遗留)', () => {
  it('gated like other endpoints (no token → 403)', async () => {
    const port = await start(makeCfg());
    const r = await call(port, 'GET', '/metrics');
    expect(r.status).toBe(403);
  });

  it('scrapes counters + duration histogram; no token leaks', async () => {
    const port = await start(makeCfg());
    // generate traffic: one failed (no auth) + one ok health
    await call(port, 'GET', '/health');
    await call(port, 'GET', '/health', { headers: auth() });
    const r = await call(port, 'GET', '/metrics', { headers: auth() });
    expect(r.status).toBe(200);
    const counters: Record<string, number> = r.json.counters;
    const keys = Object.keys(counters);
    expect(keys.some((k) => /highlevel_requests_total\{.*status=ok/.test(k))).toBe(true);
    expect(keys.some((k) => /highlevel_requests_total\{.*errorCode=auth_failed/.test(k))).toBe(true);
    expect(r.json.histograms['highlevel_request_duration_ms'].count).toBeGreaterThanOrEqual(2);
    // /metrics scrape itself is not counted (skipped in finish-logger)
    expect(keys.some((k) => k.includes('highlevel.metrics'))).toBe(false);
    // no secret in the snapshot
    expect(JSON.stringify(r.json)).not.toContain(TOKEN);
  });
});

describe('M9 wrapper — STATUS_BY_CODE 关键码钉值(防 be↔wrapper 传输映射 drift,Codex Q2 复核建议)', () => {
  // 03 章 Error Mapping 表的关键码;两份传输映射(be envelope + wrapper envelope)必须保持值一致。
  it('maps key ErrorCodes to canonical HTTP status', () => {
    expect(httpStatusForHighLevel('validation_failed')).toBe(400);
    expect(httpStatusForHighLevel('responsible_use_required')).toBe(400);
    expect(httpStatusForHighLevel('auth_failed')).toBe(403);
    expect(httpStatusForHighLevel('feature_disabled')).toBe(403);
    expect(httpStatusForHighLevel('request_not_found')).toBe(404);
    expect(httpStatusForHighLevel('idempotency_conflict')).toBe(409);
    expect(httpStatusForHighLevel('queue_full')).toBe(429);
    expect(httpStatusForHighLevel('daemon_unavailable')).toBe(503);
    expect(httpStatusForHighLevel('verify_timeout')).toBe(504);
    expect(httpStatusForHighLevel('analyze_timeout')).toBe(504);
    expect(httpStatusForHighLevel('temp_store_full')).toBe(507);
  });
});

describe('M9a wrapper — loopback config', () => {
  it('default PORT is 19827, HOST 127.0.0.1', () => {
    const cfg = loadWrapperConfig({});
    expect(cfg.PORT).toBe(19827);
    expect(cfg.HOST).toBe('127.0.0.1');
    expect(cfg.TOKEN.length).toBeGreaterThanOrEqual(16); // auto-generated
  });

  it('non-loopback HOST override is rejected (fail-closed)', () => {
    expect(() => loadWrapperConfig({ BYCLI_HIGHLEVEL_HOST: '0.0.0.0' })).toThrow(/loopback-only/);
  });

  it('too-short TOKEN is rejected', () => {
    expect(() => loadWrapperConfig({ BYCLI_HIGHLEVEL_TOKEN: 'short' })).toThrow(/config_invalid/);
  });
});
