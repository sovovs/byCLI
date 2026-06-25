// M3 验收:page lease(ownership)+ stale page fail-fast + capture via daemon。
// 用真实 http server + fetch,但把 ctx.daemon.command 替换成可控 stub(不依赖主仓 daemon)。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import type { DaemonCommandInput, DaemonCommandResult } from '../src/transport/daemonBridge.js';

const cfg = loadConfig({
  RECORDER_TOKEN: 'test-token-1234567890-abcdef',
  LOG_LEVEL: 'error', // quiet structured-request logs in test output
  RECORDER_ALLOWED_ORIGINS: 'http://127.0.0.1:8000',
  BYCLI_DAEMON_PORT: '6553',
  RECORDER_MAX_ACTIVE_SESSIONS: '10', // schema 封顶 10;用例间靠 afterEach cancelSession 释放,避免累加撞顶
});

const { server, ctx } = createApp(cfg);
let base = '';

// 可控 daemon stub:每个用例改写 nextResult / 记录 calls
let nextResult: DaemonCommandResult = { ok: true, data: {} };
let nextHighLevel: DaemonCommandResult = { ok: true, data: {} };
let nextGet: DaemonCommandResult = { ok: true, data: {} };
let calls: DaemonCommandInput[] = [];
const highLevelCalls: Array<{ path: string; body: unknown }> = [];
const getCalls: string[] = [];
// 默认 stub:返回 nextResult。某些用例(analyze)会临时替换 ctx.daemon.command 成
// per-action switch,beforeEach 必须还原,否则替换会泄漏到后续用例(串扰)。
const defaultCommand = async (cmd: DaemonCommandInput) => { calls.push(cmd); return nextResult; };
ctx.daemon.command = defaultCommand;
ctx.daemon.highLevel = async (path, body) => { highLevelCalls.push({ path, body }); return nextHighLevel; };
ctx.daemon.highLevelGet = async (path) => { getCalls.push(path); return nextGet; };

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { calls = []; nextResult = { ok: true, data: {} }; highLevelCalls.length = 0; nextHighLevel = { ok: true, data: {} }; getCalls.length = 0; nextGet = { ok: true, data: {} }; ctx.daemon.command = defaultCommand; });

const auth = {
  'X-Recorder': '1',
  'X-byCLI-Token': cfg.TOKEN,
  'X-CSRF-Token': ctx.vault.csrfToken,
  'Content-Type': 'application/json',
  Origin: 'http://127.0.0.1:8000',
};
const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
const get = (path: string) =>
  fetch(`${base}${path}`, { headers: { 'X-Recorder': '1', 'X-byCLI-Token': cfg.TOKEN, 'X-CSRF-Token': ctx.vault.csrfToken, Origin: 'http://127.0.0.1:8000' } });

/** 建一个已 bound 的 session,返回 sessionId。 */
async function boundSession(): Promise<string> {
  const r = await post('/recorder/session/bind', { mode: 'bind_existing_page', contextId: 'ctx-a', targetId: 'page-0' });
  return (await r.json()).data.sessionId;
}

