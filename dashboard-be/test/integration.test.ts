// 前端 httpRecorderClient(真实源码)↔ dashboard-be shell 集成测试(联调形态 ②)。
// 用 Node fetch 直接打 be,绕过浏览器 CORS,验证两端契约咬合。
// import 前端真实 client 源码(纯 import type,esbuild 擦除,无 window/别名运行时依赖)。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createLogger } from '../src/logger.js';
import { createMetrics } from '../src/metrics.js';
// 跨包引用前端 client 真实实现 —— 焊契约的关键:测的是 UI 实际会发的请求
import { createHttpRecorderClient } from '../../dashboard/src/services/httpRecorderClient';

const cfg = loadConfig({
  RECORDER_TOKEN: 'integration-token-1234567890',
  LOG_LEVEL: 'error', // quiet structured-request logs in test output
  RECORDER_ALLOWED_ORIGINS: 'http://127.0.0.1:8000',
  BYCLI_DAEMON_PORT: '6553', // 无人监听 → health 降级
});
const { server, ctx } = createApp(cfg);
let client: ReturnType<typeof createHttpRecorderClient>;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  client = createHttpRecorderClient({
    enabled: true,
    baseUrl: `http://127.0.0.1:${port}`,
    token: cfg.TOKEN,
    csrfToken: ctx.vault.csrfToken,
  });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('契约咬合:前端 client → be', () => {
  it('health:client 真实请求能拿到降级态', async () => {
    const res = await client.health();
    expect(res.ok).toBe(true);
    expect(res.data?.daemon).toBe('down');
  });

  it('bind(await_login):返回 awaitingLogin=true', async () => {
    const res = await client.bind('await_login');
    expect(res.ok).toBe(true);
    expect(res.data?.awaitingLogin).toBe(true);
    expect(res.data?.sessionId).toMatch(/^rec_/);
  });

  it('bind → confirmAuth 全链:client 必须把 sessionId 串进 confirm-auth', async () => {
    const bind = await client.bind('await_login');
    expect(bind.ok).toBe(true);
    const confirm = await client.confirmAuth();
    // 真实 be 要求 confirm-auth body 带 sessionId;client 若不串会 validation_failed
    expect(confirm.ok).toBe(true);
  });

  it('M3:navigate 已接 daemon —— daemon 不可达时降级 daemon_unavailable', async () => {
    await client.bind('existing');
    const res = await client.navigate('https://example.com');
    // 不再 feature_disabled:navigate 已接 daemon /command;测试环境无 daemon → 降级
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('daemon_unavailable');
  });

  it('单会话:重复 bind 永不撞 queue_full(每次 bind 前清空旧会话槽)', async () => {
    // 默认 RECORDER_MAX_ACTIVE_SESSIONS=2;连续 bind 远超上限次都应成功——旧会话被 cancelAll 取消、槽腾出。
    let lastSid = '';
    for (let i = 0; i < 5; i++) {
      const r = await client.bind('existing');
      expect(r.ok, `第 ${i + 1} 次 bind 应成功:${JSON.stringify(r.error)}`).toBe(true);
      expect(r.data?.sessionId).toMatch(/^rec_/);
      expect(r.data?.sessionId).not.toBe(lastSid); // 每次都是新会话
      lastSid = r.data!.sessionId;
    }
  });
});

