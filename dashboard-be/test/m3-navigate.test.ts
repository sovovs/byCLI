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
    // 确实经 daemon navigate;投屏一体化:录制命令带 windowMode:'background'(不抢焦点)
    expect(calls[0]).toMatchObject({ action: 'navigate', url: 'https://example.com', contextId: 'ctx-a', windowMode: 'background' });
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

  it('首次 navigate(无 page lease)→ tabs op:new 开**新标签页** + 绑定新 tab 的 targetId', async () => {
    // 真实前端 client.bind 不传 targetId → 会话无 page lease
    const sid = (await (await post('/recorder/session/bind', { mode: 'bind_existing_page', contextId: 'ctx-new' })).json()).data.sessionId;
    expect(ctx.registry.getSession(sid)?.targetId).toBeNull();
    nextResult = { ok: true, data: { url: 'https://example.com/' }, page: 'tab-new-1' };
    const body = await (await post('/recorder/navigate', { sessionId: sid, url: 'https://example.com' })).json();
    expect(body.data.state).toBe('page_ready');
    // 关键:开新 tab(tabs op:new),不是导航当前页(navigate);带 windowMode:'background'(投屏不抢焦点)
    expect(calls[0]).toMatchObject({ action: 'tabs', op: 'new', url: 'https://example.com', contextId: 'ctx-new', windowMode: 'background' });
    expect(calls[0].page).toBeUndefined(); // 新建不带既有 page
    // 新 tab 的 targetId 绑为 page lease(供后续 capture 复用)
    expect(body.data.page).toBe('tab-new-1');
    expect(ctx.registry.getSession(sid)?.targetId).toBe('tab-new-1');
  });

  it('已有 page lease → 复用 navigate(在该 tab 内跳转,不再开新 tab)', async () => {
    const sid = await boundSession(); // 已带 targetId='page-0'
    nextResult = { ok: true, data: { page: 'page-0', url: 'https://e.com/' } };
    await post('/recorder/navigate', { sessionId: sid, url: 'https://e.com' });
    expect(calls[0]).toMatchObject({ action: 'navigate', page: 'page-0' });
    expect(calls[0].action).not.toBe('tabs');
  });
});

