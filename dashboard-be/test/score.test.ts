// N1 评分单测:be 按成立信号的 profile delta 求和算权威分(LLM 只判 present),band/decision/排序正确。
import { describe, it, expect } from 'vitest';
import { createScorer, isConfirmedJunk, selectCandidatesForLlm, buildScorePrompt, buildScorePromptWithStat, toonParamObservations, type ScoreInput } from '../src/llm/score.js';
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
  const mk = (id: string, opts: { score?: number; kind?: string; params?: boolean; risks?: string[] }): RankCandidate =>
    ({
      id, score: opts.score ?? 10, confidence: 'low',
      endpoint: { method: 'GET', pathname: `/${id}`, urlTemplate: `https://x.com/${id}`, queryParams: opts.params ? { q: '{k}' } : {} },
      args: opts.params ? [{ argName: 'k', in: 'query', paramName: 'q' }] : [],
      ...(opts.risks ? { risks: opts.risks } : {}),
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

  it('core 硬拒候选(hard_reject:*)不占 LLM 名额:埋点/mutation 被排除,不挤掉真候选', () => {
    const cands = [
      mk('monitor_web', { score: 40, kind: 'object', params: true, risks: ['hard_reject:confirmed_analytics'] }), // 埋点硬拒
      mk('post_recording', { score: 35, kind: 'object', risks: ['hard_reject:mutation'] }),                       // 写操作硬拒
      mk('search', { score: 30, kind: 'array', params: true }),                                                    // 真数据接口
      mk('article', { score: 25, kind: 'array', params: true }),
    ];
    const sel = selectCandidatesForLlm(cands).map((c) => c.id);
    expect(sel).not.toContain('monitor_web');   // 埋点硬拒不进 LLM
    expect(sel).not.toContain('post_recording'); // mutation 硬拒不进 LLM
    expect(sel).toEqual(['search', 'article']);  // 只留真候选(硬拒腾出的名额)
  });

  it('低分 rejected(非硬拒,无 hard_reject risk)仍可进 LLM 被救回', () => {
    // score<LOW_MIN 的 rejected 没有 hard_reject risk → 不被 selectCandidatesForLlm 排除。
    const sel = selectCandidatesForLlm([mk('lowscore', { score: 2, kind: 'array', params: true })]).map((c) => c.id);
    expect(sel).toContain('lowscore');
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

  // 回归(2026-07-01,STEP 2 隔离修复):某个候选在 evidence 摘要构建中抛错,**绝不能**让整批返回 null、
  // 其余候选全丢分。buildPerCand 现在逐候选 try/catch(抛错 → 该候选空 evidence,其余照常)。
  // 造法:一个 sample entry 的 url 属性用 getter 抛错 → buildScoreEvidenceSummary 读 e.url 时炸。
  // 修复前:异常冒泡出 buildScorePromptWithStat → score() 外层 catch → 返回 null → scored=0/N。
  // 修复后:该候选降级空 evidence 仍进 LLM,LLM 回两条 → scored=2/2。
  it('单候选 evidence 构建抛错不拖垮整批(其余候选仍评分)', async () => {
    const s = createScorer({ model: 'm', client: fakeClient({ interfaces: [
      { candidateId: 'cand_ok', isDataEndpoint: true, hardReject: null, ruleSignals: [{ name: 'stable_json_shape', present: true }] },
      { candidateId: 'cand_poison', isDataEndpoint: true, hardReject: null, ruleSignals: [{ name: 'stable_json_shape', present: true }] },
    ] }) });
    const poisonEntry: Record<string, unknown> = { method: 'GET', responseStatus: 200, responsePreview: '[{"t":1}]', timestamp: 1 };
    Object.defineProperty(poisonEntry, 'url', { enumerable: true, get() { throw new Error('boom in evidence build'); } });
    const poisoned: ScoreInput = {
      candidates: [cand('cand_ok', '/api/ok'), cand('cand_poison', '/api/poison')],
      // 同一批 samples 被两个候选共享;含一个 url getter 抛错的 entry。
      samples: [
        { sampleName: 'A', entries: [{ method: 'GET', url: 'https://x.com/api/ok?q=a', responseStatus: 200, responsePreview: '[{"t":1}]', timestamp: 1 }, poisonEntry] as never },
        { sampleName: 'B', entries: [{ method: 'GET', url: 'https://x.com/api/ok?q=b', responseStatus: 200, responsePreview: '[{"t":2}]', timestamp: 2 }, poisonEntry] as never },
      ],
    };
    const r = await s.score(poisoned);
    expect(r).not.toBeNull();                       // 不再整批返回 null
    expect(r!.candidates).toHaveLength(2);          // 两个候选都评上了分
    const byId = Object.fromEntries(r!.candidates.map((c) => [c.candidateId, c]));
    expect(byId.cand_ok).toBeDefined();
    expect(byId.cand_poison).toBeDefined();
  });

  it('回填 id 缺失/改写 → 按发送顺序位置对齐兜底(rows 与 sentIds 等长)', async () => {
    // LLM 漏填/改写 candidateId(常见:长 slug 复现不出),但 interfaces 顺序与发送顺序一致。
    // 位置对齐应把三行分别归位到 cand_1/cand_2/cand_3,而非全 miss 丢 LLM 分。
    const s = createScorer({ model: 'm', client: fakeClient({ interfaces: [
      { candidateId: '', inferredFunction: '搜索', ruleSignals: [{ name: 'stable_json_shape', present: true }] },       // 空 id
      { candidateId: 'WRONG_ID_xyz', inferredFunction: '埋点', hardReject: 'confirmed_analytics' },                       // 错 id
      { candidateId: 'cand_3', inferredFunction: '页面', ruleSignals: [{ name: 'weak_html_static', present: true }] },    // 对 id
    ] }) });
    const r = await s.score(input);
    const ids = r!.candidates.map((c) => c.candidateId).sort();
    // 三行都归位到真实候选 id(不是空/WRONG),下游 merge/genCands 才能匹配。
    expect(ids).toEqual(['cand_1', 'cand_2', 'cand_3']);
    const byId = Object.fromEntries(r!.candidates.map((c) => [c.candidateId, c]));
    expect(byId.cand_1.inferredFunction).toBe('搜索'); // 位置0 → cand_1
    expect(byId.cand_2.confidence).toBe('rejected');   // 位置1(错 id)→ cand_2,hardReject 生效
    expect(byId.cand_3.inferredFunction).toBe('页面');
  });

  it('rows 与 sentIds 不等长(LLM 漏返)→ 关掉位置兜底,只精确匹配(不错配)', async () => {
    // 只返回 2 行(漏 1),顺序未知 → 不能按位置硬对齐。只有 candidateId 精确命中的才归位。
    const s = createScorer({ model: 'm', client: fakeClient({ interfaces: [
      { candidateId: 'cand_2', inferredFunction: '只有它 id 对', ruleSignals: [{ name: 'stable_json_shape', present: true }] },
      { candidateId: 'BOGUS', inferredFunction: '错 id,不等长时不兜底', ruleSignals: [{ name: 'stable_json_shape', present: true }] },
    ] }) });
    const r = await s.score(input);
    const byId = Object.fromEntries(r!.candidates.map((c) => [c.candidateId, c]));
    expect(byId.cand_2).toBeDefined();          // 精确命中
    expect(byId.cand_2.inferredFunction).toBe('只有它 id 对');
    expect(byId.BOGUS).toBeDefined();           // 不等长 → 不兜底,BOGUS 原样保留(不硬塞给 cand_1/cand_3)
    expect(byId.cand_1).toBeUndefined();
    expect(byId.cand_3).toBeUndefined();
  });

  it('返回值带 rawInterfacesJson(原始 LLM 返回文本,供前端展示)', async () => {
    const s = createScorer({ model: 'm', client: fakeClient({ interfaces: [
      { candidateId: 'cand_1', inferredFunction: '搜索', ruleSignals: [{ name: 'stable_json_shape', present: true }] },
    ] }) });
    const r = await s.score(input);
    expect(typeof r!.rawInterfacesJson).toBe('string');
    expect(r!.rawInterfacesJson).toContain('inferredFunction');
  });

  it('等长但 LLM 重排(带 method/pathname 与位置对不上)→ 交叉校验拦截,不硬对齐错配', async () => {
    // 三行等长,但 candidateId 全错写,且带的 pathname 与「发送顺序位置」错位:
    // 位置0 的行 pathname=/page(应是 /api/search)、位置1=/api/search、位置2=/track。
    // 交叉校验 rowMatchesSlot 发现 endpoint 对不上 → 不按位置硬塞,避免把 /page 的评分安到 cand_1。
    const s = createScorer({ model: 'm', client: fakeClient({ interfaces: [
      { candidateId: 'X', method: 'GET', pathname: '/page', inferredFunction: '页面', ruleSignals: [{ name: 'weak_html_static', present: true }] },
      { candidateId: 'Y', method: 'GET', pathname: '/api/search', inferredFunction: '搜索', ruleSignals: [{ name: 'stable_json_shape', present: true }] },
      { candidateId: 'Z', method: 'GET', pathname: '/track', hardReject: 'confirmed_analytics' },
    ] }) });
    const r = await s.score(input);
    const byId = Object.fromEntries(r!.candidates.map((c) => [c.candidateId, c]));
    // 错位行不会被硬塞到 cand_1/cand_2/cand_3(endpoint 不匹配),保留原错 id(下游 merge 自然 miss,安全)。
    expect(byId.cand_1).toBeUndefined();
    // 错 id 原样保留(X/Y/Z),不污染真实候选。
    expect(byId.X ?? byId.Y ?? byId.Z).toBeDefined();
  });

  it('等长且 method/pathname 与位置一致 → 位置对齐照常归位(id 缺失也救回)', async () => {
    // 顺序与发送一致(cand_1=/api/search, cand_2=/track, cand_3=/page),id 缺失但 endpoint 对得上。
    const s = createScorer({ model: 'm', client: fakeClient({ interfaces: [
      { candidateId: '', method: 'GET', pathname: '/api/search', inferredFunction: '搜索', ruleSignals: [{ name: 'stable_json_shape', present: true }] },
      { candidateId: '', method: 'GET', pathname: '/track', hardReject: 'confirmed_analytics' },
      { candidateId: '', method: 'GET', pathname: '/page', inferredFunction: '页面', ruleSignals: [{ name: 'weak_html_static', present: true }] },
    ] }) });
    const r = await s.score(input);
    const byId = Object.fromEntries(r!.candidates.map((c) => [c.candidateId, c]));
    expect(byId.cand_1?.inferredFunction).toBe('搜索');
    expect(byId.cand_3?.inferredFunction).toBe('页面');
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

  const bigInput = (numCands: number, cap?: number): ScoreInput => {
    const candidates = Array.from({ length: numCands }, (_, i) => bigCand(`cand_${i}`, `/content_api/v1/rank_${i}`));
    const mkSample = (name: 'A' | 'B') => ({
      sampleName: name,
      entries: candidates.map((c) => ({ method: 'GET', url: `https://api.juejin.cn${c.endpoint!.pathname}?type=hot`, responseStatus: 200, responsePreview: bigBody(50), timestamp: 1 })),
    });
    return { candidates, samples: [mkSample('A'), mkSample('B')], ...(cap != null ? { cap } : {}) };
  };

  it('结构摘要:prompt 无原始 responseBody,含 responseSummary/rowPath', () => {
    const prompt = buildScorePrompt(bigInput(1));
    expect(prompt).not.toContain('responseBody');
    expect(prompt).toContain('responseSummary');
    expect(prompt).toContain('"rowPath"');
    // 不含原始样本值(标题/作者名)
    expect(prompt).not.toContain('文章标题 0');
  });

  // 预算闸门 = 40_000 chars(2026-07-01 由 10_000 提高,修 scored=1/N:旧值下 2 个富数据候选就超预算、
  // 候选降级把 cap 一路 pop 到 1)。要触发降级需超过 40_000 → 用 12 个候选(cap=12)造病态大输入。
  const SCORE_BUDGET = 68_000;
  it('大输入(40 候选)prompt 被降级到预算内;绝不丢 rowPath/kind', () => {
    // minify(2026-07-03)后单候选更小:20 候选 ~45KB、30 候选 ~66KB 都在 68KB 预算内不降级 →
    // 需 40 候选才稳超预算触发降级(实测 40 候选降级到 candidates_to_2)。
    const { prompt, stat } = buildScorePromptWithStat(bigInput(40, 40));
    expect(prompt.length).toBeLessThanOrEqual(SCORE_BUDGET);
    expect(stat.chars).toBe(prompt.length);
    // 降级发生(记录了步骤)
    expect(stat.degraded.length).toBeGreaterThan(0);
    // 核心结构信息保留
    expect(prompt).toContain('"rowPath"');
    expect(prompt).toContain('"kind"');
  });

  it('降级顺序:actions → rowKeys → candidates(候选降级永远最后)', () => {
    const { stat } = buildScorePromptWithStat(bigInput(40, 40));
    // 非候选步骤按定义顺序出现;候选步骤(candidates_to_*)只在最后出现。
    // 注:selector 已不在 score 侧 evidence(阶段二 #1),故无 drop_action_selectors 步。
    const rank = (step: string): number => {
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
    expect(prompt.length).toBeLessThanOrEqual(SCORE_BUDGET);
    expect(stat.degraded).toEqual([]);
  });

  // 回归(2026-07-01):cap=5 个富数据候选(真机 juejin article_rank 级)在 40_000 预算下**全部保留**,
  // 不再被候选降级 pop 到 1 —— 这正是 scored=1/N 的根因。旧 10_000 预算下这会 pop 到 1。
  it('cap=5 富数据候选不被预算闸门降级(全部保留,修 scored=1/N)', () => {
    const { stat } = buildScorePromptWithStat(bigInput(5, 5));
    expect(stat.candidates).toBe(5);
    expect(stat.degraded).toEqual([]);
    expect(stat.chars).toBeLessThanOrEqual(SCORE_BUDGET);
  });

  it('②b paramObservations 精简:prompt 含核心信号(observedVariation/coverage/命中标志),砍冗余(observedSamples/valueKinds)', () => {
    const fullObs = {
      name: 'uuid', in: 'query', observedCount: 2, totalCalls: 2, observedSamples: ['A', 'B'],
      observedAlways: true, observedVariation: true, valueKinds: ['string'],
      dynamicLike: true, signedLike: false, cacheBusterLike: false, cursorLike: false,
    };
    const input: ScoreInput = {
      candidates: [{ ...cand('cand_1', '/api/x'), paramObservations: [fullObs] } as unknown as RankCandidate],
      samples: [
        { sampleName: 'A', entries: [{ method: 'GET', url: 'https://x.com/api/x?uuid=1', responseStatus: 200, responsePreview: '[{"t":1}]', timestamp: 1 }] },
        { sampleName: 'B', entries: [{ method: 'GET', url: 'https://x.com/api/x?uuid=2', responseStatus: 200, responsePreview: '[{"t":2}]', timestamp: 2 }] },
      ],
    };
    const prompt = buildScorePrompt(input);
    // 保留:核心判角色信号
    expect(prompt).toContain('observedVariation');
    expect(prompt).toContain('coverage');       // observedCount/totalCalls 合成
    expect(prompt).toContain('dynamicLike');    // 命中标志(true 才带)
    // 砍掉:冗余观测子字段(压体积)——这些名字只在 paramObservations 数据里,PROMPT_A 说明不含,可安全断言全局缺失。
    expect(prompt).not.toContain('observedSamples');
    expect(prompt).not.toContain('valueKinds');
    expect(prompt).not.toContain('observedAlways');
  });
});

describe('分批并发调 LLM(破 CF 120s 硬墙)', () => {
  // 6 个数据候选,SCORE_BATCH_SIZE=3 → 2 批。
  const mk = (id: string, path: string): RankCandidate =>
    ({ id, score: 40, confidence: 'low', endpoint: { method: 'GET', pathname: path, urlTemplate: `https://x.com${path}?q={k}` }, args: [], responseShape: { kind: 'array' } } as unknown as RankCandidate);
  const cands = Array.from({ length: 6 }, (_, i) => mk(`cand_${i}`, `/api/e${i}`));
  const samples = [
    { sampleName: 'A' as const, entries: cands.map((c) => ({ method: 'GET', url: `https://x.com${c.endpoint!.pathname}?q=cat`, responseStatus: 200, responsePreview: '[{"t":1}]', timestamp: 1 })) },
    { sampleName: 'B' as const, entries: cands.map((c) => ({ method: 'GET', url: `https://x.com${c.endpoint!.pathname}?q=dog`, responseStatus: 200, responsePreview: '[{"t":2}]', timestamp: 2 })) },
  ];
  const mInput: ScoreInput = { candidates: cands, samples, cap: 10 };

  // 按 prompt 里出现的 candidateId 动态返回该批对应候选(模拟每批各自评分)。
  const perBatchClient = (fail?: (ids: string[]) => boolean): LlmClient => ({
    messages: {
      async create(params: Record<string, unknown>) {
        const text = JSON.stringify(params.messages);
        const ids = cands.map((c) => c.id).filter((id) => text.includes(id));
        if (fail?.(ids)) throw new Error('CF 524 simulated');
        const interfaces = ids.map((candidateId) => ({
          candidateId, isDataEndpoint: true, hardReject: null,
          ruleSignals: [{ name: 'stable_json_shape', present: true }],
          reason: 'data',
        }));
        return { content: [{ type: 'text', text: JSON.stringify({ interfaces }) }] };
      },
    },
  });

  it('6 候选切 2 批并发 → 合并后全部评分(候选数/id 完整,无丢失)', async () => {
    const calls: string[][] = [];
    const client: LlmClient = {
      messages: {
        async create(params: Record<string, unknown>) {
          const text = JSON.stringify(params.messages);
          const ids = cands.map((c) => c.id).filter((id) => text.includes(id));
          calls.push(ids);
          return { content: [{ type: 'text', text: JSON.stringify({ interfaces: ids.map((candidateId) => ({ candidateId, isDataEndpoint: true, hardReject: null, ruleSignals: [{ name: 'stable_json_shape', present: true }], reason: 'd' })) }) }] };
        },
      },
    };
    const r = await createScorer({ model: 'm', client }).score(mInput);
    expect(r).not.toBeNull();
    // 6 候选全部评上(合并无丢失)
    expect(r!.candidates.map((c) => c.candidateId).sort()).toEqual(cands.map((c) => c.id).sort());
    // 确实分了多批调用(每批 ≤3)
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((ids) => ids.length <= 3)).toBe(true);
  });

  it('单批失败(CF 524)→ 该批候选丢分,其余批照常(不整体 null)', async () => {
    // 让含 cand_0 的那批抛错,另一批正常。
    const client = perBatchClient((ids) => ids.includes('cand_0'));
    const r = await createScorer({ model: 'm', client }).score(mInput);
    expect(r).not.toBeNull();
    // 失败批的候选不在结果里,成功批的在。
    const got = r!.candidates.map((c) => c.candidateId);
    expect(got).not.toContain('cand_0');
    expect(got.length).toBeGreaterThan(0);
  });

  it('全批失败 → null(调用方退回规则分,契约不变)', async () => {
    const client = perBatchClient(() => true); // 每批都抛
    const r = await createScorer({ model: 'm', client }).score(mInput);
    expect(r).toBeNull();
  });
});

describe('TOON paramObservations 编码(表格化压缩,零字段丢失 + 三态保留)', () => {
  // compactParamObs 的输出形状(name/in/observedVariation/coverage + 命中 flag)。
  const obs = [
    { name: 'aid', in: 'query', observedVariation: false, coverage: '2/2' },
    { name: 'q', in: 'query', observedVariation: true, coverage: '2/2' },
    { name: 'token', in: 'body', observedVariation: 'unknown', coverage: '1/2', signedLike: true },
    { name: 'uuid', in: 'query', observedVariation: false, coverage: '2/2', dynamicLike: true },
    { name: 'page', in: 'query', observedVariation: true, coverage: '2/2', cursorLike: true },
  ];

  it('首行是表头(声明行数 + 列序),每参数一行', () => {
    const t = toonParamObservations(obs);
    const lines = t.split('\n');
    expect(lines[0]).toBe('paramObservations[5]{name,in,observedVariation,coverage,dynamicLike,signedLike,cacheBusterLike,cursorLike}:');
    expect(lines).toHaveLength(6); // 表头 + 5 行
  });

  it('observedVariation 保留三态字面量(true/false/unknown),绝不压成 1/空', () => {
    const t = toonParamObservations(obs);
    const rows = t.split('\n').slice(1).map((r) => r.trim().split(','));
    // 列序:name,in,observedVariation(idx2),...
    expect(rows[0][2]).toBe('false');   // aid
    expect(rows[1][2]).toBe('true');    // q —— 关键:不是 '1'
    expect(rows[2][2]).toBe('unknown'); // token —— unknown ≠ false(codex 红线)
  });

  it('命中 flag 列用 1/空(与 observedVariation 三态列区分,无歧义)', () => {
    const t = toonParamObservations(obs);
    const rows = t.split('\n').slice(1).map((r) => r.trim().split(','));
    // 列序:...,dynamicLike(4),signedLike(5),cacheBusterLike(6),cursorLike(7)
    expect(rows[2][5]).toBe('1'); // token.signedLike
    expect(rows[3][4]).toBe('1'); // uuid.dynamicLike
    expect(rows[4][7]).toBe('1'); // page.cursorLike
    expect(rows[0][4]).toBe('');  // aid 无 flag → 空
  });

  it('零字段丢失:TOON 解回对象 == 原 compact 对象(每参数每信号位)', () => {
    const t = toonParamObservations(obs);
    const lines = t.split('\n');
    const cols = lines[0].match(/\{(.+)\}:/)![1].split(',');
    const FLAG = new Set(['dynamicLike', 'signedLike', 'cacheBusterLike', 'cursorLike']);
    const back = lines.slice(1).map((r) => {
      const cells = r.replace(/^\s+/, '').split(',');
      const o: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        const v = cells[i];
        if (v === '') return;
        if (c === 'observedVariation') o[c] = v === 'true' ? true : v === 'false' ? false : 'unknown';
        else if (FLAG.has(c)) o[c] = true;
        else o[c] = v;
      });
      return o;
    });
    expect(back).toEqual(obs);
  });

  it('体积:TOON 比 pretty-JSON 显著更小(重复字段名消除)', () => {
    const pretty = JSON.stringify(obs, null, 2);
    const t = toonParamObservations(obs);
    expect(t.length).toBeLessThan(pretty.length * 0.6); // 实测省 ~54%
  });

  it('非数组(异常输入)→ 退回 JSON 串不抛(renderPrompt 永不崩)', () => {
    expect(toonParamObservations(undefined)).toBe(undefined === undefined ? JSON.stringify(undefined) : '');
    expect(toonParamObservations({ bad: 1 })).toBe('{"bad":1}');
    expect(toonParamObservations([])).toBe('paramObservations[0]{name,in,observedVariation,coverage,dynamicLike,signedLike,cacheBusterLike,cursorLike}:');
  });
});

describe('PROMPT_A + renderPrompt(TOON 接入后的 prompt 形状)', () => {
  const c = (id: string, pathname: string, paramObservations: unknown[]): RankCandidate =>
    ({ id, score: 30, confidence: 'low', endpoint: { method: 'GET', host: 'api.x.com', pathname, urlTemplate: `api.x.com${pathname}` }, paramObservations, args: [], responseShape: { kind: 'object' } } as unknown as RankCandidate);
  const inp: ScoreInput = {
    candidates: [c('cand_a', '/api/list', [{ name: 'q', in: 'query', observedCount: 2, totalCalls: 2, observedVariation: true }, { name: 'uuid', in: 'query', observedCount: 2, totalCalls: 2, observedVariation: false, dynamicLike: true }])],
    samples: [{ sampleName: 'A', entries: [] }, { sampleName: 'B', entries: [] }],
  };

  it('prompt 含 TOON 表头(paramObservations 表格化,非 pretty-JSON 对象数组)', () => {
    const p = buildScorePrompt(inp);
    expect(p).toContain('paramObservations[2]{name,in,observedVariation,coverage,');
    expect(p).toContain('读表说明'); // 读表说明段在
    expect(p).toContain('`unknown` 不等于 `false`'); // 三态红线说明在
  });

  it('输出契约仍是 interfaces(未被 codex 草稿的 items 结构污染)', () => {
    const p = buildScorePrompt(inp);
    expect(p).toContain('"interfaces"');
    expect(p).toContain('"paramUnion"');
    expect(p).toContain('"ruleSignals"');
    expect(p).toContain('"semanticSignals"');
    expect(p).not.toContain('"ruleSignal":'); // codex 草稿的单数 ruleSignal 结构不应出现
  });
});
