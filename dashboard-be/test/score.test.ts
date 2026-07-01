// N1 评分单测:be 按成立信号的 profile delta 求和算权威分(LLM 只判 present),band/decision/排序正确。
import { describe, it, expect } from 'vitest';
import { createScorer, isConfirmedJunk, selectCandidatesForLlm, buildScorePrompt, buildScorePromptWithStat, type ScoreInput } from '../src/llm/score.js';
import type { LlmClient } from '../src/llm/synthesize.js';
import type { RankCandidate } from '@sovovs/bycli-recorder-core';
import { DEFAULT_SCORING_PROFILE } from '@sovovs/bycli-recorder-core';

const cand = (id: string, pathname: string): RankCandidate =>
  ({ id, score: 40, confidence: 'low', endpoint: { method: 'GET', pathname, urlTemplate: `https://x.com${pathname}?q={k}` }, args: [], responseShape: { kind: 'array' } } as unknown as RankCandidate);

const input: ScoreInput = {
  candidates: [cand('cand_1', '/api/search'), cand('cand_2', '/track'), cand('cand_3', '/page')],
  samples: [
    { sampleName: 'A', entries: [{ method: 'GET', url: 'https://x.com/api/search?q=cat', responseStatus: 200, responsePreview: '[{"t":1}]', timestamp: 1100 }] },
    { sampleName: 'B', entries: [{ method: 'GET', url: 'https://x.com/api/search?q=dog', responseStatus: 200, responsePreview: '[{"t":2}]', timestamp: 2100 }] },
  ],
};

function fakeClient(payload: unknown): LlmClient {
  return { messages: { async create() { return { content: [{ type: 'text', text: JSON.stringify(payload) }] }; } } };
}

