// LLM 合成单测:fake client 注入,覆盖正常产出 / 无 key / 失败 / 无效输出 / 截图入参。
import { describe, it, expect } from 'vitest';
import { createSynthesizer, makeLlmClient, type LlmClient, type SynthesisInput } from '../src/llm/synthesize.js';
import type { RankCandidate } from '@sovovs/bycli-recorder-core';

describe('makeLlmClient', () => {
  it('passes timeout + maxRetries:1 to the Anthropic constructor (default 180s)', () => {
    const c = makeLlmClient({ apiKey: 'sk-test' }) as unknown as { timeout: number; maxRetries: number };
    expect(c).not.toBeNull();
    expect(c.timeout).toBe(180_000);
    expect(c.maxRetries).toBe(1);
  });
  it('honors an explicit timeoutMs', () => {
    const c = makeLlmClient({ apiKey: 'sk-test', timeoutMs: 45_000 }) as unknown as { timeout: number; maxRetries: number };
    expect(c.timeout).toBe(45_000);
    expect(c.maxRetries).toBe(1);
  });
  it('returns null with no key and no injected client', () => {
    expect(makeLlmClient({})).toBeNull();
  });
  it('returns the injected client as-is (bypasses SDK construction)', () => {
    const injected = { messages: { async create() { return { content: [] }; } } } as LlmClient;
    expect(makeLlmClient({ client: injected })).toBe(injected);
  });
});

const candidate = {
  id: 'cand_1',
  endpoint: { method: 'GET', urlTemplate: 'https://x.com/api/search?q={keyword}', pathname: '/api/search', queryParams: { q: '{keyword}' } },
  args: [{ argName: 'keyword', in: 'query', paramName: 'q', valueType: 'string' }],
  responseShape: { kind: 'array', itemKeys: ['title', 'url'] },
} as unknown as RankCandidate;

const input: SynthesisInput = {
  candidate,
  samples: [
    {
      sampleName: 'A',
      entries: [{ method: 'GET', url: 'https://x.com/api/search?q=cat', responseStatus: 200, responsePreview: '[{"title":"a"}]', timestamp: 1100, initiatorType: 'script' }],
      actions: [{ type: 'input', selector: '#q', ts: 1000, valueShape: { len: 3, kind: 'text' } }, { type: 'keydown', selector: '#q', ts: 1050, key: 'Enter' }],
      screenshot: 'AAAA',
    },
    { sampleName: 'B', entries: [{ method: 'GET', url: 'https://x.com/api/search?q=dog', responseStatus: 200, responsePreview: '[{"title":"b"}]', timestamp: 2100, initiatorType: 'script' }], actions: [{ type: 'input', selector: '#q', ts: 2000, valueShape: { len: 3, kind: 'text' } }] },
  ],
};

/** fake client:记录收到的 params,回可配置的 content。 */
function fakeClient(content: Array<{ type: string; text?: string }>, capture?: { params?: Record<string, unknown> }): LlmClient {
  return {
    messages: {
      async create(params) {
        if (capture) capture.params = params;
        return { content };
      },
    },
  };
}