describe('M3 · capture (复用 page lease)', () => {
  async function navigatedSession(): Promise<string> {
    const sid = await boundSession();
    nextResult = { ok: true, data: { page: 'page-7' } };
    await post('/recorder/navigate', { sessionId: sid, url: 'https://example.com' });
    return sid;
  }

  it('capture/start 开窗但**不推进**状态(停在 page_ready,等用户操作)', async () => {
    const sid = await navigatedSession();
    nextResult = { ok: true, data: {} };
    const res = await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
    const body = await res.json();
    expect(body.data.state).toBe('page_ready'); // start 不再立即推进 capture_a
    expect(ctx.registry.getSession(sid)?.state).toBe('page_ready');
    // network-capture-start 发出(其后还跟一发 best-effort ui-capture-start,故不是 calls.at(-1))
    expect(calls.some((c) => c.action === 'network-capture-start' && c.page === 'page-7')).toBe(true);
    expect(calls.some((c) => c.action === 'ui-capture-start' && c.page === 'page-7')).toBe(true);
  });

  it('capture/read 冻结样本并**推进** page_ready→capture_a(「结束录制」)', async () => {
    const sid = await navigatedSession();
    await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
    nextResult = { ok: true, data: [{ url: 'https://api.example.com/x', method: 'GET' }] };
    const res = await post('/recorder/capture/read', { sessionId: sid, sampleName: 'A' });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.entries).toHaveLength(1);
    expect(body.data.state).toBe('capture_a'); // read 才推进
    // network-capture-read 发出(其后还有 best-effort screenshot,故不是 calls.at(-1))
    expect(calls.some((c) => c.action === 'network-capture-read' && c.page === 'page-7')).toBe(true);
  });

  it('B 录制:从 capture_a 重新 navigate 开**新标签页 b**(每次新开全新页面)', async () => {
    const sid = await navigatedSession(); // page-7
    await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
    nextResult = { ok: true, data: [{ url: 'https://api.example.com/x', method: 'GET' }] };
    await post('/recorder/capture/read', { sessionId: sid, sampleName: 'A' }); // → capture_a
    // 开始 B:navigate from capture_a → tabs op:new 开页面 b,绑新 lease
    calls.length = 0;
    nextResult = { ok: true, data: { url: 'https://example.com/' }, page: 'tab-b' };
    const nav = await (await post('/recorder/navigate', { sessionId: sid, url: 'https://example.com' })).json();
    expect(nav.data.state).toBe('page_ready');
    expect(calls[0]).toMatchObject({ action: 'tabs', op: 'new' }); // 新开 tab,不是原地 navigate
    expect(ctx.registry.getSession(sid)?.targetId).toBe('tab-b');
    // 结束 B:read 推进 → capture_b
    nextResult = { ok: true, data: {} };
    await post('/recorder/capture/start', { sessionId: sid, sampleName: 'B', trigger: 'user_manual' });
    nextResult = { ok: true, data: [{ url: 'https://api.example.com/y', method: 'GET' }] };
    const readB = await (await post('/recorder/capture/read', { sessionId: sid, sampleName: 'B' })).json();
    expect(readB.data.state).toBe('capture_b');
  });

  it('无 page lease(未 navigate)→ page_lost', async () => {
    const sid = await boundSession();
    // bound 时给了 targetId page-0,先清掉模拟无 lease
    ctx.registry.setPage(sid, null);
    const res = await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
    expect((await res.json()).error.code).toBe('page_lost');
  });

  it('capture/read 顺带抓页面截图存进样本(best-effort,base64)', async () => {
    const sid = await navigatedSession(); // page-7
    // per-action stub:network-capture-read 回 entries,screenshot 回 base64
    ctx.daemon.command = async (cmd) => {
      calls.push(cmd);
      if (cmd.action === 'screenshot') return { ok: true, data: 'BASE64JPEGDATA' };
      return { ok: true, data: [{ url: 'https://api.example.com/x', method: 'GET' }] };
    };
    await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
    await post('/recorder/capture/read', { sessionId: sid, sampleName: 'A' });
    expect(calls.some((c) => c.action === 'screenshot' && c.page === 'page-7')).toBe(true);
    expect(ctx.registry.getSamples(sid)?.A?.screenshot).toBe('BASE64JPEGDATA');
    expect(ctx.registry.getSamples(sid)?.A?.entries).toHaveLength(1);
  });

  it('capture/read 读回 UI 操作事件存进样本 actions 轨(M-UI-2)', async () => {
    const sid = await navigatedSession();
    ctx.daemon.command = async (cmd) => {
      calls.push(cmd);
      if (cmd.action === 'network-capture-read') return { ok: true, data: [{ url: 'https://api.example.com/x', method: 'GET' }] };
      if (cmd.action === 'ui-capture-read') return { ok: true, data: { events: [{ type: 'click', selector: '#go', tag: 'button' }], dropped: 2 } };
      return { ok: true, data: {} };
    };
    await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
    const body = await (await post('/recorder/capture/read', { sessionId: sid, sampleName: 'A' })).json();
    expect(body.ok).toBe(true);
    expect(body.data.actionsCount).toBe(1);
    expect(body.data.actionsDropped).toBe(2);
    expect(calls.some((c) => c.action === 'ui-capture-read' && c.page === 'page-7')).toBe(true);
    const actions = ctx.registry.getSamples(sid)?.A?.actions as Array<{ type: string }>;
    expect(actions?.[0]?.type).toBe('click');
  });

  it('截图失败不阻断录制(样本仍冻结,screenshot 缺省)', async () => {
    const sid = await navigatedSession();
    ctx.daemon.command = async (cmd) => {
      calls.push(cmd);
      if (cmd.action === 'screenshot') return { ok: false, errorCode: 'unsupported', error: 'no screenshot' };
      return { ok: true, data: [{ url: 'https://api.example.com/x', method: 'GET' }] };
    };
    await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
    const body = await (await post('/recorder/capture/read', { sessionId: sid, sampleName: 'A' })).json();
    expect(body.ok).toBe(true); // 录制不受截图失败影响
    expect(body.data.entries).toHaveLength(1);
    expect(ctx.registry.getSamples(sid)?.A?.screenshot).toBeUndefined();
  });

  it('seed 输入:命中 query 值 → 存 HMAC seedEvidence(raw seed 绝不落盘);rank 据此给 +20 seed→param', async () => {
    const sid = await navigatedSession();
    // 抓回的 entry 带 q=apple(seed 命中 q 参数);响应是 JSON array(+25 shape)。
    ctx.daemon.command = async (cmd) => {
      calls.push(cmd);
      if (cmd.action === 'network-capture-read') {
        return { ok: true, data: [{
          requestId: 'rq1', url: 'https://api.example.com/search?q=apple', method: 'GET',
          queryParams: { q: 'apple' }, response: { status: 200, mime: 'application/json', bodyShape: { kind: 'array', itemKeys: ['id', 'title'] } },
          sourceCompleteness: { responseBody: 'present' },
        }] };
      }
      return { ok: true, data: {} };
    };
    await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
    await post('/recorder/capture/read', { sessionId: sid, sampleName: 'A', seed: 'apple' });
    const sampleA = ctx.registry.getSamples(sid)?.A;
    // seedEvidence 以参数名 q 为 key,只含 HMAC/placeholder/length,绝无 raw "apple"。
    const ev = sampleA?.seedEvidence as Record<string, { hmac?: string; placeholder?: string }> | undefined;
    expect(ev && Object.keys(ev)).toContain('q');
    expect(ev?.q?.hmac).toBeTruthy();
    // raw seed 不进 seedEvidence(M7c);entries 里有 q=apple 是真实流量、用户本就可见,不在脱敏范围。
    expect(JSON.stringify(ev)).not.toContain('apple');
    // network-capture-read 命令本身不带 raw seed(只 be 内存用一瞬)。
    expect(JSON.stringify(calls)).not.toContain('apple');
  });

  it('seed 未命中任何 query 值 → 不构造 evidence(回退现状),raw seed 不落盘', async () => {
    const sid = await navigatedSession();
    ctx.daemon.command = async (cmd) => {
      calls.push(cmd);
      if (cmd.action === 'network-capture-read') {
        return { ok: true, data: [{ requestId: 'rq1', url: 'https://api.example.com/x', method: 'GET', queryParams: { page: '1' }, sourceCompleteness: { responseBody: 'present' } }] };
      }
      return { ok: true, data: {} };
    };
    await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
    await post('/recorder/capture/read', { sessionId: sid, sampleName: 'A', seed: 'mysecretquery' });
    const sampleA = ctx.registry.getSamples(sid)?.A;
    expect(sampleA?.seedEvidence).toBeUndefined();
    expect(JSON.stringify(sampleA)).not.toContain('mysecretquery');
    expect(JSON.stringify(calls)).not.toContain('mysecretquery');
  });
});