describe('createScorer', () => {
  it('be 按成立信号 delta 求和算分(30+20+10=60→medium→generate),present:false 排除', async () => {
    const s = createScorer({ model: 'm', client: fakeClient({ candidates: [
      { candidateId: 'cand_1', isDataEndpoint: true, hardReject: null, signals: [
        { name: 'stable_json_shape', present: true, why: 'array' },
        { name: 'seed_arg_maps_to_param', present: true },
        { name: 'response_echoes_seed', present: true },
        { name: 'dynamic_field', present: false },
      ], risks: [], reason: 'data ep' },
      { candidateId: 'cand_2', isDataEndpoint: false, hardReject: 'confirmed_analytics', signals: [], risks: ['telemetry'], reason: 'analytics' },
      { candidateId: 'cand_3', isDataEndpoint: true, hardReject: null, signals: [{ name: 'weak_html_static', present: true }], reason: 'htmlish' },
    ] }) });
    const r = await s.score(input);
    expect(r).not.toBeNull();
    const byId = Object.fromEntries(r!.candidates.map((c) => [c.candidateId, c]));
    expect(byId.cand_1).toMatchObject({ score: 60, uiScore: 60, confidence: 'medium', decision: 'generate', isDataEndpoint: true });
    expect(byId.cand_1.signals).toHaveLength(3); // dynamic_field(present:false) 被排除
    expect(byId.cand_2).toMatchObject({ score: 0, confidence: 'rejected', decision: 'reject', isDataEndpoint: false }); // hardReject
    expect(byId.cand_3).toMatchObject({ score: -25, confidence: 'rejected', decision: 'reject' }); // <20
    // 排序:非 rejected 在前;rejected 内 score 降序(cand_2 0 > cand_3 -25)
    expect(r!.candidates.map((c) => c.candidateId)).toEqual(['cand_1', 'cand_2', 'cand_3']);
  });

  it('B:稳定无参数据接口(stable_json only=30,seed 未映射)→ generate;非数据 low → 仍 review', async () => {
    const s = createScorer({ model: 'm', client: fakeClient({ candidates: [
      // 稳定列表数据,seed 未映射(只有 stable_json_shape=30 → 默认是 low/review)→ B 放行 generate
      { candidateId: 'cand_1', isDataEndpoint: true, hardReject: null,
        signals: [{ name: 'stable_json_shape', present: true, why: '热门排行 array' }],
        risks: ['input_independent_across_ab'], reason: '固定排行列表' },
      // 稳定列表 + dynamic_field 信号(但候选无 paramObservations 事实 → 分级动态惩罚 0)→ 仍 30 → low → generate。
      // 14-plan 校准:dynamic_field 不再经 profile 平惩罚 -10;真惩罚按参数事实分级(见下方 signed/cacheBuster 用例)。
      { candidateId: 'cand_2', isDataEndpoint: true, hardReject: null,
        signals: [{ name: 'stable_json_shape', present: true }, { name: 'dynamic_field', present: true }], reason: '带_t' },
      // 非数据列表:只有 seed_arg(20=low)但无 stable_json → 不是无参数据命令 → 仍 review
      { candidateId: 'cand_3', isDataEndpoint: true, hardReject: null,
        signals: [{ name: 'seed_arg_maps_to_param', present: true }], reason: '无稳定列表' },
    ] }) });
    const r = await s.score(input);
    const byId = Object.fromEntries(r!.candidates.map((c) => [c.candidateId, c]));
    expect(byId.cand_1).toMatchObject({ score: 30, confidence: 'low', decision: 'generate' });
    expect(byId.cand_2).toMatchObject({ score: 30, confidence: 'low', decision: 'generate' }); // dynamic_field 无事实 → 0 惩罚
    expect(byId.cand_3).toMatchObject({ score: 20, confidence: 'low', decision: 'review' });    // 非数据列表不放行
  });

  it('Bug2:present ruleSignal 重名只计一次(stable_json_shape×2 → +30 而非 +60)', async () => {
    const s = createScorer({ model: 'm', client: fakeClient({ interfaces: [
      { candidateId: 'cand_1', isDataEndpoint: true, hardReject: null, ruleSignals: [
        { name: 'stable_json_shape', present: true, why: 'array#1' },
        { name: 'stable_json_shape', present: true, why: 'array#2' }, // 重复 → 不叠加
      ], reason: 'dup rule signal' },
    ] }) });
    const r = await s.score(input);
    const c = r!.candidates.find((x) => x.candidateId === 'cand_1')!;
    expect(c.score).toBe(30); // 首现计一次,不是 60
    expect(c.signals).toHaveLength(1);
    expect(c.scoreExplanation.filter((e) => e.signal === 'stable_json_shape')).toHaveLength(1);
    expect(c.scoreExplanation[0]).toMatchObject({ signal: 'stable_json_shape', delta: 30, detail: 'array#1' }); // 首现 why 保留
  });


  it('LLM 自报的总分被忽略,以 be 重算为准(防漂移)', async () => {
    const s = createScorer({ model: 'm', client: fakeClient({ candidates: [
      { candidateId: 'cand_1', score: 999, signals: [{ name: 'requires_session', present: true }] }, // LLM 乱报 999
    ] }) });
    const r = await s.score(input);
    expect(r!.candidates[0].score).toBe(5); // requires_session=+5,不是 999
  });

  it('无 client → null;坏 JSON → null', async () => {
    expect(await createScorer({ model: 'm' }).score(input)).toBeNull();
    expect(await createScorer({ model: 'm', client: fakeClient('not json' as unknown) }).score(input)).toBeNull();
    const bad = { messages: { async create() { return { content: [{ type: 'text', text: 'no json here' }] }; } } } as LlmClient;
    expect(await createScorer({ model: 'm', client: bad }).score(input)).toBeNull();
  });

  it('新 PROMPT_A 输出形状(interfaces/ruleSignals/paramUnion/semanticSignals)→ 解析 + be 用 delta 求和', async () => {
    const s = createScorer({ model: 'm', client: fakeClient({ interfaces: [
      { candidateId: 'cand_1', isDataEndpoint: true, hardReject: null,
        inferredFunction: '按关键词搜索文章并返回结果列表',
        method: 'GET', pathname: '/api/search',
        paramUnion: [
          { name: 'q', in: 'query', paramRole: 'seed_argument', exposeAsArg: 'yes', observedVariation: true, inferredMeaning: '搜索关键词', why: 'A/B 随输入变' },
          { name: 'type', in: 'query', paramRole: 'query_dimension', exposeAsArg: 'optional_candidate', observedVariation: false, why: '查询维度即使未变' },
        ],
        ruleSignals: [
          { name: 'stable_json_shape', present: true, why: 'array' },
          { name: 'seed_arg_maps_to_param', present: true, why: 'q 映射' },
          { name: 'dynamic_field', present: false },
        ],
        // 第4步:response_varies_with_seed 现在是**语义信号**(不再在 rule 轨别名到 echo delta)。
        semanticSignals: [
          { name: 'response_varies_with_seed', strength: 'strong', why: 'A/B 响应不同' }, // 15
          { name: 'rich_business_data', strength: 'strong', why: '字段丰富' },            // 15(校准 10→15)
          { name: 'query_dimensions_available', strength: 'medium' },                     // 5(校准:已补进 allowlist)
        ],
        llmUtilityScore: 88, llmUtilityBand: 'high',
        risks: [], scoreRationale: '强 seed 数据接口' },
    ] }) });
    const r = await s.score(input);
    expect(r).not.toBeNull();
    const c = r!.candidates[0];
    // 双轨:rule 30(stable)+20(seed)=50;
    // semanticBonus = response_varies_with_seed(strong=15) + rich_business_data(strong=15)
    //   + query_dimensions_available(medium=5,校准后进 allowlist) = 35(< cap 40);
    // finalScore = 50+35 = 85 → high(70 阈值现可达,双轨证明)→ generate。
    expect(c).toMatchObject({ candidateId: 'cand_1', score: 85, confidence: 'high', decision: 'generate', isDataEndpoint: true });
    expect(c.semanticBonus).toBe(35);
    expect(c.inferredFunction).toBe('按关键词搜索文章并返回结果列表');
    expect(c.paramUnion).toHaveLength(2);
    expect(c.paramUnion!.find((p) => p.name === 'type')!.paramRole).toBe('query_dimension'); // 未变也是查询维度
    expect(c.semanticSignals).toHaveLength(3);
    expect(c.llmUtilityScore).toBe(88); // 透传但不参与权威分
    expect(c.reason).toBe('强 seed 数据接口'); // scoreRationale → reason
    // signals(向后兼容字段)只含成立的 ruleSignal,server.ts 据此建 scoreExplanation
    expect(c.signals.map((x) => x.name).sort()).toEqual(['seed_arg_maps_to_param', 'stable_json_shape']);
    // scoreExplanation 真 delta:rule signal=profile delta、semantic signal=bonus delta,无 delta:0。
    const seedExp = c.scoreExplanation.find((e) => e.signal === 'seed_arg_maps_to_param');
    expect(seedExp!.delta).toBe(20);
    expect(c.scoreExplanation.find((e) => e.signal === 'rich_business_data')!.delta).toBe(15);
    expect(c.scoreExplanation.find((e) => e.signal === 'response_varies_with_seed')!.delta).toBe(15);
    expect(c.scoreExplanation.find((e) => e.signal === 'query_dimensions_available')!.delta).toBe(5); // 校准后进 allowlist
    expect(c.scoreExplanation.every((e) => e.delta !== 0)).toBe(true);
  });

  it('新形状 hardReject(confirmed_analytics)→ score 0 + rejected,paramUnion 仍透传', async () => {
    const s = createScorer({ model: 'm', client: fakeClient({ interfaces: [
      { candidateId: 'cand_2', isDataEndpoint: false, hardReject: 'confirmed_analytics',
        ruleSignals: [], semanticSignals: [], risks: ['slardar'], scoreRationale: '字节埋点' },
    ] }) });
    const r = await s.score(input);
    expect(r!.candidates[0]).toMatchObject({ candidateId: 'cand_2', score: 0, confidence: 'rejected', decision: 'reject', isDataEndpoint: false });
  });
});

