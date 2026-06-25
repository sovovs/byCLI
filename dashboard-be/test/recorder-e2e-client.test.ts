// 端到端真实联调(联调形态 ③):真前端 httpRecorderClient → 真 be(真 server/registry/状态机/门禁/
// rank 引擎)→ 桩 daemon(覆盖 ctx.daemon 四接口,模拟扩展+daemon high-level)。
// 这是 ② Node 集成测试的全链路扩展:② 只走到 navigate;此处把 capture/rank/init(预览+写入)/verify
// 整条 8 步用真 client 驱动,焊死前端↔be 契约咬合(reconciliation 回归守卫)。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import type { DaemonCommandInput } from '../src/transport/daemonBridge.js';
// 跨包引用前端真实 client(纯 import type 在运行时擦除;运行时用 createHttpRecorderClient 工厂)
import { createHttpRecorderClient } from '../../dashboard/src/services/httpRecorderClient';

const cfg = loadConfig({
  RECORDER_TOKEN: 'e2e-token-1234567890abcdef',
  LOG_LEVEL: 'error', // quiet structured-request logs in test output
  RECORDER_ALLOWED_ORIGINS: 'http://127.0.0.1:8000',
  BYCLI_DAEMON_PORT: '6553', // 被 ctx.daemon 覆盖,端口不会真被打
  RECORDER_MAX_ACTIVE_SESSIONS: '10',
});
const { server, ctx } = createApp(cfg);
let client: ReturnType<typeof createHttpRecorderClient>;

// rank 可用的原始抓包条目(be 冻结后喂 recorder-core rankSamples;A/B 用不同 keyword)
const rankableEntry = (kw: string) => ({
  requestId: `net_${kw}`,
  method: 'GET',
  url: `https://x.com/api/search?keyword=${kw}`,
  responseStatus: 200,
  responseContentType: 'application/json',
  responsePreview: JSON.stringify([{ title: 't', url: 'u' }]),
  startedAt: 0,
  durationMs: 50,
});

// 桩 daemon:覆盖四接口。模拟扩展返回 page lease + 抓包,daemon high-level 返回 init 报告 + verify 终态。
let captureReads = 0;
const initReport = {
  report: {
    adapterPath: '~/.bycli/clis/x-com/search.js',
    reportPath: '~/.bycli/sites/x-com/recorder/search-report.json',
    warnings: [],
    responsibleUseAcknowledgedAt: 0,
    releaseChannel: 'stable',
    localExperimentProfile: 'off',
    configSnapshotVersion: 1,
  },
  dryRun: { exists: false, changedLines: 8 },
};
const verifySummary = {
  ok: true,
  stage: 'execute',
  rows: 2,
  fieldCount: 2,
  fixture: { status: 'matched' },
  trace: { retained: false },
};
ctx.daemon.status = async () => ({ extensionConnected: true });
ctx.daemon.command = async (cmd: DaemonCommandInput) => {
  switch (cmd.action) {
    case 'navigate':
      return { ok: true, data: { page: 'page-1', url: cmd.url, title: 'X' } };
    case 'network-capture-start':
      return { ok: true, data: {} };
    case 'network-capture-read':
      return { ok: true, data: [rankableEntry(captureReads++ === 0 ? 'cat' : 'dog')] };
    default:
      return { ok: true, data: {} };
  }
};
ctx.daemon.highLevel = async (path: string) => {
  if (path === '/v1/init') return { ok: true, data: initReport };
  if (path === '/v1/verify') return { ok: true, data: {} }; // started → be 回 202
  return { ok: false, errorCode: 'request_failed', error: `unexpected ${path}` };
};
// verify 轮询:daemon /v1/requests/{id} 直接终态 succeeded + VerifySummary
ctx.daemon.highLevelGet = async () => ({ ok: true, data: { status: 'succeeded', result: verifySummary } });

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

describe('端到端:真 httpRecorderClient → 真 be → 桩 daemon(8 步全链路)', () => {
  it('health → bind → navigate → captureA/B → rank → init(预览+写入) → verify 全绿', async () => {
    // health(daemon 在线)
    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.data?.daemon).toBe('ok');

    // bind existing → session_bound,client 持有 sessionId
    const bind = await client.bind('existing');
    expect(bind.ok).toBe(true);
    expect(bind.data?.sessionId).toMatch(/^rec_/);

    // navigate → page_ready(page lease 写回 session)
    const nav = await client.navigate('https://x.com');
    expect(nav.ok, JSON.stringify(nav.error)).toBe(true);

    // capture A:start(契约带 trigger)+ read(be 冻结样本)
    expect((await client.captureStart('A')).ok, 'captureStart A 应带 trigger 过 be 校验').toBe(true);
    const capA = await client.captureRead('A');
    expect(capA.ok).toBe(true);
    expect(capA.data?.entries.length).toBeGreaterThan(0);

    // capture B
    expect((await client.captureStart('B')).ok).toBe(true);
    expect((await client.captureRead('B')).ok).toBe(true);

    // rank → client 从 envelope 拆出候选数组
    const rank = await client.rank();
    expect(rank.ok, JSON.stringify(rank.error)).toBe(true);
    expect(Array.isArray(rank.data)).toBe(true);
    expect(rank.data!.length).toBeGreaterThan(0);
    const candidateId = rank.data![0].id;

    // init dry-run 预览(不推进会话)→ 同步 200 回 {report,dryRun}
    const preview = await client.init('x-com/search', candidateId, 'dry-run');
    expect(preview.ok, JSON.stringify(preview.error)).toBe(true);
    expect(preview.data?.report.adapterPath).toContain('search');
    expect(preview.data?.dryRun).toBeDefined();

    // init write(带 ADR-0005 责任声明)→ 推进 ranked→draft_created
    const write = await client.init('x-com/search', candidateId, 'write', Date.now());
    expect(write.ok, JSON.stringify(write.error)).toBe(true);

    // verify → 202 + 内部轮询 → VerifySummary(脱敏:仅 shape,无原始行)
    const verify = await client.verify('x-com/search');
    expect(verify.ok, JSON.stringify(verify.error)).toBe(true);
    expect(verify.data?.ok).toBe(true);
    expect(verify.data?.rows).toBe(2);
    // M7c 脱敏:summary 仅留字段数(列名可能含 seed 值),无 rowShape.keys、无原始行数据
    expect(verify.data?.fieldCount).toBe(2);
  });
});