describe('createSynthesizer', () => {
  it('正常产出 → 解析 funcBody/columns/description/access', async () => {
    const out = {
      funcBody: "const r = await fetch(`https://x.com/api/search?q=${kwargs.keyword}`); return await r.json();",
      columns: [{ name: 'title', path: '$[].title', type: 'string' }],
      description: 'Search x.com',
      access: 'read',
    };
    const cap: { params?: Record<string, unknown> } = {};
    const s = createSynthesizer({ model: 'claude-opus-4-8', client: fakeClient([{ type: 'text', text: JSON.stringify(out) }], cap) });
    const res = await s.synthesize(input);
    expect(res).not.toBeNull();
    expect(res!.funcBody).toContain('fetch');
    expect(res!.columns[0].name).toBe('title');
    expect(res!.access).toBe('read');
    // 截图作为 image block 传入(A 有截图,B 无)→ content = 1 text + 1 image
    const msgs = cap.params!.messages as Array<{ content: Array<{ type: string }> }>;
    const types = msgs[0].content.map((b) => b.type);
    expect(types.filter((t) => t === 'image')).toHaveLength(1);
    expect(types[0]).toBe('text');
    // prompt 含真实响应样例 + 因果时间线(操作序列 + triggeredBy 关联)
    const promptText = (msgs[0].content[0] as { text: string }).text;
    expect(promptText).toContain('/api/search');
    expect(promptText).toContain('responseBody');
    expect(promptText).toContain('triggeredBy'); // 因果标注
    expect(promptText).toContain('valueShape'); // 操作序列带 input 的值形状
    expect(promptText).toContain('keydown'); // 操作序列含 Enter 键
    // script-initiated 请求紧跟 input/keydown → triggeredBy 指向某 action(非 null)
    expect(promptText).toMatch(/"triggeredBy":\s*"act_/);
  });

  it('无 client 且无 apiKey → 永远返回 null', async () => {
    const s = createSynthesizer({ model: 'claude-opus-4-8' });
    expect(await s.synthesize(input)).toBeNull();
  });

  it('client 抛错 → 返回 null(不阻断)', async () => {
    const s = createSynthesizer({
      model: 'claude-opus-4-8',
      client: { messages: { async create() { throw new Error('rate_limit'); } } },
    });
    expect(await s.synthesize(input)).toBeNull();
  });

  it('无效输出(funcBody 缺失/空)→ 返回 null', async () => {
    const s1 = createSynthesizer({ model: 'm', client: fakeClient([{ type: 'text', text: JSON.stringify({ columns: [] }) }]) });
    expect(await s1.synthesize(input)).toBeNull();
    const s2 = createSynthesizer({ model: 'm', client: fakeClient([{ type: 'text', text: JSON.stringify({ funcBody: '   ' }) }]) });
    expect(await s2.synthesize(input)).toBeNull();
  });

  it('非 JSON 文本 → 返回 null', async () => {
    const s = createSynthesizer({ model: 'm', client: fakeClient([{ type: 'text', text: 'not json' }]) });
    expect(await s.synthesize(input)).toBeNull();
  });
});

describe('buildSampleSummary · navigations', () => {
  it('把 navigate 事件单列成 navigations(带 url),不混进 actions;空 url 过滤', async () => {
    const { buildSampleSummary } = await import('../src/llm/synthesize.js');
    const sample = {
      sampleName: 'A' as const,
      entries: [{ method: 'GET', url: 'https://x.com/api/search?q=apple', responseStatus: 200, responsePreview: '[{"title":"a"}]', timestamp: 1100 }],
      actions: [
        { type: 'navigate', ts: 900, url: 'https://x.com/search?q=apple' },
        { type: 'input', selector: '#q', ts: 1000, valueShape: { len: 5, kind: 'text' } },
        { type: 'navigate', ts: 1200 }, // 无 url → 过滤
      ],
    };
    const summary = buildSampleSummary(sample as never, candidate) as Record<string, unknown>;
    const navs = summary.navigations as Array<{ url: string }>;
    expect(navs).toHaveLength(1);
    expect(navs[0].url).toBe('https://x.com/search?q=apple');
    // navigate 不进 actions 序列(只剩 input)
    const acts = summary.actions as Array<{ type: string }>;
    expect(acts.every((a) => a.type !== 'navigate')).toBe(true);
    expect(acts.some((a) => a.type === 'input')).toBe(true);
  });
});

describe('buildSampleSummary · endpoint 精确匹配 + 证据去重', () => {
  const ep = (over: Record<string, unknown> = {}) =>
    ({ id: 'c', endpoint: { method: 'GET', host: 'x.com', pathname: '/api/article', ...over }, args: [], responseShape: { kind: 'array' } } as unknown as RankCandidate);

  it('按 method+host+pathname 精确匹配:拒绝跨 host / GET-vs-POST / `/api/article` 误召回 `/api/articles`', async () => {
    const { buildSampleSummary } = await import('../src/llm/synthesize.js');
    const sample = {
      sampleName: 'A' as const,
      entries: [
        { method: 'GET', url: 'https://x.com/api/article?id=1', responseStatus: 200, responsePreview: '[{"t":1}]', timestamp: 1 }, // ✓ 命中
        { method: 'GET', url: 'https://other.com/api/article?id=2', responseStatus: 200, responsePreview: '[]', timestamp: 2 }, // ✗ 跨 host
        { method: 'POST', url: 'https://x.com/api/article', responseStatus: 200, responsePreview: '[]', timestamp: 3 }, // ✗ 方法不同
        { method: 'GET', url: 'https://x.com/api/articles?id=3', responseStatus: 200, responsePreview: '[]', timestamp: 4 }, // ✗ 子串误召回
      ],
    };
    const summary = buildSampleSummary(sample as never, ep()) as Record<string, unknown>;
    const calls = summary.endpointCalls as Array<{ url: string }>;
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://x.com/api/article?id=1');
  });

  it('URL 解析失败 → 回退 pathname 子串匹配(不丢证据)', async () => {
    const { buildSampleSummary } = await import('../src/llm/synthesize.js');
    const sample = {
      sampleName: 'A' as const,
      entries: [{ method: 'GET', url: '/api/article?id=1', responseStatus: 200, responsePreview: '[{"t":1}]', timestamp: 1 }], // 相对 URL,new URL 抛错
    };
    const summary = buildSampleSummary(sample as never, ep()) as Record<string, unknown>;
    expect((summary.endpointCalls as unknown[])).toHaveLength(1);
  });

  it('证据去重:同 endpoint 多次调用只保留前 3 条 responseBody,其余仍列出但省略 body', async () => {
    const { buildSampleSummary } = await import('../src/llm/synthesize.js');
    const entries = Array.from({ length: 6 }, (_, i) => ({
      method: 'GET', url: `https://x.com/api/article?id=${i}`, responseStatus: 200, responsePreview: `[{"t":${i}}]`, timestamp: i,
    }));
    const summary = buildSampleSummary({ sampleName: 'A', entries } as never, ep()) as Record<string, unknown>;
    const calls = summary.endpointCalls as Array<{ responseBody?: string }>;
    expect(calls).toHaveLength(6); // 全部列出(method/url/status 保留)
    expect(calls.filter((c) => c.responseBody !== undefined)).toHaveLength(3); // 仅前 3 条带 body
  });
});

describe('buildScoreEvidenceSummary · score 侧压缩', () => {
  const ep = (over: Record<string, unknown> = {}) =>
    ({ id: 'c', endpoint: { method: 'GET', host: 'x.com', pathname: '/api/article', ...over }, args: [], responseShape: { kind: 'object' } } as unknown as RankCandidate);

  it('emits NO responseBody, has responseSummary + urlParams(不重复整条 URL)', async () => {
    const { buildScoreEvidenceSummary } = await import('../src/llm/synthesize.js');
    const body = JSON.stringify({ err_no: 0, data: [{ title: 'a', author: { name: 'x' }, view: 1 }] });
    const sample = {
      sampleName: 'A' as const,
      entries: [{ method: 'GET', url: 'https://x.com/api/article?id=1&cat=hot', responseStatus: 200, responsePreview: body, timestamp: 1 }],
      actions: [{ type: 'input', selector: '#q', ts: 0, valueShape: { len: 3 } }],
    };
    const ev = buildScoreEvidenceSummary(sample as never, ep());
    // 无 responseBody 字段
    const blob = JSON.stringify(ev);
    expect(blob).not.toContain('responseBody');
    // endpointCalls 用 urlParams 而非整条 URL
    expect(ev.endpointCalls).toHaveLength(1);
    expect(ev.endpointCalls[0].urlParams).toEqual({ id: '1', cat: 'hot' });
    expect(blob).not.toContain('https://x.com/api/article');
    // responseSummary 存在且是结构摘要(有 rowPath/kind)
    expect(ev.responseSummary?.kind).toBe('object');
    expect(ev.responseSummary?.rowPath).toBe('data');
    // 不含样本值
    expect(blob).not.toContain('"title":"a"');
  });

  it('responseSummary 每 endpoint 只一份(多次匹配调用不重复摘要)', async () => {
    const { buildScoreEvidenceSummary } = await import('../src/llm/synthesize.js');
    const entries = Array.from({ length: 4 }, (_, i) => ({
      method: 'GET', url: `https://x.com/api/article?id=${i}`, responseStatus: 200, responsePreview: JSON.stringify({ data: [{ title: 't' }] }), timestamp: i,
    }));
    const ev = buildScoreEvidenceSummary({ sampleName: 'A', entries } as never, ep());
    expect(ev.endpointCalls).toHaveLength(4); // 全列出
    expect(ev.responseSummary).toBeDefined(); // 但只一份摘要(单对象,非数组)
    expect(Array.isArray(ev.responseSummary)).toBe(false);
  });

  it('导航去 origin 只留 path+query;score 侧 actions 不带 selector(只留 type/valueShape/key)', async () => {
    const { buildScoreEvidenceSummary } = await import('../src/llm/synthesize.js');
    const longSel = '#' + 'a'.repeat(100);
    const sample = {
      sampleName: 'A' as const,
      entries: [],
      actions: [
        { type: 'navigate', ts: 1, url: 'https://x.com/search?q=apple&extra=1' },
        { type: 'input', selector: longSel, ts: 2, valueShape: { len: 5, kind: 'text' } },
        { type: 'keydown', selector: longSel, ts: 3, key: 'Enter' },
      ],
    };
    const ev = buildScoreEvidenceSummary(sample as never, ep());
    expect(ev.navigations[0]).toBe('/search?q=apple&extra=1');
    expect(ev.navigations[0]).not.toContain('https://x.com');
    // 15-doc 阶段二 #1:score 侧 evidence 不再带 selector(对判信号无用,是纯冗余大头)。
    expect(ev.actions.every((a) => a.selector === undefined)).toBe(true);
    // 但保留信号线索:valueShape.len(seed 长度差异)+ key(Enter 等提交语义)。
    expect(ev.actions.find((a) => a.valueShape)?.valueShape).toEqual({ len: 5, kind: 'text' });
    expect(ev.actions.find((a) => a.key)?.key).toBe('Enter');
  });

  it('15-doc 阶段二 #2:urlParams 只留证明性键(删证实稳定的常量,留 seed/cursor/unknown)', async () => {
    const { buildScoreEvidenceSummary } = await import('../src/llm/synthesize.js');
    // paramObservations:query 变(seed)、cursor 变+cursorLike(分页)、aid/spider 稳定常量、cat unknown。
    const cand = {
      id: 'c', endpoint: { method: 'GET', host: 'x.com', pathname: '/api/s' }, args: [], responseShape: { kind: 'object' },
      paramObservations: [
        { name: 'query', in: 'query', observedVariation: true },
        { name: 'cursor', in: 'query', observedVariation: true, cursorLike: true },
        { name: 'aid', in: 'query', observedVariation: false },
        { name: 'spider', in: 'query', observedVariation: false },
        { name: 'cat', in: 'query', observedVariation: 'unknown' },
      ],
    } as unknown as RankCandidate;
    const sample = {
      sampleName: 'A' as const,
      entries: [{ method: 'GET', url: 'https://x.com/api/s?query=apple&cursor=0&aid=2608&spider=0&cat=hot', responseStatus: 200, responsePreview: '{"data":[{"t":1}]}', timestamp: 1 }],
    };
    const ev = buildScoreEvidenceSummary(sample as never, cand);
    const up = ev.endpointCalls[0].urlParams;
    // 保留:seed(query)、分页(cursor)、unknown(cat) —— 都是证明性/判不准
    expect(up.query).toBe('apple');
    expect(up.cursor).toBe('0');
    expect(up.cat).toBe('hot');
    // 删:证实稳定的常量(aid/spider),其名字与稳定性已在 paramObservations 表
    expect(up.aid).toBeUndefined();
    expect(up.spider).toBeUndefined();
  });

  it('15-doc 阶段二 #2:无 paramObservations 时全保留(安全兜底,不误删)', async () => {
    const { buildScoreEvidenceSummary } = await import('../src/llm/synthesize.js');
    const cand = { id: 'c', endpoint: { method: 'GET', host: 'x.com', pathname: '/api/s' }, args: [], responseShape: { kind: 'object' } } as unknown as RankCandidate;
    const sample = {
      sampleName: 'A' as const,
      entries: [{ method: 'GET', url: 'https://x.com/api/s?a=1&b=2', responseStatus: 200, responsePreview: '{"data":[]}', timestamp: 1 }],
    };
    const ev = buildScoreEvidenceSummary(sample as never, cand);
    expect(ev.endpointCalls[0].urlParams).toEqual({ a: '1', b: '2' });
  });
});


