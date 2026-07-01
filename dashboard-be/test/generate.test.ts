// N2 多脚本生成单测:解析 LLM 返回的完整脚本 + 默认值 + 过滤无效(缺 source/site/name)。
import { describe, it, expect } from 'vitest';
import {
  createGenerator,
  buildGenPrompt,
  buildGenPromptForCandidateWithStat,
  buildRepairPrompt,
  type GenerateInput,
} from '../src/llm/generate.js';
import type { LlmClient } from '../src/llm/synthesize.js';
import type { RankCandidate } from '@sovovs/bycli-recorder-core';

const input: GenerateInput = {
  candidates: [{ id: 'cand_1', endpoint: { method: 'GET', pathname: '/api/search' } } as unknown as RankCandidate],
  samples: [{ sampleName: 'A', entries: [] }],
};
const fake = (payload: unknown): LlmClient => ({ messages: { async create() { return { content: [{ type: 'text', text: JSON.stringify(payload) }] }; } } });

describe('createGenerator', () => {
  it('解析完整脚本 + 默认值', async () => {
    const g = createGenerator({ model: 'm', client: fake({
      scripts: [
        { candidateId: 'cand_1', site: 'x', name: 'search', source: "import {cli} from '@sovovs/bycli/registry'; cli({});",
          columns: ['title'], strategy: 'COOKIE', browser: true, scriptKind: 'func',
          verifyExpectation: { commandName: 'x/search', verifyArgs: { q: 'cat' }, minRows: 1, expectedFieldCount: 1, allowedOrigins: ['https://x.com'], expectedStage: 'execute' } },
        { candidateId: 'bad', site: 'x' }, // 缺 source/name → 过滤
      ],
      skipped: [{ candidateId: 'cand_2', reason: 'analytics' }],
    }) });
    const r = await g.generate(input);
    expect(r).not.toBeNull();
    expect(r!.scripts).toHaveLength(1);
    expect(r!.scripts[0]).toMatchObject({ candidateId: 'cand_1', site: 'x', name: 'search', access: 'read', strategy: 'COOKIE', browser: true, scriptKind: 'func', columns: ['title'] });
    expect(r!.scripts[0].verifyExpectation?.minRows).toBe(1);
    expect(r!.skipped[0]).toEqual({ candidateId: 'cand_2', reason: 'analytics' });
  });

  it('默认 access=read / strategy=PUBLIC / scriptKind=func', async () => {
    const g = createGenerator({ model: 'm', client: fake({ scripts: [{ candidateId: 'c', site: 's', name: 'n', source: 'cli({});' }] }) });
    const r = await g.generate(input);
    expect(r!.scripts[0]).toMatchObject({ access: 'read', strategy: 'PUBLIC', browser: false, scriptKind: 'func' });
  });

  it('无 client → null;坏 JSON → null', async () => {
    expect(await createGenerator({ model: 'm' }).generate(input)).toBeNull();
    expect(await createGenerator({ model: 'm', client: fake('nope' as unknown) }).generate(input)).toBeNull();
  });
});

describe('buildGenPrompt', () => {
  it('Bug1:候选带 paramUnion/inferredFunction 时,prompt 透出角色/暴露/用途给生成器', () => {
    const withSemantics: GenerateInput = {
      candidates: [{
        id: 'cand_1',
        endpoint: { method: 'GET', pathname: '/api/search' },
        inferredFunction: '按关键词搜索文章',
        paramUnion: [
          { name: 'q', in: 'query', paramRole: 'seed_argument', exposeAsArg: 'yes', inferredMeaning: '搜索关键词' },
          { name: '_t', in: 'query', paramRole: 'dynamic', exposeAsArg: 'no', inferredMeaning: '时间戳' },
        ],
      } as unknown as RankCandidate],
      samples: [{ sampleName: 'A', entries: [] }],
    };
    const prompt = buildGenPrompt(withSemantics);
    expect(prompt).toContain('按关键词搜索文章'); // inferredFunction
    expect(prompt).toContain('seed_argument');    // paramRole
    expect(prompt).toContain('exposeAsArg');
    expect(prompt).toContain('搜索关键词');        // inferredMeaning
    expect(prompt).toContain('paramUnion');        // PROMPT_B 指令提到据 paramUnion 决定入参
  });

  it('Bug1:LLM-off 候选(无 paramUnion/inferredFunction)向后兼容,不报错', () => {
    const prompt = buildGenPrompt(input); // input.candidates 无语义字段
    expect(prompt).toContain('cand_1');
    expect(typeof prompt).toBe('string');
  });
});

// 第2步:generate 喂详细 responseSchema(非原始响应体)。
function sampleWith(preview: string) {
  return { sampleName: 'A' as const, entries: [{ method: 'GET', url: 'https://x.com/api/search?q=cat', responseStatus: 200, responsePreview: preview, timestamp: 1 }] };
}
const cand = (over: Partial<RankCandidate> = {}): RankCandidate =>
  ({ id: 'cand_1', endpoint: { method: 'GET', pathname: '/api/search' }, ...over } as unknown as RankCandidate);