describe('一体化录制 · screenshot 投屏 + input 回传', () => {
  const sids: string[] = [];
  afterEach(() => { for (const s of sids) ctx.registry.cancelSession(s); sids.length = 0; });
  async function navigatedSession(): Promise<string> {
    const sid = await boundSession();
    sids.push(sid);
    nextResult = { ok: true, data: { page: 'page-9' } };
    await post('/recorder/navigate', { sessionId: sid, url: 'https://example.com' });
    return sid;
  }

  it('screenshot:转发 daemon screenshot(jpeg)→ 返回 base64 data', async () => {
    const sid = await navigatedSession();
    nextResult = { ok: true, data: 'BASE64JPEGDATA' };
    const res = await post('/recorder/screenshot', { sessionId: sid });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.data).toBe('BASE64JPEGDATA');
    expect(body.data.format).toBe('jpeg');
    const shot = calls.find((c) => c.action === 'screenshot');
    expect(shot?.format).toBe('jpeg');
    expect(shot?.page).toBe('page-9'); // 复用 page lease
  });

  it('screenshot:无 page lease → page_lost', async () => {
    const sid = (await (await post('/recorder/session/bind', { mode: 'bind_existing_page', contextId: 'ctx-shot' })).json()).data.sessionId;
    sids.push(sid);
    const res = await post('/recorder/screenshot', { sessionId: sid });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('page_lost');
  });

  it('input:Input.dispatchMouseEvent 转发 cdp passthrough(复用 page lease)', async () => {
    const sid = await navigatedSession();
    nextResult = { ok: true, data: {} };
    const res = await post('/recorder/input', {
      sessionId: sid, cdpMethod: 'Input.dispatchMouseEvent',
      cdpParams: { type: 'mousePressed', x: 100, y: 200, button: 'left', clickCount: 1 },
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.dispatched).toBe(true);
    const cdp = calls.find((c) => c.action === 'cdp');
    expect(cdp?.cdpMethod).toBe('Input.dispatchMouseEvent');
    expect(cdp?.page).toBe('page-9');
  });

  it('input:非白名单 CDP 方法 → validation_failed(不触 daemon)', async () => {
    const sid = await navigatedSession();
    calls = [];
    const res = await post('/recorder/input', { sessionId: sid, cdpMethod: 'Page.navigate', cdpParams: { url: 'https://evil.example' } });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('validation_failed');
    expect(calls.find((c) => c.action === 'cdp')).toBeUndefined(); // 未转发
  });

  it('input:无 page lease → page_lost', async () => {
    const sid = (await (await post('/recorder/session/bind', { mode: 'bind_existing_page', contextId: 'ctx-inp' })).json()).data.sessionId;
    sids.push(sid);
    const res = await post('/recorder/input', { sessionId: sid, cdpMethod: 'Input.dispatchKeyEvent', cdpParams: { type: 'keyDown', key: 'a' } });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('page_lost');
  });
});