describe('LLM 候选选取(软上限 + junk 预过滤,Codex 裁决)', () => {
  const mk = (id: string, opts: { score?: number; kind?: string; params?: boolean }): RankCandidate =>
    ({
      id, score: opts.score ?? 10, confidence: 'low',
      endpoint: { method: 'GET', pathname: `/${id}`, urlTemplate: `https://x.com/${id}`, queryParams: opts.params ? { q: '{k}' } : {} },
      args: opts.params ? [{ argName: 'k', in: 'query', paramName: 'q' }] : [],
      ...(opts.kind ? { responseShape: { kind: opts.kind } } : {}),
    } as unknown as RankCandidate);

  it('isConfirmedJunk:无数据形状且无参 → true;有 array/object 形状或有参 → false', () => {
    expect(isConfirmedJunk(mk('beacon', {}))).toBe(true);                       // 无形状无参 = 垃圾
    expect(isConfirmedJunk(mk('list', { kind: 'array' }))).toBe(false);         // 无参热榜列表 → 保留
    expect(isConfirmedJunk(mk('cfg', { kind: 'object' }))).toBe(false);         // 配置 object → 保留(交 LLM 判)
    expect(isConfirmedJunk(mk('search', { params: true }))).toBe(false);        // 有参 → 保留
    expect(isConfirmedJunk(mk('htmlish', { kind: 'html' }))).toBe(true);        // 非 array/object 且无参 → 垃圾
  });

  it('软上限 5:≤5 个候选全量喂(含低分 array 候选保留)', () => {
    const cands = [
      ...Array.from({ length: 4 }, (_, i) => mk(`hi${i}`, { score: 50, params: true })),
      mk('lo_data', { score: 1, kind: 'array' }), // 低分但有数据形状,5 个以内 → 保留
    ];
    const sel = selectCandidatesForLlm(cands);
    expect(sel).toHaveLength(5);
    expect(sel.some((c) => c.id === 'lo_data')).toBe(true);
  });

  it('超软上限 5 才按分截断:25 个 → 取分最高的 5(召回↔延迟权衡,2026-06-29 由 20 降到 5 提速 score)', () => {
    const cands = Array.from({ length: 25 }, (_, i) => mk(`c${i}`, { score: i, params: true }));
    const sel = selectCandidatesForLlm(cands);
    expect(sel).toHaveLength(5);
    expect(sel.every((c) => Number(c.id.slice(1)) >= 20)).toBe(true); // 只留分最高的 5(20-24)
  });

  it('确定垃圾被挡;但全垃圾时回退原集(永不喂空)', () => {
    expect(selectCandidatesForLlm([mk('data', { kind: 'array' }), mk('beacon', {})]).map((c) => c.id)).toEqual(['data']);
    expect(selectCandidatesForLlm([mk('b1', {}), mk('b2', {})])).toHaveLength(2); // 全垃圾 → 回退
  });
});