describe('M3 · navigate (page ownership)', () => {
  it('navigate 成功 → 绑定 daemon 返回的 page + 态 page_ready', async () => {
    const sid = await boundSession();
    nextResult = { ok: true, data: { page: 'page-42', url: 'https://example.com/', title: 'Example' } };
    const res = await post('/recorder/navigate', { sessionId: sid, url: 'https://example.com' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.state).toBe('page_ready');
    expect(body.data.page).toBe('page-42');
    // page ownership 写回 session
    expect(ctx.registry.getSession(sid)?.targetId).toBe('page-42');
    // 确实经 daemon navigate
    expect(calls[0]).toMatchObject({ action: 'navigate', url: 'https://example.com', contextId: 'ctx-a' });
  });

  it('stale page → fail-fast:page_lost 使会话 failed,不重试', async () => {
    const sid = await boundSession();
    nextResult = { ok: false, errorCode: 'page_lost', error: 'tab closed' };
    const res = await post('/recorder/navigate', { sessionId: sid, url: 'https://example.com' });
    expect((await res.json()).error.code).toBe('page_lost');
    expect(ctx.registry.getSession(sid)?.state).toBe('failed');
    expect(calls).toHaveLength(1); // 不重试
  });

  it('daemon 不可达 → daemon_unavailable + fail-fast', async () => {
    const sid = await boundSession();
    nextResult = { ok: false, errorCode: 'daemon_unavailable', error: 'unreachable' };
    const res = await post('/recorder/navigate', { sessionId: sid, url: 'https://example.com' });
    expect((await res.json()).error.code).toBe('daemon_unavailable');
    expect(ctx.registry.getSession(sid)?.state).toBe('failed');
  });

  it('未知 session → request_not_found(不触 daemon)', async () => {
    const res = await post('/recorder/navigate', { sessionId: 'nope', url: 'https://example.com' });
    expect((await res.json()).error.code).toBe('request_not_found');
    expect(calls).toHaveLength(0);
  });

  it('缺 url → validation_failed', async () => {
    const sid = await boundSession();
    const res = await post('/recorder/navigate', { sessionId: sid });
    expect((await res.json()).error.code).toBe('validation_failed');
  });
});

describe('M3 · capture (复用 page lease)', () => {
  async function navigatedSession(): Promise<string> {
    const sid = await boundSession();
    nextResult = { ok: true, data: { page: 'page-7' } };
    await post('/recorder/navigate', { sessionId: sid, url: 'https://example.com' });
    return sid;
  }

  it('capture/start 复用 page,态 capture_a', async () => {
    const sid = await navigatedSession();
    nextResult = { ok: true, data: {} };
    const res = await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
    const body = await res.json();
    expect(body.data.state).toBe('capture_a');
    expect(calls.at(-1)).toMatchObject({ action: 'network-capture-start', page: 'page-7' });
  });

  it('capture/read 返回 entries', async () => {
    const sid = await navigatedSession();
    await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
    nextResult = { ok: true, data: [{ url: 'https://api.example.com/x', method: 'GET' }] };
    const res = await post('/recorder/capture/read', { sessionId: sid, sampleName: 'A' });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.entries).toHaveLength(1);
    expect(calls.at(-1)).toMatchObject({ action: 'network-capture-read', page: 'page-7' });
  });

  it('无 page lease(未 navigate)→ page_lost', async () => {
    const sid = await boundSession();
    // bound 时给了 targetId page-0,先清掉模拟无 lease
    ctx.registry.setPage(sid, null);
    const res = await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
    expect((await res.json()).error.code).toBe('page_lost');
  });
});

describe('M4 · rank (frozen A/B samples via shared core engine)', () => {
  // drive a session through navigate → capture A → capture B → capture_b state.
  async function capturedSession(): Promise<string> {
    const sid = await boundSession();
    nextResult = { ok: true, data: { page: 'page-9' } };
    await post('/recorder/navigate', { sessionId: sid, url: 'https://x.com' });
    // sample A: start (page_ready→capture_a) + read (stores frozen sample A)
    nextResult = { ok: true, data: {} };
    await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
    nextResult = { ok: true, data: [jsonListEntry('cat')] };
    await post('/recorder/capture/read', { sessionId: sid, sampleName: 'A' });
    // sample B: start (capture_a→capture_b) + read (stores frozen sample B)
    nextResult = { ok: true, data: {} };
    await post('/recorder/capture/start', { sessionId: sid, sampleName: 'B', trigger: 'user_manual' });
    nextResult = { ok: true, data: [jsonListEntry('dog')] };
    await post('/recorder/capture/read', { sessionId: sid, sampleName: 'B' });
    return sid;
  }
  function jsonListEntry(kw: string) {
    return {
      requestId: `net_${kw}`, method: 'GET', url: `https://x.com/api/search?keyword=${kw}`,
      responseStatus: 200, responseContentType: 'application/json',
      responsePreview: JSON.stringify([{ title: 't', url: 'u' }]), startedAt: 0, durationMs: 50,
    };
  }

  it('rank 读冻结 A/B 样本 → ranked + candidates(经共享包 rankSamples)', async () => {
    const sid = await capturedSession();
    const res = await post('/recorder/rank', { sessionId: sid });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.state).toBe('ranked');
    expect(Array.isArray(body.data.candidates)).toBe(true);
    expect(body.data.candidates.length).toBeGreaterThan(0);
    expect(body.data.candidates[0].endpoint.pathname).toBe('/api/search');
  });

  it('rank from 非 capture_b → invalid_state', async () => {
    const sid = await boundSession(); // 仍在 session_bound
    const res = await post('/recorder/rank', { sessionId: sid });
    expect((await res.json()).error.code).toBe('invalid_state');
  });
});

