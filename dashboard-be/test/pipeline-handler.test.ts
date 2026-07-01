// N4 HTTP 接线:/recorder/pipeline(score→生成→静态检查→草稿→verify→收集)+ /recorder/save(写 clis/、ranked→done)。
// 注入 fake ctx.scorer/ctx.generator + stub daemon(verify 轮询 / save-adapter)。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import type { DaemonCommandResult } from '../src/transport/daemonBridge.js';

const cfg = loadConfig({
  RECORDER_TOKEN: 'test-token-pipe-1234567890', LOG_LEVEL: 'error', RECORDER_ALLOWED_ORIGINS: 'http://127.0.0.1:8000',
  BYCLI_DAEMON_PORT: '6557', RECORDER_MAX_ACTIVE_SESSIONS: '10', FEATURE_LLM_SYNTHESIS: '1', RECORDER_LLM_API_KEY: 'k', REQUEST_POLL_AFTER_MS: '250',
});
const { server, ctx } = createApp(cfg);
let base = '';

const GOOD = "import { cli } from '@sovovs/bycli/registry'; cli({ site:'x', name:'search', func: async (k) => { const r = await fetch('https://x.com/api/search'); return await r.json(); } });";

// fake LLM:scorer 给 c1 generate;generator 产一个合法脚本
ctx.scorer = { async score() { return { candidates: [{ candidateId: 'c1', score: 55, uiScore: 55, confidence: 'medium', decision: 'generate', isDataEndpoint: true, signals: [], risks: [], reason: 'data' }] }; } };
ctx.generator = { async generate() { return { scripts: [{ candidateId: 'c1', site: 'x', name: 'search', description: '', access: 'read', domain: 'x.com', strategy: 'PUBLIC', browser: false, scriptKind: 'func', args: [], columns: ['t'], source: GOOD, verifyExpectation: { commandName: 'x/search', verifyArgs: {}, minRows: 1, expectedFieldCount: 0, allowedOrigins: ['https://x.com'], expectedStage: 'execute' }, risks: [], notes: [] }], skipped: [] }; } };

let savedBody: Record<string, unknown> | null = null;
// stub daemon:verify → requestId + 终态 succeeded(rows:2);save-adapter → adapterPath
ctx.daemon.highLevel = async (path, body): Promise<DaemonCommandResult> => {
  if (path === '/v1/verify') return { ok: true, data: { requestId: 'rq1' } };
  if (path === '/v1/save-adapter') { savedBody = body as Record<string, unknown>; return { ok: true, data: { adapterPath: '~/.bycli/clis/x/search.js' } }; }
  return { ok: true, data: {} };
};
ctx.daemon.highLevelGet = async (): Promise<DaemonCommandResult> => ({ ok: true, data: { status: 'succeeded', result: { ok: true, stage: 'execute', rows: 2, fieldCount: 1 } } });

const auth = { 'X-Recorder': '1', 'X-byCLI-Token': cfg.TOKEN, 'X-CSRF-Token': ctx.vault.csrfToken, 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:8000' };
const post = (p: string, b: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: auth, body: JSON.stringify(b) });

