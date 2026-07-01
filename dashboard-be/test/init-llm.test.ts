// handleInit LLM 合成接线:FEATURE_LLM_SYNTHESIS=1 时,init dry-run 调合成器,把 funcBody/columns/
// llmModel 穿进 daemon /v1/init,回传 generatedSource;同候选 write 复用缓存(不重复调 LLM)。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import type { DaemonCommandInput, DaemonCommandResult } from '../src/transport/daemonBridge.js';
import type { Synthesizer } from '../src/llm/synthesize.js';

const cfg = loadConfig({
  RECORDER_TOKEN: 'test-token-llm-1234567890',
  LOG_LEVEL: 'error',
  RECORDER_ALLOWED_ORIGINS: 'http://127.0.0.1:8000',
  BYCLI_DAEMON_PORT: '6554',
  RECORDER_MAX_ACTIVE_SESSIONS: '10',
  FEATURE_LLM_SYNTHESIS: '1',
  RECORDER_LLM_API_KEY: 'test-key',
  RECORDER_LLM_MODEL: 'claude-opus-4-8',
});

const { server, ctx } = createApp(cfg);
let base = '';
let captureReads = 0;
let synthCalls = 0;
const highLevelCalls: Array<{ path: string; body: Record<string, unknown> }> = [];

function entry(kw: string) {
  return {
    requestId: `net_${kw}`, method: 'GET', url: `https://x.com/api/search?keyword=${kw}`,
    responseStatus: 200, responseContentType: 'application/json',
    responsePreview: JSON.stringify([{ title: 't', url: 'u' }]), startedAt: 0, durationMs: 50,
  };
}

// per-action daemon stub
ctx.daemon.command = async (cmd: DaemonCommandInput): Promise<DaemonCommandResult> => {
  if (cmd.action === 'navigate' || cmd.action === 'tabs') return { ok: true, data: { page: 'page-x', url: 'https://x.com/' }, page: 'page-x' };
  if (cmd.action === 'network-capture-read') return { ok: true, data: [entry(captureReads++ === 0 ? 'cat' : 'dog')] };
  if (cmd.action === 'screenshot') return { ok: true, data: 'SHOTBASE64' };
  return { ok: true, data: {} };
};
// /v1/init stub:回传 report+dryRun+generatedSource(把收到的 funcBody 嵌进去以便断言穿透)
ctx.daemon.highLevel = async (path, body): Promise<DaemonCommandResult> => {
  highLevelCalls.push({ path, body: body as Record<string, unknown> });
  const b = body as Record<string, unknown>;
  return { ok: true, data: { report: { adapterPath: '~/.bycli/clis/x-com/search.js', warnings: [] }, dryRun: { exists: false, changedLines: 10 }, generatedSource: `RENDERED::${String(b.funcBody ?? '')}` } };
};
// fake 合成器:计数 + 固定产物
const fakeSynth: Synthesizer = {
  async synthesize() {
    synthCalls++;
    return { funcBody: 'return [{title:"x"}];', columns: [{ name: 'title', path: '$[].title', type: 'string' }], description: 'd', access: 'read' };
  },
};
ctx.synthesizer = fakeSynth;

const auth = {
  'X-Recorder': '1', 'X-byCLI-Token': cfg.TOKEN, 'X-CSRF-Token': ctx.vault.csrfToken,
  'Content-Type': 'application/json', Origin: 'http://127.0.0.1:8000',
};
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** drive bind→navigate→captureA→(renav)→captureB→rank,返回 [sid, candidateId]。 */
async function rankedSession(): Promise<[string, string]> {
  const sid = (await (await post('/recorder/session/bind', { mode: 'bind_existing_page', contextId: 'ctx', targetId: 'page-0' })).json()).data.sessionId;
  await post('/recorder/navigate', { sessionId: sid, url: 'https://x.com' });
  await post('/recorder/capture/start', { sessionId: sid, sampleName: 'A', trigger: 'user_manual' });
  await post('/recorder/capture/read', { sessionId: sid, sampleName: 'A' });
  await post('/recorder/navigate', { sessionId: sid, url: 'https://x.com' });
  await post('/recorder/capture/start', { sessionId: sid, sampleName: 'B', trigger: 'user_manual' });
  await post('/recorder/capture/read', { sessionId: sid, sampleName: 'B' });
  const rank = await (await post('/recorder/rank', { sessionId: sid })).json();
  return [sid, rank.data.candidates[0].id];
}

describe('handleInit · LLM 合成接线', () => {
  it('无 egress 同意 → 不合成、不外发,llmSynthesisOffered=true(P0-2)', async () => {
    const [sid, candidateId] = await rankedSession();
    const before = synthCalls;
    const res = await (await post('/recorder/init', { sessionId: sid, selectedCandidateId: candidateId, name: 'x-com/search', writePolicy: 'dry-run' })).json();
    expect(res.ok).toBe(true);
    expect(synthCalls).toBe(before); // 没调合成(零外发)
    expect(res.data.llmSynthesisOffered).toBe(true);
  });

  it('带 egress 同意 → 合成,funcBody/columns/llmModel 穿进 /v1/init,回传 generatedSource', async () => {
    const [sid, candidateId] = await rankedSession();
    const before = synthCalls;
    const res = await (await post('/recorder/init', { sessionId: sid, selectedCandidateId: candidateId, name: 'x-com/search', writePolicy: 'dry-run', llmEgressAcknowledgedAt: 111 })).json();
    expect(res.ok).toBe(true);
    expect(synthCalls).toBe(before + 1); // 调了一次合成
    expect(res.data.llmSynthesisOffered).toBe(false);
    const initCall = highLevelCalls.findLast((c) => c.path === '/v1/init')!;
    expect(initCall.body.funcBody).toBe('return [{title:"x"}];'); // 穿透到 daemon
    expect(initCall.body.llmModel).toBe('claude-opus-4-8');
    expect((initCall.body.columns as Array<{ name: string }>)[0].name).toBe('title');
    expect(res.data.generatedSource).toContain('return [{title:"x"}];'); // 回传供审阅
  });

  it('同候选再次 init(write)复用缓存,不重复调 LLM', async () => {
    const [sid, candidateId] = await rankedSession();
    const n0 = synthCalls;
    // dry-run 带 egress 同意 → 合成一次并缓存
    await post('/recorder/init', { sessionId: sid, selectedCandidateId: candidateId, name: 'x-com/search', writePolicy: 'dry-run', llmEgressAcknowledgedAt: 111 });
    expect(synthCalls).toBe(n0 + 1);
    // write 同候选:复用缓存,synthCalls 不再增加(write 不重新外发)
    const res = await (await post('/recorder/init', { sessionId: sid, selectedCandidateId: candidateId, name: 'x-com/search', writePolicy: 'write', responsibleUseAcknowledgedAt: 123, llmEgressAcknowledgedAt: 111 })).json();
    expect(res.ok).toBe(true);
    expect(synthCalls).toBe(n0 + 1); // 没再调
    const writeCall = highLevelCalls.findLast((c) => c.path === '/v1/init')!;
    expect(writeCall.body.writePolicy).toBe('write');
    expect(writeCall.body.funcBody).toBe('return [{title:"x"}];'); // 写盘用的是审阅过的同一份
  });
});