describe('录制模式 · recordingMode 策略 + flag gate', () => {
  const sids: string[] = [];
  afterEach(() => { for (const s of sids) ctx.registry.cancelSession(s); sids.length = 0; });

  it('默认(不传 recordingMode)→ tab_projection / owned_tab(向后兼容)', async () => {
    const sid = (await (await post('/recorder/session/bind', { mode: 'bind_existing_page', contextId: 'ctx-rm1' })).json()).data.sessionId;
    sids.push(sid);
    const s = ctx.registry.getSession(sid)!;
    expect(s.recordingMode).toBe('tab_projection');
    expect(s.leaseKind).toBe('owned_tab');
  });

  it('embedded_iframe + flag off(默认)→ feature_disabled,不建会话', async () => {
    const before = [...(ctx.registry as unknown as { sessions: Map<string, unknown> }).sessions.keys()].length;
    const res = await post('/recorder/session/bind', { mode: 'bind_existing_page', contextId: 'ctx-rm2', recordingMode: 'embedded_iframe' });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('feature_disabled');
    const after = [...(ctx.registry as unknown as { sessions: Map<string, unknown> }).sessions.keys()].length;
    expect(after).toBe(before); // 未建会话
  });

  it('非法 recordingMode → validation_failed', async () => {
    const res = await post('/recorder/session/bind', { mode: 'bind_existing_page', contextId: 'ctx-rm3', recordingMode: 'bogus' });
    expect((await res.json()).error.code).toBe('validation_failed');
  });
});

