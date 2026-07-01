// LLM 真实连通性 + 合成实测(gated BYCLI_LLM_LIVE=1)。key/baseURL/model 全从 env 读,文件不含密钥。
// ① 原始 messages.create 探连通(不吞错,暴露网关真实报错);② 完整 createSynthesizer(吞错→null)。
import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { createSynthesizer, type SynthesisInput } from '../src/llm/synthesize.js';
import type { RankCandidate } from '@sovovs/bycli-recorder-core';

const LIVE = process.env.BYCLI_LLM_LIVE === '1';
const apiKey = process.env.RECORDER_LLM_API_KEY ?? '';
const baseURL = process.env.RECORDER_LLM_BASE_URL || undefined;
const model = process.env.RECORDER_LLM_MODEL || 'claude-opus-4-8';

describe('LLM live', () => {
  it.skipIf(!LIVE)('① 原始 messages.create 连通网关 + 模型可用', async () => {
    expect(apiKey, '需 RECORDER_LLM_API_KEY').toBeTruthy();
    const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
    const res = await client.messages.create({
      model,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
    });
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    console.error(`[LLM-LIVE raw] model=${model} baseURL=${baseURL ?? 'default'} → ${JSON.stringify(text)}`);
    expect(text.length).toBeGreaterThan(0);
  }, 60000);

  it.skipIf(!LIVE)('② createSynthesizer 完整路径生成 funcBody/columns', async () => {
    const s = createSynthesizer({ apiKey, baseURL, model });
    const candidate = {
      id: 'c1',
      endpoint: { method: 'GET', urlTemplate: 'https://x.com/api/search?q={keyword}', pathname: '/api/search', queryParams: { q: '{keyword}' } },
      args: [{ argName: 'keyword', in: 'query', paramName: 'q', valueType: 'string' }],
      responseShape: { kind: 'array', itemKeys: ['title', 'url'] },
    } as unknown as RankCandidate;
    const input: SynthesisInput = {
      candidate,
      samples: [
        { sampleName: 'A', entries: [{ method: 'GET', url: 'https://x.com/api/search?q=cat', responseStatus: 200, responsePreview: '[{"title":"a","url":"u1"}]', timestamp: 1100, initiatorType: 'script' }], actions: [{ type: 'input', selector: '#q', ts: 1000, valueShape: { len: 3, kind: 'text' } }] },
        { sampleName: 'B', entries: [{ method: 'GET', url: 'https://x.com/api/search?q=dog', responseStatus: 200, responsePreview: '[{"title":"b","url":"u2"}]', timestamp: 2100, initiatorType: 'script' }], actions: [{ type: 'input', selector: '#q', ts: 2000, valueShape: { len: 3, kind: 'text' } }] },
      ],
    };
    const res = await s.synthesize(input);
    console.error('[LLM-LIVE synth]\n' + JSON.stringify(res, null, 2));
    expect(res, 'synthesize 返回 null = 网关不支持 structured output/adaptive thinking 或输出不合规(看 ① 是否通)').not.toBeNull();
    expect(typeof res!.funcBody).toBe('string');
    expect(res!.funcBody.length).toBeGreaterThan(0);
    expect(Array.isArray(res!.columns)).toBe(true);
  }, 60000);
});