describe('第3步 双轨求分(semanticBonus allowlist/cap/dedup + hardReject + scoreExplanation 真 delta + profile 不冻结)', () => {
  const iface = (over: Record<string, unknown>): Record<string, unknown> => ({
    candidateId: 'cand_1', isDataEndpoint: true, hardReject: null,
    ruleSignals: [{ name: 'stable_json_shape', present: true }], // rule 基线 30(校准 25→30)
    semanticSignals: [], risks: [], scoreRationale: 'r', ...over,
  });
  const run = async (over: Record<string, unknown>, profile?: import('@sovovs/bycli-recorder-core').ScoringProfile) =>
    (await createScorer({ model: 'm', client: fakeClient({ interfaces: [iface(over)] }) }).score({ ...input, ...(profile ? { profile } : {}) }))!.candidates[0];

  it('semanticBonus 按 strength 求和(rule 30 + response_varies(strong15)+pagination(weak2)=47)', async () => {
    const c = await run({ semanticSignals: [
      { name: 'response_varies_with_seed', strength: 'strong' },
      { name: 'pagination_supported', strength: 'weak' },
    ] });
    expect(c.semanticBonus).toBe(17); // 15 + 2(pagination weak 校准 1→2)
    expect(c.score).toBe(47); // 30 + 17
  });

  it('总 cap 40:语义贡献超 40 被封顶(15+15+10+10+8=58 → 40)', async () => {
    const c = await run({ semanticSignals: [
      { name: 'response_varies_with_seed', strength: 'strong' }, // 15
      { name: 'rich_business_data', strength: 'strong' },        // 15(校准 10→15)
      { name: 'endpoint_semantic_data', strength: 'strong' },    // 10(校准 8→10)
      { name: 'param_interpretable', strength: 'strong' },       // 10(校准 8→10)
      { name: 'pagination_supported', strength: 'strong' },      // 8(校准 5→8) → sum 58
    ] });
    expect(c.semanticBonus).toBe(40); // 封顶(2026-06-30 30→40)
    expect(c.score).toBe(70);          // 30 rule + 40 cap
  });

  it('allowlist:非表内 semanticSignal 贡献 0', async () => {
    const c = await run({ semanticSignals: [
      { name: 'made_up_signal', strength: 'strong' },  // 不在表 → 0
      { name: 'totally_made_up', strength: 'strong' }, // 不在表 → 0
    ] });
    expect(c.semanticBonus).toBe(0);
    expect(c.score).toBe(30); // 仅 rule
  });

  it('每类一次:同名 semanticSignal 重复只计首条', async () => {
    const c = await run({ semanticSignals: [
      { name: 'rich_business_data', strength: 'strong' }, // 15
      { name: 'rich_business_data', strength: 'weak' },   // 重复忽略
    ] });
    expect(c.semanticBonus).toBe(15);
  });

  it('dedup:seed_arg_maps_to_param 已计入 → param_interpretable 不再二次奖励', async () => {
    const c = await run({
      ruleSignals: [{ name: 'stable_json_shape', present: true }, { name: 'seed_arg_maps_to_param', present: true }], // 30+20
      semanticSignals: [{ name: 'param_interpretable', strength: 'strong' }], // 被去重 → 0
    });
    expect(c.semanticBonus).toBe(0);
    expect(c.score).toBe(50); // 30 + 20,无 param_interpretable 加分
  });

  it('dedup 反例:无 seed_arg 时 param_interpretable 正常计分', async () => {
    const c = await run({ semanticSignals: [{ name: 'param_interpretable', strength: 'medium' }] }); // 6(校准 5→6)
    expect(c.semanticBonus).toBe(6);
    expect(c.score).toBe(36); // 30 + 6
  });

  it('hardReject → finalScore 0、semanticBonus 不翻案(即使有强语义信号)', async () => {
    const c = await run({
      hardReject: 'confirmed_analytics',
      ruleSignals: [],
      semanticSignals: [{ name: 'response_varies_with_seed', strength: 'strong' }, { name: 'rich_business_data', strength: 'strong' }],
    });
    expect(c).toMatchObject({ score: 0, confidence: 'rejected', decision: 'reject' });
    expect(c.semanticBonus).toBe(0); // bonus 被强制 0
    expect(c.scoreExplanation.some((e) => e.signal === 'response_varies_with_seed')).toBe(false); // 语义层不进 explanation
  });

  it('scoreExplanation 对成立 rule signal 给真正非零 delta(前端 delta>0 判 seed 命中)', async () => {
    const c = await run({
      ruleSignals: [{ name: 'stable_json_shape', present: true }, { name: 'seed_arg_maps_to_param', present: true, why: 'q 映射' }],
    });
    const seed = c.scoreExplanation.find((e) => e.signal === 'seed_arg_maps_to_param');
    expect(seed).toBeDefined();
    expect(seed!.delta).toBe(20); // 真 delta,不是 0
    expect(seed!.detail).toBe('q 映射');
    expect(c.scoreExplanation.every((e) => e.delta !== 0)).toBe(true);
  });

  it('回归:article_rank(稳定 JSON + uuid unknown-dynamic -5 + 语义信号)落 medium/近 high 而非 low(修"分数还低")', async () => {
    // 真机 juejin article_rank:LLM 判 llmUtilityScore=84(好数据接口),旧架构(stable25 - dynamic平惩罚10
    // + cap25)下 be 权威分只到 40 → low(用户核心抱怨)。根因=平惩罚误伤 uuid 缓存/去重参数 + cap 太低。
    // 校准后:rule = stable_json(30) - uuid(unknown-dynamic -5,按 ParamObservation 事实分级) = 25;
    // semanticBonus = rich(strong15)+endpoint(strong10)+pagination(strong8)+param_interpretable(med6)
    //   +query_dimensions(med5) = 44,cap40 → 40;finalScore = 25 + 40 = 65 → medium(>=45,接近 high 70)。
    const uuidObs: ParamObservation = {
      name: 'uuid', in: 'query', observedCount: 2, totalCalls: 2, observedSamples: ['A', 'B'],
      observedAlways: true, observedVariation: true, valueKinds: ['string'],
      dynamicLike: true, signedLike: false, cacheBusterLike: false, cursorLike: false, // unknown dynamic
    };
    const rankInput: ScoreInput = {
      candidates: [{ ...cand('cand_1', '/api/article_rank'), paramObservations: [uuidObs] } as unknown as RankCandidate],
      samples: input.samples,
    };
    const s = createScorer({ model: 'm', client: fakeClient({ interfaces: [
      { candidateId: 'cand_1', isDataEndpoint: true, hardReject: null,
        ruleSignals: [
          { name: 'stable_json_shape', present: true, why: 'array 列表' },
          { name: 'dynamic_field', present: true, why: 'uuid 参数' }, // 不再经 profile 平惩罚;按事实分级
        ],
        semanticSignals: [
          { name: 'rich_business_data', strength: 'strong' },         // 15
          { name: 'endpoint_semantic_data', strength: 'strong' },     // 10
          { name: 'pagination_supported', strength: 'strong' },       // 8
          { name: 'param_interpretable', strength: 'medium' },        // 6(无 seed_arg → 不去重)
          { name: 'query_dimensions_available', strength: 'medium' }, // 5(校准后进 allowlist) → sum 44
        ],
        llmUtilityScore: 84, llmUtilityBand: 'high', risks: [], scoreRationale: 'juejin article_rank' },
    ] }) });
    const c = (await s.score(rankInput))!.candidates[0];
    expect(c.semanticBonus).toBe(40);     // 封顶(cap 40)
    expect(c.score).toBe(65);             // rule 25(stable30 - uuid5) + bonus 40,不再是 40
    expect(c.confidence).toBe('medium');  // 65 >= MEDIUM_MIN(45),不再 low
    expect(c.decision).toBe('generate');
    // uuid unknown-dynamic 记 -5 explanation 项 + risk
    expect(c.scoreExplanation.find((e) => e.signal === 'unknown_dynamic_param')!.delta).toBe(-5);
    expect(c.risks).toContain('unexplained_dynamic_param');
  });

  it('动态惩罚分级:signed 参数 -15(签名/鉴权最高风险)', async () => {
    const signObs: ParamObservation = {
      name: 'sign', in: 'query', observedCount: 2, totalCalls: 2, observedSamples: ['A', 'B'],
      observedAlways: true, observedVariation: true, valueKinds: ['string'],
      dynamicLike: true, signedLike: true, cacheBusterLike: false, cursorLike: false,
    };
    const rankInput: ScoreInput = {
      candidates: [{ ...cand('cand_1', '/api/s'), paramObservations: [signObs] } as unknown as RankCandidate],
      samples: input.samples,
    };
    const s = createScorer({ model: 'm', client: fakeClient({ interfaces: [
      { candidateId: 'cand_1', isDataEndpoint: true, hardReject: null,
        ruleSignals: [{ name: 'stable_json_shape', present: true }], semanticSignals: [], risks: [], scoreRationale: 'signed' },
    ] }) });
    const c = (await s.score(rankInput))!.candidates[0];
    expect(c.score).toBe(15); // stable 30 - signed 15
    expect(c.scoreExplanation.find((e) => e.signal === 'signed_param')!.delta).toBe(-15);
    expect(c.risks).toContain('signed_or_auth_param');
  });

  it('动态惩罚分级:cache-buster 参数 0 惩罚(读接口 _t 不减数据价值,仅记 risk)', async () => {
    const cbObs: ParamObservation = {
      name: '_t', in: 'query', observedCount: 2, totalCalls: 2, observedSamples: ['A', 'B'],
      observedAlways: true, observedVariation: true, valueKinds: ['number'],
      dynamicLike: true, signedLike: false, cacheBusterLike: true, cursorLike: false,
    };
    const rankInput: ScoreInput = {
      candidates: [{ ...cand('cand_1', '/api/list'), paramObservations: [cbObs] } as unknown as RankCandidate],
      samples: input.samples,
    };
    const s = createScorer({ model: 'm', client: fakeClient({ interfaces: [
      { candidateId: 'cand_1', isDataEndpoint: true, hardReject: null,
        ruleSignals: [{ name: 'stable_json_shape', present: true }], semanticSignals: [], risks: [], scoreRationale: 'cache buster' },
    ] }) });
    const c = (await s.score(rankInput))!.candidates[0];
    expect(c.score).toBe(30); // stable 30,cache-buster 0 惩罚
    expect(c.scoreExplanation.some((e) => e.signal === 'unknown_dynamic_param' || e.signal === 'signed_param')).toBe(false);
    expect(c.risks).toContain('cache_buster_param');
  });

  it('动态惩罚取最严:signed(-15) 压过 unknown(-5) 压过 cacheBuster(0),只 apply 一次', async () => {
    const mk = (name: string, over: Partial<ParamObservation>): ParamObservation => ({
      name, in: 'query', observedCount: 2, totalCalls: 2, observedSamples: ['A', 'B'],
      observedAlways: true, observedVariation: true, valueKinds: ['string'],
      dynamicLike: true, signedLike: false, cacheBusterLike: false, cursorLike: false, ...over,
    });
    const rankInput: ScoreInput = {
      candidates: [{ ...cand('cand_1', '/api/s'), paramObservations: [
        mk('_t', { cacheBusterLike: true }),
        mk('uuid', {}),                    // unknown
        mk('sign', { signedLike: true }),  // signed → 最严
      ] } as unknown as RankCandidate],
      samples: input.samples,
    };
    const s = createScorer({ model: 'm', client: fakeClient({ interfaces: [
      { candidateId: 'cand_1', isDataEndpoint: true, hardReject: null,
        ruleSignals: [{ name: 'stable_json_shape', present: true }], semanticSignals: [], risks: [], scoreRationale: 'mixed' },
    ] }) });
    const c = (await s.score(rankInput))!.candidates[0];
    expect(c.score).toBe(15); // stable 30 - signed 15(只扣一次最严类,不叠加)
    expect(c.scoreExplanation.filter((e) => e.signal === 'signed_param' || e.signal === 'unknown_dynamic_param')).toHaveLength(1);
  });

  it('profile 按调用传入(不冻结闭包):同一 scorer 用不同 profile 求出不同分', async () => {
    // createScorer 不带 profile;两次 score 传不同 profile → stable_json_shape delta 不同。
    const s = createScorer({ model: 'm', client: fakeClient({ interfaces: [iface({})] }) });
    const base = DEFAULT_SCORING_PROFILE;
    const bumped = { ...base, RANK_SCORE_STABLE_JSON_SHAPE_DELTA: 40 };
    const cDefault = (await s.score({ ...input, profile: base }))!.candidates[0];
    const cBumped = (await s.score({ ...input, profile: bumped }))!.candidates[0];
    expect(cDefault.score).toBe(30); // 默认 stable delta(校准 25→30)
    expect(cBumped.score).toBe(40);  // 传入 profile 生效(若冻结闭包则仍是 30 → 必失败)
    expect(cBumped.scoreExplanation.find((e) => e.signal === 'stable_json_shape')!.delta).toBe(40);
  });
});