describe('M5a · analyze (signals via /command + pure analyzeSite)', () => {
  async function navigatedSession(): Promise<string> {
    const sid = await boundSession();
    nextResult = { ok: true, data: { page: 'page-az' } };
    await post('/recorder/navigate', { sessionId: sid, url: 'https://x.com' });
    return sid;
  }

  // 轮询 analyze 的 202 请求到 terminal,返回 report(registry result)。
  async function pollAnalyzeReport(requestId: string): Promise<any> {
    for (let i = 0; i < 50; i++) {
      const body = await (await get(`/recorder/requests/${requestId}`)).json();
      const st = body.data;
      if (st.status === 'succeeded') return st.result;
      if (st.status === 'failed' || st.status === 'timeout' || st.status === 'cancelled') {
        throw new Error(`analyze ${st.status}: ${JSON.stringify(st.error)}`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('analyze poll timeout');
  }

  it('analyze 经 /command 收 signals → 202 + 轮询 requests/{id} 得 AnalyzeReport(纯 analyzeSite)', async () => {
    const sid = await navigatedSession();
    // per-action stub for the analyze step sequence.
    ctx.daemon.command = async (cmd) => {
      calls.push(cmd);
      switch (cmd.action) {
        case 'network-capture-start': return { ok: true, data: {} };
        case 'navigate': return { ok: true, data: { page: 'page-az' } };
        case 'exec': return { ok: true, data: { cookieNames: ['sid'], initialState: { __INITIAL_STATE__: false, __NUXT__: false, __NEXT_DATA__: false, __APOLLO_STATE__: false }, title: 'X', finalUrl: 'https://x.com/home' } };
        case 'cookies': return { ok: true, data: [{ name: 'sid' }, { name: 'cf_clearance' }] };
        case 'network-capture-read': return { ok: true, data: [{ url: 'https://x.com/api/list', responseStatus: 200, responseContentType: 'application/json', responsePreview: '[{"a":1}]' }] };
        default: return { ok: true, data: {} };
      }
    };
    // analyze 是独立 202 异步(05:67):先收 202 + canonical requestId,再轮询
    // GET /recorder/requests/{id} 到 terminal 取 report(后台 runAnalyze 写 registry)。
    const accepted = await post('/recorder/analyze', { sessionId: sid, url: 'https://x.com' });
    expect(accepted.status).toBe(202);
    const requestId = (await accepted.json()).requestId;
    expect(requestId).toBeTruthy();

    const report = await pollAnalyzeReport(requestId);
    expect(report.final_url).toBe('https://x.com/home');
    // cf_clearance cookie → cloudflare anti-bot detected by pure analyzeSite
    expect(report.anti_bot.detected).toBe(true);
    expect(report.pattern.pattern).toBe('A'); // 1 json response
  });

  it('analyze 无 page lease → page_lost', async () => {
    const sid = await boundSession();
    ctx.registry.setPage(sid, null);
    const res = await post('/recorder/analyze', { sessionId: sid, url: 'https://x.com' });
    expect((await res.json()).error.code).toBe('page_lost');
  });
});

describe('M5b · init (select-only,接 rank 候选 → daemon /v1/init)', () => {
  // each init case runs a full navigate→capture→rank flow (a fresh session); release
  // them after each case so the active-session count stays under the cap (schema max 10).
  const initSids: string[] = [];
  afterEach(() => { for (const s of initSids) ctx.registry.cancelSession(s); initSids.length = 0; });

  // rank first so candidates are frozen on the session; return [sid, candidateId].
  // Inlined capture→rank flow (capturedSession is scoped to the M4 rank block).
  async function rankedSessionWithCandidate(): Promise<[string, string]> {
    const sid = await boundSession();
    initSids.push(sid);
    nextResult = { ok: true, data: { page: 'page-init' } };
    await post('/recorder/navigate', { sessionId: sid, url: 'https://x.com' });
    const entry = (kw: string) => ({
      requestId: `net_${kw}`, method: 'GET', url: `https://x.com/api/search?keyword=${kw}`,
      responseStatus: 200, responseContentType: 'application/json',
      responsePreview: JSON.stringify([{ title: 't', url: 'u' }]), startedAt: 0, durationMs: 50,
    });
    nextResult = { ok: true, data: {} };
    await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
    nextResult = { ok: true, data: [entry('cat')] };
    await post('/recorder/capture/read', { sessionId: sid, sampleName: 'A' });
    nextResult = { ok: true, data: {} };
    await post('/recorder/capture/start', { sessionId: sid, sampleName: 'B', trigger: 'user_manual' });
    nextResult = { ok: true, data: [entry('dog')] };
    await post('/recorder/capture/read', { sessionId: sid, sampleName: 'B' });
    const rank = await (await post('/recorder/rank', { sessionId: sid })).json();
    return [sid, rank.data.candidates[0].id];
  }

  it('init 用 selectedCandidateId → 服务端派生 + 转发 daemon /v1/init', async () => {
    const [sid, candidateId] = await rankedSessionWithCandidate();
    nextHighLevel = { ok: true, data: { report: { adapterPath: '~/.bycli/clis/hn/top.js', reportPath: '/r.json', warnings: [], responsibleUseAcknowledgedAt: 0, releaseChannel: 'stable', localExperimentProfile: 'off', configSnapshotVersion: 1 }, dryRun: { exists: false, changedLines: null } } };
    const res = await post('/recorder/init', { sessionId: sid, name: 'hn/top', selectedCandidateId: candidateId, writePolicy: 'dry-run' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.report.adapterPath).toContain('hn/top.js');
    expect(highLevelCalls.at(-1)?.path).toBe('/v1/init');
    // be 派生后转发:domain 来自候选 endpoint.host,不含客户端 free-form
    const sent = highLevelCalls.at(-1)?.body as Record<string, unknown>;
    expect(sent).not.toHaveProperty('endpoint');
    expect(sent).not.toHaveProperty('columns');
    // H-002: writePolicy wire literal 为连字符 dry-run,原样转发
    expect(sent.writePolicy).toBe('dry-run');
  });

  it('init writePolicy=dry_run(下划线)→ validation_failed(H-002 不触 daemon)', async () => {
    const [sid, candidateId] = await rankedSessionWithCandidate();
    const res = await post('/recorder/init', { sessionId: sid, name: 'hn/top', selectedCandidateId: candidateId, writePolicy: 'dry_run' });
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(highLevelCalls).toHaveLength(0);
  });

  it('init 缺 selectedCandidateId → validation_failed(select-only,不触 daemon)', async () => {
    const [sid] = await rankedSessionWithCandidate();
    const res = await post('/recorder/init', { sessionId: sid, name: 'hn/top', writePolicy: 'dry-run' });
    expect((await res.json()).error.code).toBe('validation_failed');
    const before = highLevelCalls.length;
    expect(before).toBe(0);
  });

  it('init 未知 selectedCandidateId → validation_failed', async () => {
    const [sid] = await rankedSessionWithCandidate();
    const res = await post('/recorder/init', { sessionId: sid, name: 'hn/top', selectedCandidateId: 'nope', writePolicy: 'dry-run' });
    expect((await res.json()).error.code).toBe('validation_failed');
  });

  it('init 缺 name → validation_failed(不触 daemon)', async () => {
    const res = await post('/recorder/init', {});
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(highLevelCalls).toHaveLength(0);
  });

  it('init daemon 报 responsible_use_required(writePolicy=write 无 ack)→ 透传', async () => {
    const [sid, candidateId] = await rankedSessionWithCandidate();
    nextHighLevel = { ok: false, errorCode: 'responsible_use_required', error: 'responsibleUseAcknowledgedAt required' };
    const res = await post('/recorder/init', { sessionId: sid, name: 'hn/top', selectedCandidateId: candidateId, writePolicy: 'write' });
    expect((await res.json()).error.code).toBe('responsible_use_required');
  });
});

describe('M6 · verify (202 + request lifecycle + canonical requestId)', () => {
  let vSids: string[] = [];
  beforeEach(() => { vSids = []; });
  afterEach(() => { for (const s of vSids) ctx.registry.cancelSession(s); });

  // Build a session in `draft_created` (bind→nav→A/B capture→rank→init write), so verify is legal.
  async function draftCreatedSession(): Promise<string> {
    const sid = await boundSession();
    vSids.push(sid);
    nextResult = { ok: true, data: { page: 'page-v' } };
    await post('/recorder/navigate', { sessionId: sid, url: 'https://x.com' });
    const entry = (kw: string) => ({
      requestId: `net_${kw}`, method: 'GET', url: `https://x.com/api/search?keyword=${kw}`,
      responseStatus: 200, responseContentType: 'application/json',
      responsePreview: JSON.stringify([{ title: 't', url: 'u' }]), startedAt: 0, durationMs: 50,
    });
    nextResult = { ok: true, data: {} };
    await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
    nextResult = { ok: true, data: [entry('cat')] };
    await post('/recorder/capture/read', { sessionId: sid, sampleName: 'A' });
    nextResult = { ok: true, data: {} };
    await post('/recorder/capture/start', { sessionId: sid, sampleName: 'B', trigger: 'user_manual' });
    nextResult = { ok: true, data: [entry('dog')] };
    await post('/recorder/capture/read', { sessionId: sid, sampleName: 'B' });
    const rank = await (await post('/recorder/rank', { sessionId: sid })).json();
    const candidateId = rank.data.candidates[0].id;
    // init write advances ranked→draft_created (dry-run would not).
    nextHighLevel = { ok: true, data: { report: { adapterPath: '~/.bycli/clis/hn/top.js' }, dryRun: { exists: false, changedLines: null } } };
    await post('/recorder/init', { sessionId: sid, name: 'hn/top', selectedCandidateId: candidateId, writePolicy: 'write', responsibleUseAcknowledgedAt: 1 });
    return sid;
  }

  it('verify → 202 + canonical requestId(顶层)+ 推进 verifying;daemon 收到同一 id', async () => {
    const sid = await draftCreatedSession();
    nextHighLevel = { ok: true, data: { requestId: 'daemon-echo-ignored' } };
    const res = await post('/recorder/verify', { sessionId: sid, name: 'hn/top', executionSeedArgs: { keyword: '张三' } });
    const body = await res.json();
    expect(res.status).toBe(202);
    expect(body.requestId).toMatch(/^req_/);       // canonical id on the envelope top level
    expect(body.data.state).toBe('verifying');
    expect(ctx.registry.getSession(sid)?.state).toBe('verifying');
    const sent = highLevelCalls.at(-1);
    expect(sent?.path).toBe('/v1/verify');
    expect((sent?.body as Record<string, unknown>).requestId).toBe(body.requestId); // same canonical id down to daemon
  });

  it('verify 缺 name → validation_failed(不触 daemon)', async () => {
    const res = await post('/recorder/verify', { sessionId: 'x' });
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(highLevelCalls).toHaveLength(0);
  });

  it('verify 缺 sessionId → validation_failed(不触 daemon)', async () => {
    const res = await post('/recorder/verify', { name: 'hn/top' });
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(highLevelCalls).toHaveLength(0);
  });

  it('verify 非 draft_created(刚 bound)→ invalid_state(不触 daemon)', async () => {
    const sid = await boundSession();
    vSids.push(sid);
    const res = await post('/recorder/verify', { sessionId: sid, name: 'hn/top' });
    expect((await res.json()).error.code).toBe('invalid_state');
    expect(highLevelCalls.filter((c) => c.path === '/v1/verify')).toHaveLength(0);
  });

  it('verify daemon runner_protocol_error → 透传 + 不进 verifying', async () => {
    const sid = await draftCreatedSession();
    nextHighLevel = { ok: false, errorCode: 'runner_protocol_error', error: 'verify runner failed' };
    const res = await post('/recorder/verify', { sessionId: sid, name: 'hn/top' });
    expect((await res.json()).error.code).toBe('runner_protocol_error');
    expect(ctx.registry.getSession(sid)?.state).toBe('draft_created');
  });

  it('GET /recorder/requests/{id}:verify 进行中 → running + pollAfterMs', async () => {
    const sid = await draftCreatedSession();
    nextHighLevel = { ok: true, data: {} };
    const requestId = (await (await post('/recorder/verify', { sessionId: sid, name: 'hn/top' })).json()).requestId;
    nextGet = { ok: true, data: { requestId, status: 'running', result: null } };
    const body = (await (await get(`/recorder/requests/${requestId}`)).json()).data;
    expect(body.status).toBe('running');
    expect(body.pollAfterMs).toBeGreaterThan(0);
  });

  it('GET 终态 succeeded → session done + VerifySummary + 缓存(再查不打 daemon)', async () => {
    const sid = await draftCreatedSession();
    nextHighLevel = { ok: true, data: {} };
    const requestId = (await (await post('/recorder/verify', { sessionId: sid, name: 'hn/top' })).json()).requestId;
    nextGet = { ok: true, data: { requestId, status: 'succeeded', result: { ok: true, rows: 3, fieldCount: 1 } } };
    const body = (await (await get(`/recorder/requests/${requestId}`)).json()).data;
    expect(body.status).toBe('succeeded');
    expect(body.result.rows).toBe(3);
    expect(ctx.registry.getSession(sid)?.state).toBe('done');
    const callsBefore = getCalls.length;
    await get(`/recorder/requests/${requestId}`); // second poll hits the be cache
    expect(getCalls.length).toBe(callsBefore);
  });

  it('GET 终态 failed → session failed', async () => {
    const sid = await draftCreatedSession();
    nextHighLevel = { ok: true, data: {} };
    const requestId = (await (await post('/recorder/verify', { sessionId: sid, name: 'hn/top' })).json()).requestId;
    nextGet = { ok: true, data: { requestId, status: 'failed', result: { ok: false, error: { code: 'adapter_runtime_error', message: 'boom' } } } };
    const body = (await (await get(`/recorder/requests/${requestId}`)).json()).data;
    expect(body.status).toBe('failed');
    expect(ctx.registry.getSession(sid)?.state).toBe('failed');
  });

  it('GET 未知 requestId → request_not_found', async () => {
    const res = await get('/recorder/requests/req_nope');
    expect((await res.json()).error.code).toBe('request_not_found');
  });
});