describe('buildGenPrompt · responseSchema(非原始响应体)', () => {
  it('prompt 含 responseSchema/recommendedRowPath,不含原始响应体大块', () => {
    const body = JSON.stringify({ err_no: 0, data: [{ title: 'UNIQUE_TITLE_XYZ', author: 'a', view: 9 }] });
    const gi: GenerateInput = { candidates: [cand()], samples: [sampleWith(body)] };
    const prompt = buildGenPrompt(gi);
    expect(prompt).toContain('responseSchema');
    expect(prompt).toContain('recommendedRowPath');
    expect(prompt).toContain('recommendedColumns');
    // 不再有 responseBody 字段(原始体只在 repair 才出现)
    expect(prompt).not.toContain('"responseBody"');
    // PROMPT_B 指导用 responseSchema 写抽取
    expect(prompt).toContain('用 responseSchema 写抽取逻辑');
  });
});

describe('buildGenPromptForCandidateWithStat · 预算闸门', () => {
  it('超 15KB → 逐级降级到预算内', () => {
    // 造一个巨大响应体:很多行 + 每行很多长字符串字段。
    const row: Record<string, unknown> = {};
    for (let i = 0; i < 80; i++) row['field_' + i] = 'value_' + i + '_' + 'z'.repeat(60);
    const big = JSON.stringify({ data: Array.from({ length: 50 }, () => row) });
    const { prompt, stat } = buildGenPromptForCandidateWithStat(cand(), [sampleWith(big)]);
    expect(prompt.length).toBeLessThanOrEqual(15_000);
    expect(stat.degraded.length).toBeGreaterThan(0); // 确实降过级
    // 命脉保留:recommendedRowPath/recommendedColumns 仍在
    expect(prompt).toContain('recommendedRowPath');
    expect(prompt).toContain('recommendedColumns');
  });

  it('小响应体 → 不降级', () => {
    const body = JSON.stringify({ data: [{ title: 't', view: 1 }] });
    const { prompt, stat } = buildGenPromptForCandidateWithStat(cand(), [sampleWith(body)]);
    expect(stat.degraded).toEqual([]);
    expect(prompt.length).toBeLessThanOrEqual(15_000);
  });
});

describe('createGenerator · 逐候选调用(per-candidate)', () => {
  it('多候选 → 逐个各发一次 LLM 调用', async () => {
    let calls = 0;
    const client: LlmClient = { messages: { async create() {
      calls++;
      return { content: [{ type: 'text', text: JSON.stringify({ scripts: [{ candidateId: 'c', site: 'x', name: 'n' + calls, source: 'cli();' }] }) }] };
    } } };
    const g = createGenerator({ model: 'm', client });
    const gi: GenerateInput = {
      candidates: [cand({ id: 'a' } as never), cand({ id: 'b' } as never), cand({ id: 'c' } as never)],
      samples: [sampleWith(JSON.stringify({ data: [{ title: 't' }] }))],
    };
    const r = await g.generate(gi);
    expect(calls).toBe(3); // 3 候选 = 3 次调用(非 1 次批量)
    expect(r!.scripts).toHaveLength(3);
  });

  it('单候选失败不拖垮其它候选', async () => {
    let calls = 0;
    const client: LlmClient = { messages: { async create() {
      calls++;
      if (calls === 1) throw new Error('boom'); // 第一个候选失败
      return { content: [{ type: 'text', text: JSON.stringify({ scripts: [{ candidateId: 'c', site: 'x', name: 'ok', source: 'cli({});' }] }) }] };
    } } };
    const g = createGenerator({ model: 'm', client });
    const gi: GenerateInput = {
      candidates: [cand({ id: 'a' } as never), cand({ id: 'b' } as never)],
      samples: [sampleWith(JSON.stringify({ data: [{ title: 't' }] }))],
    };
    const r = await g.generate(gi);
    expect(r).not.toBeNull();
    expect(r!.scripts).toHaveLength(1);       // 第二个候选仍产出
    expect(r!.skipped.some((s) => s.reason === 'generate_error')).toBe(true);
  });
});

describe('buildRepairPrompt · 渐进披露(唯一注入原始样本)', () => {
  it('repair prompt 含一小段原始 row 样本 + 失败原因', () => {
    const body = JSON.stringify({ data: [{ title: 'REPAIR_SAMPLE_TITLE', view: 42 }] });
    const p = buildRepairPrompt({
      candidate: cand(),
      samples: [sampleWith(body)],
      failure: 'rows 0 < 期望 1',
      previousSource: 'cli({ /* old */ });',
    });
    expect(p).toContain('REPAIR_SAMPLE_TITLE'); // 原始样本被注入
    expect(p).toContain('rows 0 < 期望 1');      // 失败原因
    expect(p).toContain('cli({ /* old */ });');  // 上一版源码
    expect(p).toContain('首个元素');              // 渐进披露说明
  });

  it('generateRepair 解析首个有效脚本', async () => {
    const client: LlmClient = { messages: { async create() {
      return { content: [{ type: 'text', text: JSON.stringify({ scripts: [{ candidateId: 'c', site: 'x', name: 'fixed', source: 'cli({});', columns: ['title'] }] }) }] };
    } } };
    const g = createGenerator({ model: 'm', client });
    const r = await g.generateRepair!({
      candidate: cand(),
      samples: [sampleWith(JSON.stringify({ data: [{ title: 't' }] }))],
      failure: 'fieldCount 0 ≠ 期望 3',
    });
    expect(r).not.toBeNull();
    expect(r!.name).toBe('fixed');
  });

  it('无 client → generateRepair null', async () => {
    const g = createGenerator({ model: 'm' });
    expect(await g.generateRepair!({ candidate: cand(), samples: [], failure: 'x' })).toBeNull();
  });
});
