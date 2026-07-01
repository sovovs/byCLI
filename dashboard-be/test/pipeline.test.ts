// N4 编排单测(注入 fake scorer/generator/verifyDraft):score→选 generate→生成→静态检查→verify→收集。
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { runPipeline, type PipelineDeps, type PipelineInput } from '../src/llm/pipeline.js';
import { cleanupDraftDir } from '../src/llm/draft-store.js';
import type { RankCandidate } from '@sovovs/bycli-recorder-core';

const input: PipelineInput = {
  candidates: [
    { id: 'c1', endpoint: { method: 'GET', pathname: '/api/search' } } as unknown as RankCandidate,
    { id: 'c2', endpoint: { method: 'POST', pathname: '/track' } } as unknown as RankCandidate,
  ],
  samples: [{ sampleName: 'A', entries: [] }],
};

const GOOD_SRC = "import { cli } from '@sovovs/bycli/registry'; cli({ site:'x', name:'search', func: async (k) => { const r = await fetch('https://x.com/api/search'); return await r.json(); } });";
const BAD_SRC = "const fs = require('fs'); cli({});"; // 静态检查会拦

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) if (d) cleanupDraftDir(d); dirs = []; });

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    scorer: { async score() { return { candidates: [
      { candidateId: 'c1', score: 55, uiScore: 55, confidence: 'medium', decision: 'generate', isDataEndpoint: true, signals: [], risks: [], reason: 'data' },
      { candidateId: 'c2', score: -100, uiScore: 0, confidence: 'rejected', decision: 'reject', isDataEndpoint: false, signals: [], risks: [], reason: 'mutation' },
    ] }; } },
    generator: { async generate() { return { scripts: [
      { candidateId: 'c1', site: 'x', name: 'search', description: '', access: 'read', domain: 'x.com', strategy: 'PUBLIC', browser: false, scriptKind: 'func', args: [], columns: ['t'], source: GOOD_SRC, verifyExpectation: { commandName: 'x/search', verifyArgs: { q: 'cat' }, minRows: 1, expectedFieldCount: 1, allowedOrigins: ['https://x.com'], expectedStage: 'execute' }, risks: [], notes: [] },
    ], skipped: [] }; } },
    verifyDraft: async () => ({ ok: true, stage: 'execute', rows: 3, fieldCount: 1 }),
    ...over,
  };
}