describe('buildScorePrompt · 预算闸门 + 结构摘要', () => {
  // 造一个大响应体(许多行 × 富字段),模拟真机 juejin article_rank 多候选。
  const bigBody = (n: number) =>
    JSON.stringify({
      err_no: 0,
      err_msg: 'success',
      data: Array.from({ length: n }, (_, i) => ({
        content: { content_id: String(i), title: `文章标题 ${i} `.repeat(10), brief: 'x'.repeat(200), category_id: '68', tag_ids: ['a', 'b', 'c'] },
        content_counter: { view: 1000 + i, like: i, collect: i, hot_rank: i, comment_count: i },
        author: { user_id: String(i), name: `作者${i}`, avatar: 'https://x/'.repeat(20), is_followed: false },
      })),
    });

  const bigCand = (id: string, pathname: string): RankCandidate =>
    ({ id, score: 50, confidence: 'medium', endpoint: { method: 'GET', host: 'api.juejin.cn', pathname, urlTemplate: `https://api.juejin.cn${pathname}?type={t}` }, args: [], responseShape: { kind: 'object' } } as unknown as RankCandidate);

  const bigInput = (numCands: number): ScoreInput => {
    const candidates = Array.from({ length: numCands }, (_, i) => bigCand(`cand_${i}`, `/content_api/v1/rank_${i}`));
    const mkSample = (name: 'A' | 'B') => ({
      sampleName: name,
      entries: candidates.map((c) => ({ method: 'GET', url: `https://api.juejin.cn${c.endpoint!.pathname}?type=hot`, responseStatus: 200, responsePreview: bigBody(50), timestamp: 1 })),
    });
    return { candidates, samples: [mkSample('A'), mkSample('B')] };
  };

  it('结构摘要:prompt 无原始 responseBody,含 responseSummary/rowPath', () => {
    const prompt = buildScorePrompt(bigInput(1));
    expect(prompt).not.toContain('responseBody');
    expect(prompt).toContain('responseSummary');
    expect(prompt).toContain('"rowPath"');
    // 不含原始样本值(标题/作者名)
    expect(prompt).not.toContain('文章标题 0');
  });

  it('大 5-候选 prompt 被降级到 < 10000 字符;绝不丢 rowPath/kind', () => {
    const { prompt, stat } = buildScorePromptWithStat(bigInput(5));
    expect(prompt.length).toBeLessThanOrEqual(10_000);
    expect(stat.chars).toBe(prompt.length);
    // 降级发生(记录了步骤)
    expect(stat.degraded.length).toBeGreaterThan(0);
    // 核心结构信息保留
    expect(prompt).toContain('"rowPath"');
    expect(prompt).toContain('"kind"');
  });

  it('降级顺序:selector → actions → rowKeys → candidates(候选降级永远最后)', () => {
    const { stat } = buildScorePromptWithStat(bigInput(5));
    // 非候选步骤按定义顺序出现;候选步骤(candidates_to_*)只在最后出现。
    const rank = (step: string): number => {
      if (step === 'drop_action_selectors') return 0;
      if (step === 'actions_to_2') return 1;
      if (step === 'rowkeys_to_10') return 2;
      if (step.startsWith('candidates_to_')) return 3;
      return 99;
    };
    let last = -1;
    for (const step of stat.degraded) {
      const r = rank(step);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
  });

  it('小输入不降级(degraded 为空)', () => {
    const small: ScoreInput = {
      candidates: [cand('cand_1', '/api/search')],
      samples: [
        { sampleName: 'A', entries: [{ method: 'GET', url: 'https://x.com/api/search?q=cat', responseStatus: 200, responsePreview: '{"data":[{"title":"a"}]}', timestamp: 1 }] },
        { sampleName: 'B', entries: [{ method: 'GET', url: 'https://x.com/api/search?q=dog', responseStatus: 200, responsePreview: '{"data":[{"title":"b"}]}', timestamp: 2 }] },
      ],
    };
    const { prompt, stat } = buildScorePromptWithStat(small);
    expect(prompt.length).toBeLessThanOrEqual(10_000);
    expect(stat.degraded).toEqual([]);
  });
});