describe('录制模式 · embedded_iframe(flag on)', () => {
  // 独立 app 实例,显式开 flag(模块级 ctx 的 cfg flag off,无法在用例内改)。
  const sids: string[] = [];
  let app2: ReturnType<typeof createApp>;
  let base2 = '';
  const auth2 = () => ({ 'X-Recorder': '1', 'X-byCLI-Token': cfg2.TOKEN, 'X-CSRF-Token': app2.ctx.vault.csrfToken, 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:8000' });
  const cfg2 = loadConfig({
    RECORDER_TOKEN: 'test-token-iframe-1234567890', LOG_LEVEL: 'error',
    RECORDER_ALLOWED_ORIGINS: 'http://127.0.0.1:8000', BYCLI_DAEMON_PORT: '6554',
    RECORDER_MAX_ACTIVE_SESSIONS: '10', FEATURE_EMBEDDED_IFRAME_RECORDING: '1',
  });
  beforeAll(async () => {
    app2 = createApp(cfg2);
    app2.ctx.daemon.command = async () => ({ ok: true, data: {} });
    await new Promise<void>((r) => app2.server.listen(0, '127.0.0.1', r));
    base2 = `http://127.0.0.1:${(app2.server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => app2.server.close(() => r())));
  afterEach(() => { for (const s of sids) app2.ctx.registry.cancelSession(s); sids.length = 0; });

  it('flag on → embedded_iframe 建会话(bound_dashboard_tab)', async () => {
    const res = await fetch(`${base2}/recorder/session/bind`, { method: 'POST', headers: auth2(), body: JSON.stringify({ mode: 'bind_existing_page', contextId: 'ctx-if', targetId: 'dashtab-1', recordingMode: 'embedded_iframe' }) });
    const body = await res.json();
    expect(body.ok).toBe(true);
    const s = app2.ctx.registry.getSession(body.data.sessionId)!;
    sids.push(body.data.sessionId);
    expect(s.recordingMode).toBe('embedded_iframe');
    expect(s.leaseKind).toBe('bound_dashboard_tab');
  });

  it('iframe 模式 navigate 是状态推进 no-op(→ page_ready,不开 tab)——页面由前端 iframe src 加载', async () => {
    const sid = (await (await fetch(`${base2}/recorder/session/bind`, { method: 'POST', headers: auth2(), body: JSON.stringify({ mode: 'bind_existing_page', contextId: 'ctx-if2', targetId: 'dashtab-2', recordingMode: 'embedded_iframe' }) })).json()).data.sessionId;
    sids.push(sid);
    const res = await fetch(`${base2}/recorder/navigate`, { method: 'POST', headers: auth2(), body: JSON.stringify({ sessionId: sid, url: 'https://juejin.cn' }) });
    const body = await res.json();
    // 推进到 page_ready(让 captureStart 可开窗),但不发任何 daemon tab/navigate 命令(bound dashboard tab)。
    expect(body.ok).toBe(true);
    expect(body.data.state).toBe('page_ready');
    expect(body.data.page).toBe('dashtab-2'); // page lease 仍是 bind 时绑的 dashboard tab,未变
  });

  it('embedded bind 发 daemon `bind` 绑 dashboard tab + 存目标 URL;captureRead 下发 targetFrameUrl 过滤噪音', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const orig = app2.ctx.daemon.command;
    app2.ctx.daemon.command = async (cmd: any) => {
      calls.push(cmd);
      if (cmd.action === 'bind') return { ok: true, page: 'dash-tab-99', data: {} };
      if (cmd.action === 'network-capture-read') return { ok: true, data: [] };
      return { ok: true, data: {} };
    };
    try {
      const sid = (await (await fetch(`${base2}/recorder/session/bind`, { method: 'POST', headers: auth2(), body: JSON.stringify({ mode: 'bind_existing_page', contextId: 'ctx-if3', url: 'https://juejin.cn/search', recordingMode: 'embedded_iframe' }) })).json()).data.sessionId;
      sids.push(sid);
      // bind 发了 daemon bind 命令,且 page lease = 返回的 dashboard tab
      expect(calls.some((c) => c.action === 'bind')).toBe(true);
      const s = app2.ctx.registry.getSession(sid)!;
      expect(s.targetId).toBe('dash-tab-99');
      expect(s.targetUrl).toBe('https://juejin.cn/search');
      // navigate(no-op)→ page_ready，再 captureStart 开窗
      await fetch(`${base2}/recorder/navigate`, { method: 'POST', headers: auth2(), body: JSON.stringify({ sessionId: sid, url: 'https://juejin.cn/search' }) });
      await fetch(`${base2}/recorder/capture/start`, { method: 'POST', headers: auth2(), body: JSON.stringify({ sessionId: sid, sampleName: 'A', trigger: 'user_manual' }) });
      calls.length = 0;
      await fetch(`${base2}/recorder/capture/read`, { method: 'POST', headers: auth2(), body: JSON.stringify({ sessionId: sid, sampleName: 'A' }) });
      const readCmd = calls.find((c) => c.action === 'network-capture-read')!;
      expect(readCmd.targetFrameUrl).toBe('https://juejin.cn/search');
    } finally {
      app2.ctx.daemon.command = orig;
    }
  });
});

describe('M4 · rank (frozen A/B samples via shared core engine)', () => {
  // drive a session through navigate → capture A → capture B → capture_b state.
  async function capturedSession(): Promise<string> {
    const sid = await boundSession();
    nextResult = { ok: true, data: { page: 'page-9' } };
    await post('/recorder/navigate', { sessionId: sid, url: 'https://x.com' });
    // sample A: start(开窗,停 page_ready)+ read(冻结样本 A,推进 page_ready→capture_a)
    nextResult = { ok: true, data: {} };
    await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
    nextResult = { ok: true, data: [jsonListEntry('cat')] };
    await post('/recorder/capture/read', { sessionId: sid, sampleName: 'A' });
    // sample B:先重新 navigate 开页面 b(capture_a→page_ready),再 start(开窗)+ read(冻结 B,推进 capture_b)
    nextResult = { ok: true, data: { page: 'page-9b' } };
    await post('/recorder/navigate', { sessionId: sid, url: 'https://x.com' });
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
    // B 录制:先重新 navigate 开页面 b(capture_a→page_ready),再 start+read
    nextResult = { ok: true, data: { page: 'page-init-b' } };
    await post('/recorder/navigate', { sessionId: sid, url: 'https://x.com' });
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
    // B 录制:先重新 navigate 开页面 b(capture_a→page_ready),再 start+read
    nextResult = { ok: true, data: { page: 'page-v-b' } };
    await post('/recorder/navigate', { sessionId: sid, url: 'https://x.com' });
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