/** pipeline 现在是 202+requestId 异步:POST 拿 requestId,轮询 GET /recorder/requests/{id} 到终态,返回终态 envelope。 */
async function runPipelineAndWait(sessionId: string, candidateIds?: string[]) {
  const acc = await (await post('/recorder/pipeline', { sessionId, llmEgressAcknowledgedAt: 1, ...(candidateIds ? { candidateIds } : {}) })).json();
  const requestId = acc.requestId ?? acc.data?.requestId;
  for (let i = 0; i < 100; i++) {
    const st = await (await fetch(`${base}/recorder/requests/${requestId}`, { headers: auth })).json();
    const status = st.data?.status;
    if (status === 'succeeded' || status === 'failed' || status === 'timeout') {
      // 成功时把 result 摊平到 data,模拟旧同步形状,便于断言。
      return status === 'succeeded' ? { ok: true, data: st.data.result } : { ok: false, error: st.data.error };
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('pipeline 轮询超时');
}

beforeAll(async () => { await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { savedBody = null; });

/** 造一个 ranked 会话 + 冻结候选 + 样本(直接用 registry,绕过完整录制流程)。 */
function rankedSession(): string {
  const s = ctx.registry.createSession({ contextId: 'c', targetId: 'p', awaitingLogin: false });
  // idle→...→ranked:直接设状态(测试便利)
  (ctx.registry.getSession(s.sessionId) as { state: string }).state = 'ranked';
  ctx.registry.storeCandidates(s.sessionId, [{ id: 'c1', endpoint: { method: 'GET', pathname: '/api/search' } }]);
  ctx.registry.storeSample(s.sessionId, 'A', [{ method: 'GET', url: 'https://x.com/api/search?q=cat', responseStatus: 200, responsePreview: '[{"t":1}]', timestamp: 1 }]);
  return s.sessionId;
}

describe('N4 /recorder/pipeline + /recorder/save', () => {
  it('pipeline/preview:不外发,返回 score 提示词 + sentCandidateIds(selectCandidatesForLlm 真实筛选)', async () => {
    const sid = rankedSession();
    const r = await (await post('/recorder/pipeline/preview', { sessionId: sid })).json();
    expect(r.ok).toBe(true);
    expect(typeof r.data.prompts.score).toBe('string');
    expect(r.data.prompts.score.length).toBeGreaterThan(0);
    expect(Array.isArray(r.data.sentCandidateIds)).toBe(true);
    // c1 有数据形状(responsePreview 是 array)→ 应被选中传 LLM
    expect(r.data.sentCandidateIds).toContain('c1');
    // 预览不外发、不改状态:仍停在 ranked
    expect(ctx.registry.getSession(sid)?.state).toBe('ranked');
  });

  it('pipeline:无 egress 同意 → 拒', async () => {
    const sid = rankedSession();
    expect((await (await post('/recorder/pipeline', { sessionId: sid })).json()).error.code).toBe('validation_failed');
  });

  it('pipeline:带同意 → 产 usable 草稿(verify rows:2 达标)', async () => {
    const sid = rankedSession();
    const r = await runPipelineAndWait(sid);
    expect(r.ok).toBe(true);
    expect(r.data.drafts).toHaveLength(1);
    expect(r.data.drafts[0]).toMatchObject({ id: 'draft_0', candidateId: 'c1', usable: true, staticOk: true });
    expect(r.data.drafts[0].verify).toMatchObject({ ok: true, rows: 2 });
  });

  it('save:把草稿写 clis/ + ranked→done', async () => {
    const sid = rankedSession();
    await runPipelineAndWait(sid);
    const r = await (await post('/recorder/save', { sessionId: sid, draftId: 'draft_0' })).json();
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ state: 'done', adapterPath: '~/.bycli/clis/x/search.js' });
    expect(savedBody).toMatchObject({ name: 'x/search' });
    expect(String(savedBody!.source)).toContain('fetch');
    expect(ctx.registry.getSession(sid)?.state).toBe('done');
  });

  it('save:用户编辑过的 source 优先', async () => {
    const sid = rankedSession();
    await runPipelineAndWait(sid);
    await post('/recorder/save', { sessionId: sid, draftId: 'draft_0', source: '// edited\n' + GOOD });
    expect(String(savedBody!.source)).toContain('// edited');
  });

  it('save:批量 drafts[] 形式 → saved[] 带 site/name/adapterPath,一次 ranked→done', async () => {
    const sid = rankedSession();
    await runPipelineAndWait(sid);
    const r = await (await post('/recorder/save', { sessionId: sid, drafts: [{ draftId: 'draft_0', source: '// batch\n' + GOOD }] })).json();
    expect(r.ok).toBe(true);
    expect(r.data.state).toBe('done');
    expect(r.data.saved).toHaveLength(1);
    expect(r.data.saved[0]).toMatchObject({ draftId: 'draft_0', site: 'x', name: 'search', adapterPath: '~/.bycli/clis/x/search.js' });
    expect(r.data.adapterPath).toBe('~/.bycli/clis/x/search.js'); // 向后兼容字段
    expect(String(savedBody!.source)).toContain('// batch');
    expect(ctx.registry.getSession(sid)?.state).toBe('done');
  });

  it('save:全部 draftId 未知 → validation_failed,会话保持 ranked(可重试)', async () => {
    const sid = rankedSession();
    await runPipelineAndWait(sid);
    const r = await (await post('/recorder/save', { sessionId: sid, drafts: [{ draftId: 'nope' }] })).json();
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('validation_failed');
    expect(ctx.registry.getSession(sid)?.state).toBe('ranked');
  });

  it('pipeline:非 ranked 态 → invalid_state', async () => {
    const s = ctx.registry.createSession({ contextId: 'c', targetId: 'p', awaitingLogin: false }); // session_bound
    expect((await (await post('/recorder/pipeline', { sessionId: s.sessionId, llmEgressAcknowledgedAt: 1 })).json()).error.code).toBe('invalid_state');
  });
});