describe('runPipeline', () => {
  it('score→只对 decision=generate 生成→静态通过→verify 达标→usable 草稿', async () => {
    const d = deps();
    const r = await runPipeline(input, d);
    expect(r).not.toBeNull();
    dirs.push(r!.draftDir);
    expect(r!.drafts).toHaveLength(1);
    expect(r!.drafts[0]).toMatchObject({ candidateId: 'c1', usable: true, staticOk: true, score: 55, confidence: 'medium' });
    expect(r!.drafts[0].verify).toMatchObject({ ok: true, rows: 3, fieldCount: 1 });
    expect(r!.rejected).toEqual([{ candidateId: 'c2', reason: 'mutation' }]); // 写操作不生成
    expect(existsSync(r!.draftDir)).toBe(true);
  });

  it('静态检查不通过 → staticOk:false、usable:false、不 verify', async () => {
    let verifyCalled = 0;
    const d = deps({
      generator: { async generate() { return { scripts: [{ candidateId: 'c1', site: 'x', name: 'bad', description: '', access: 'read', domain: 'x.com', strategy: 'PUBLIC', browser: false, scriptKind: 'func', args: [], columns: [], source: BAD_SRC, risks: [], notes: [] }], skipped: [] }; } },
      verifyDraft: async () => { verifyCalled++; return { ok: true, rows: 1 }; },
    });
    const r = await runPipeline(input, d);
    dirs.push(r!.draftDir);
    expect(r!.drafts[0].staticOk).toBe(false);
    expect(r!.drafts[0].usable).toBe(false);
    expect(verifyCalled).toBe(0); // 静态没过不 verify
  });

  it('verify 不达标 → usable:false', async () => {
    const d = deps({ verifyDraft: async () => ({ ok: true, rows: 0, fieldCount: 1, stage: 'execute' }) });
    const r = await runPipeline(input, d);
    dirs.push(r!.draftDir);
    expect(r!.drafts[0].usable).toBe(false);
    expect(r!.drafts[0].verify.reasons.join()).toContain('rows');
  });

  it('无 generate 候选 → 空 drafts + rejected 列出', async () => {
    const d = deps({ scorer: { async score() { return { candidates: [{ candidateId: 'c2', score: -100, uiScore: 0, confidence: 'rejected', decision: 'reject', isDataEndpoint: false, signals: [], risks: [], reason: 'mutation' }] }; } } });
    const r = await runPipeline(input, d);
    expect(r!.drafts).toEqual([]);
    expect(r!.draftDir).toBe('');
    expect(r!.rejected.length).toBe(1);
  });

  it('scorer/generator 返回 null → 整体 null', async () => {
    expect(await runPipeline(input, deps({ scorer: { async score() { return null; } } }))).toBeNull();
    expect(await runPipeline(input, deps({ generator: { async generate() { return null; } } }))).toBeNull();
  });

  it('Bug1:ScoredCandidate 的 paramUnion/inferredFunction merge 回候选喂给 generator', async () => {
    let seen: RankCandidate | undefined;
    const d = deps({
      scorer: { async score() { return { candidates: [
        { candidateId: 'c1', score: 55, uiScore: 55, confidence: 'medium', decision: 'generate', isDataEndpoint: true, signals: [], risks: [], reason: 'data',
          inferredFunction: '按关键词搜索文章',
          paramUnion: [{ name: 'q', in: 'query', paramRole: 'seed_argument', exposeAsArg: 'yes', inferredMeaning: '关键词' }] },
      ] }; } },
      generator: { async generate(gi) {
        seen = gi.candidates[0];
        return { scripts: [], skipped: [] };
      } },
    });
    const r = await runPipeline(input, d);
    if (r?.draftDir) dirs.push(r.draftDir);
    expect(seen?.inferredFunction).toBe('按关键词搜索文章');
    expect(seen?.paramUnion?.[0]).toMatchObject({ name: 'q', paramRole: 'seed_argument', exposeAsArg: 'yes' });
    // 展示用 generate prompt 也应含语义提示
    expect(r!.prompts.generate).toContain('seed_argument');
  });

  it('Bug1:LLM-off(scored 无语义字段)不覆盖原候选,向后兼容', async () => {
    let seen: RankCandidate | undefined;
    const d = deps({
      generator: { async generate(gi) { seen = gi.candidates[0]; return { scripts: [], skipped: [] }; } },
    });
    const r = await runPipeline(input, d);
    if (r?.draftDir) dirs.push(r.draftDir);
    expect(seen?.id).toBe('c1');
    expect(seen?.paramUnion).toBeUndefined();
    expect(seen?.inferredFunction).toBeUndefined();
  });

  it('verify 失败(抽取类)→ 一次 repair-generate + 重 verify;修复后达标 → usable', async () => {
    let verifyCalls = 0;
    let repairCalls = 0;
    const REPAIRED = "import { cli } from '@sovovs/bycli/registry'; cli({ site:'x', name:'search', func: async (k) => { const r = await fetch('https://x.com/api/search'); const j = await r.json(); return j.data; } });";
    const d = deps({
      generator: {
        async generate() { return { scripts: [
          { candidateId: 'c1', site: 'x', name: 'search', description: '', access: 'read', domain: 'x.com', strategy: 'PUBLIC', browser: false, scriptKind: 'func', args: [], columns: ['t'], source: GOOD_SRC, verifyExpectation: { commandName: 'x/search', verifyArgs: { q: 'cat' }, minRows: 1, expectedFieldCount: 1, allowedOrigins: ['https://x.com'], expectedStage: 'execute' }, risks: [], notes: [] },
        ], skipped: [] }; },
        async generateRepair(ri) {
          repairCalls++;
          expect(ri.candidate.id).toBe('c1');
          expect(ri.failure).toContain('rows'); // 失败原因透传
          return { candidateId: 'c1', site: 'x', name: 'search', description: '', access: 'read', domain: 'x.com', strategy: 'PUBLIC', browser: false, scriptKind: 'func', args: [], columns: ['t'], source: REPAIRED, verifyExpectation: { commandName: 'x/search', verifyArgs: { q: 'cat' }, minRows: 1, expectedFieldCount: 1, allowedOrigins: ['https://x.com'], expectedStage: 'execute' }, risks: [], notes: [] };
        },
      },
      // 首次 verify 失败(rows 0),repair 后成功(rows 3)。
      verifyDraft: async () => { verifyCalls++; return verifyCalls === 1 ? { ok: true, stage: 'execute', rows: 0, fieldCount: 1 } : { ok: true, stage: 'execute', rows: 3, fieldCount: 1 }; },
    });
    const r = await runPipeline(input, d);
    dirs.push(r!.draftDir);
    expect(repairCalls).toBe(1);            // repair 恰好一次(有界)
    expect(verifyCalls).toBe(2);            // 原 verify + repair verify
    expect(r!.drafts[0].usable).toBe(true); // 修复后达标
    expect(r!.drafts[0].source).toContain('j.data'); // 采用修复源码
  });

  it('无 generateRepair(旧 Generator)→ 跳过 repair,行为同旧', async () => {
    let verifyCalls = 0;
    const d = deps({ verifyDraft: async () => { verifyCalls++; return { ok: true, rows: 0, fieldCount: 1, stage: 'execute' }; } });
    const r = await runPipeline(input, d); // deps().generator 无 generateRepair
    dirs.push(r!.draftDir);
    expect(verifyCalls).toBe(1);             // 只 verify 一次,不 repair
    expect(r!.drafts[0].usable).toBe(false);
  });
});