describe('同源 UI 托管(①)', () => {
  // 固定端口:使实际监听 origin 与 loadConfig 自动并入白名单的 http://127.0.0.1:PORT 一致,
  // 才能真实验证「be 同源 Origin 被门禁放行」。用随机端口会让 origin 与白名单端口对不上。
  const UI_PORT = 19829;
  const uiCfg = loadConfig({
    RECORDER_TOKEN: 'ui-token-1234567890abcdef',
    LOG_LEVEL: 'error', // quiet structured-request logs in test output
    RECORDER_PORT: String(UI_PORT),
    RECORDER_UI_DIST: new URL('./fixtures/ui', import.meta.url).pathname,
    FEATURE_LOCALHOST_HTTP_UI: 'true', // #5a: 同源托管现由 restart-only flag 主控,UI_DIST 单独不再够
  });
  const uiApp = createApp(uiCfg);
  const uiBase = `http://127.0.0.1:${UI_PORT}`;

  beforeAll(async () => {
    await new Promise<void>((r) => uiApp.server.listen(UI_PORT, '127.0.0.1', r));
  });
  afterAll(() => new Promise<void>((r) => uiApp.server.close(() => r())));

  it('SPA 路由 /workbench 回 index.html 且注入 bootstrap(同源 token 下发)', async () => {
    const res = await fetch(`${uiBase}/workbench`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('__bycli_recorder_bootstrap__');
    expect(html).toContain(uiCfg.TOKEN); // 同源直接注入 token
    expect(html).toContain('<div id="root">'); // 确实是 umi 入口
  });

  it('M7d CSP:入口 HTML 带 CSP + 安全 header,nonce 与注入的 bootstrap script 匹配', async () => {
    const res = await fetch(`${uiBase}/workbench`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("script-src 'self' 'nonce-"); // 严格 script-src,无 unsafe-inline/eval
    expect(csp).toContain("frame-ancestors 'none'");      // 反 clickjacking
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const html = await res.text();
    const nonce = csp!.match(/'nonce-([^']+)'/)![1];
    expect(html).toContain(`<script nonce="${nonce}">`);  // 唯一 inline script 被 nonce 放行
    // 每响应 nonce 不同(no-store + 重生成)
    const res2 = await fetch(`${uiBase}/workbench`);
    const nonce2 = res2.headers.get('content-security-policy')!.match(/'nonce-([^']+)'/)![1];
    expect(nonce2).not.toBe(nonce);
  });

  it('静态资源 /umi.js 正确 serve', async () => {
    const res = await fetch(`${uiBase}/umi.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  it('路径穿越被拒', async () => {
    const res = await fetch(`${uiBase}/../package.json`);
    // 穿越解析越界 → 非命中 → 404 request_not_found
    expect(res.status).toBe(404);
  });

  it('同源请求:be 自己的 Origin 必须被门禁放行(回归:别再被 :8000 默认值挡死)', async () => {
    const res = await fetch(`${uiBase}/recorder/health`, {
      headers: { 'X-Recorder': '1', 'X-byCLI-Token': uiCfg.TOKEN, Origin: uiBase },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe('#5a · FEATURE_LOCALHOST_HTTP_UI off → 即使设了 UI_DIST 也不托管 UI', () => {
  // flag 默认 false:staticServer 不构建,GET 非 API 请求落 request_not_found(与默认 Electron-IPC
  // /API-only 形态一致)。证明 flag 是「localhost HTTP UI 形态」总开关,UI_DIST 单独不足以开启托管。
  const offCfg = loadConfig({
    RECORDER_TOKEN: 'off-token-1234567890abcdef',
    LOG_LEVEL: 'error',
    RECORDER_UI_DIST: new URL('../../dashboard/dist', import.meta.url).pathname,
    // FEATURE_LOCALHOST_HTTP_UI 不设 → 默认 false
  });
  const offApp = createApp(offCfg);

  beforeAll(async () => { await new Promise<void>((r) => offApp.server.listen(0, '127.0.0.1', r)); });
  afterAll(() => new Promise<void>((r) => offApp.server.close(() => r())));

  it('staticServer 为 null,GET /workbench → 404 request_not_found', async () => {
    expect(offApp.ctx.staticServer).toBeNull();
    const { port } = offApp.server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/workbench`);
    expect(res.status).toBe(404);
    expect((await res.json()).error?.code).toBe('request_not_found');
  });
});

describe('M8b/M8c · 结构化请求日志 + metrics', () => {
  it('每个 /recorder/* 请求落一条日志 + 计入 metrics(injected logger/metrics 捕获)', async () => {
    const logs: Record<string, unknown>[] = [];
    const logger = createLogger('info', { sink: (l) => logs.push(JSON.parse(l)), now: () => 'T' });
    const metrics = createMetrics();
    const app = createApp(loadConfig({ RECORDER_TOKEN: 'x'.repeat(20), BYCLI_DAEMON_PORT: '6553' }), logger, metrics);
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
    const { port } = app.server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/recorder/health`); // 无门禁 header → 403,但仍完成
      await res.text();
      await new Promise((r) => setTimeout(r, 20)); // 让 res 'finish' 先触发
      // M8b 日志:operation/status/errorCode/durationMs
      const entry = logs.find((l) => l.operation === 'recorder.health');
      expect(entry).toMatchObject({ level: 'info', operation: 'recorder.health', status: 'failed', errorCode: 'auth_failed' });
      expect(typeof entry!.durationMs).toBe('number');
      // forbidden 字段(token 等)不可能出现 —— 类型上就放不进 LogFields
      expect(JSON.stringify(logs)).not.toContain('x'.repeat(20));
      // M8c metrics:requests_total{operation,status,errorCode} + duration 直方图
      const s = metrics.snapshot();
      expect(s.counters['recorder_requests_total{errorCode=auth_failed,operation=recorder.health,status=failed}']).toBe(1);
      expect(s.histograms['recorder_request_duration_ms']?.count).toBe(1);
      expect(JSON.stringify(s)).not.toContain('x'.repeat(20)); // metrics 无敏感值
    } finally {
      await new Promise<void>((r) => app.server.close(() => r()));
    }
  });
});
