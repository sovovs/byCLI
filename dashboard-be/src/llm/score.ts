// N1 · LLM 评分流水线(定稿 Prompt A)。把启发式候选 + A/B 痕迹喂 LLM,让它**判定每个评分信号是否成立**;
// **be 用固定 profile delta 对成立信号求和 = 权威分**(强制可审计、可复现,LLM 不直接拍总分)。
// hard-reject 由 be 启发式预过滤(候选 confidence==='rejected' 不入 LLM);失败/无 key → null(调用方退回启发式)。
import {
  DEFAULT_SCORING_PROFILE,
  type RankCandidate,
  type ScoringProfile,
  type ScoreExplanationItem,
  type ParamUnionItem,
  type ParamObservation,
} from '@sovovs/bycli-recorder-core';
import { makeLlmClient, extractJson, buildScoreEvidenceSummary, type LlmClient, type SynthesisSample, type ScoreEvidence } from './synthesize.js';

export type ScoreSample = SynthesisSample; // { sampleName, entries, screenshot?, actions? }
export interface ScoreInput {
  candidates: RankCandidate[];
  samples: ScoreSample[];
  /** 用户手选要传 LLM 的候选 id(优先于自动截断)。空/未传 → 按 cap 自动选 top-N。 */
  candidateIds?: string[];
  /** 软上限(env RECORDER_LLM_CANDIDATE_CAP,默认 LLM_CANDIDATE_CAP);仅自动选时生效。 */
  cap?: number;
  /** 求分用的 ScoringProfile(第3步 Codex High 6:不冻结在闭包,按调用传入,
   *  与 handleRank 给 rankSamples 的 live/preview profile 同源)。未传 → DEFAULT_SCORING_PROFILE。 */
  profile?: ScoringProfile;
}
export interface ScoredSignal { name: string; present: boolean; why?: string }
/** 语义信号(LLM 推断,带强度)。第2步只解析透传;双轨求分(semanticBonus)是第3步。 */
export interface SemanticSignal { name: string; strength: 'strong' | 'medium' | 'weak'; why?: string }
/** 参数语义推断(LLM)。core 出 paramObservations 事实,LLM 在其上判角色/是否暴露。
 *  形状即 wire 契约 RankCandidate.paramUnion(recorder-core ParamUnionItem),be 求分后原样透传过线。 */
export type { ParamUnionItem };
export interface ScoredCandidate {
  candidateId: string;
  /** be 重算:成立 ruleSignal 的 profile delta 求和(权威,可负)。 */
  score: number;
  uiScore: number; // max(0,min(100,score))
  confidence: 'high' | 'medium' | 'low' | 'rejected';
  decision: 'generate' | 'review' | 'reject';
  isDataEndpoint: boolean;
  /** 成立的 ruleSignal(供 server.ts 合并成 scoreExplanation,向后兼容)。 */
  signals: ScoredSignal[];
  /** 真 delta 评分依据(第3步 Codex Moderate 2):rule signal=profile delta、
   *  semantic signal=semantic-bonus delta。server.ts 直接透传到 RankCandidate.scoreExplanation,
   *  不再全填 delta:0(前端 PipelineStep 用 delta>0 判 seed 命中)。 */
  scoreExplanation: ScoreExplanationItem[];
  /** 双轨:语义层加分(allowlist + 每类一次 + 总 cap 40),hardReject 时为 0。 */
  semanticBonus: number;
  risks: string[];
  reason: string;
  // ── 第2步新增(语义层,LLM 推断;第3步双轨求分 + 前端展示会用到)──
  /** 一句话:这个接口做什么/返回什么数据(给用户看)。 */
  inferredFunction?: string;
  /** 参数全集 + 角色/暴露语义推断。 */
  paramUnion?: ParamUnionItem[];
  /** 全部 ruleSignal(present/absent 都留,可审计)。 */
  ruleSignals?: ScoredSignal[];
  /** 语义信号(带强度);第3步据此加 semanticBonus。 */
  semanticSignals?: SemanticSignal[];
  /** LLM 自报效用分(辅助,非权威)。 */
  llmUtilityScore?: number;
  llmUtilityBand?: string;
  /** core 聚拢进该接口的候选/请求 id(debug/provenance)。 */
  mergedCandidateIds?: string[];
}
export interface ScoreResult { candidates: ScoredCandidate[] }
export interface Scorer { score(input: ScoreInput): Promise<ScoreResult | null> }

// 喂 LLM 的候选**软上限**:≤CAP 全量喂,>CAP 才按启发式分截断(排序提示)。
// 2026-06-29 由 20 降到 5(用户裁决,换 score 阶段提速):score 单次 LLM 调用实测 93s,候选越多 prompt 越大越慢。
// 取舍:这是召回与延迟的权衡——CAP 越小越快但可能埋掉排 6+ 位、确定性分低却实际可用的候选(旧 TOP_N=8 硬门的老毛病)。
// 候选已按确定性 rank 分降序,top-5 覆盖绝大多数真数据接口;若漏召回再上调。
const LLM_CANDIDATE_CAP = 5;
const DATA_RESPONSE_KINDS = new Set(['array', 'object']);

/**
 * 确定垃圾预过滤(Codex:只挡确定垃圾,绝不按分数/命名/罕见度挡)。
 * 判据:**无数据响应形状(非 array/object)且无业务参数** —— beacon/心跳/204 这类结构上不可能是数据命令。
 * 保守:有数据形状(如无参热榜列表)或有参数的一律保留,交 LLM 裁判。
 */
export function isConfirmedJunk(c: RankCandidate): boolean {
  const hasDataShape = !!c.responseShape && DATA_RESPONSE_KINDS.has(c.responseShape.kind ?? '');
  const hasParams = (c.args?.length ?? 0) > 0 || Object.keys(c.endpoint?.queryParams ?? {}).length > 0;
  return !hasDataShape && !hasParams;
}

/** 选要喂给 LLM 的候选:用户显式选集优先(按选中顺序,仍去确定垃圾) → 否则去垃圾+按分降序+软上限截断。
 *  全垃圾时回退原集(永不喂空)。 */
export function selectCandidatesForLlm(candidates: RankCandidate[], cap = LLM_CANDIDATE_CAP, candidateIds?: string[]): RankCandidate[] {
  // 用户手选:只保留选中的(过滤确定垃圾仍生效,防误选 beacon);保持降序便于 prompt 稳定。
  if (candidateIds && candidateIds.length) {
    const want = new Set(candidateIds);
    const picked = candidates.filter((c) => want.has(c.id) && !isConfirmedJunk(c));
    if (picked.length) return [...picked].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    // 选集全是垃圾/不存在 → 落到自动选(永不喂空)。
  }
  const usable = candidates.filter((c) => !isConfirmedJunk(c));
  const pool = usable.length ? usable : candidates;
  return [...pool].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, cap);
}

/** 评分信号 → 权威 delta(取自 ScoringProfile,与 score.ts 同源)。
 *  第4步(Codex High 5 ②):`response_varies_with_seed` 是**语义信号**(响应随输入变化是 LLM 判断,
 *  非确定性回显),归 SEMANTIC_BONUS_TABLE(strong:15),**不再**在这里别名到 RESPONSE_ECHO_DELTA——
 *  否则它在 rule(+10)与 semantic(+15)两轨各有一个 home,LLM 一旦两处都报就双重计分。
 *  确定性的 `response_echoes_seed`(响应字面回显 seed 值)仍是 rule 信号,保留。 */
const signalDeltas = (p: ScoringProfile): Record<string, number> => ({
  stable_json_shape: p.RANK_SCORE_STABLE_JSON_SHAPE_DELTA,
  seed_arg_maps_to_param: p.RANK_SCORE_SEED_ARG_PARAM_DELTA,
  response_echoes_seed: p.RANK_SCORE_RESPONSE_ECHO_DELTA,
  requires_session: p.RANK_SCORE_REQUIRES_SESSION_DELTA,
  // 14-plan 校准:`dynamic_field` **不再**经 profile 加平惩罚(RANK_SCORE_DYNAMIC_FIELD_DELTA 现为 0)。
  //   真正的动态惩罚按 ParamObservation 事实分级(computeDynamicPenalty:signed -15 / unknown -5 /
  //   cacheBuster 0),在 be 侧从 candidate.paramObservations 算。LLM 若仍报 dynamic_field ruleSignal,
  //   映射到 0(见下方 present 过滤),不双重计分。
  weak_html_static: p.RANK_SCORE_HTML_STATIC_ANALYTICS_DELTA,
  suspected_mutation: p.RANK_SCORE_SUSPECTED_MUTATION_DELTA,
});

// ── 14-plan 校准:按参数事实分级的动态惩罚(替代旧 dynamic_field 平惩罚 -10)──
// 输入 = 该 endpoint group 的 ParamObservation 事实(core 产出,含 dynamicLike/signedLike/cacheBusterLike)。
// 分级(Codex 裁决,风险不叠加计数,取**单条最严类**惩罚一次):
//   - signedLike        → -15(签名/鉴权/反爬,风险最高)
//   - unknown dynamic   → -5 (dynamicLike 但既非 signed 也非 cacheBuster,如 uuid/web_id)
//   - cacheBusterLike   → 0 (读接口 _t/ts/rand 缓存破坏,不减数据价值;仅进 risks)
// 取最严:penalty = 最负的适用类,只 apply 一次(不按参数个数累加)。cacheBuster 无分数命中但记 risk。
const DYNAMIC_CLASS_RANK: Record<'signed' | 'unknown' | 'cacheBuster', number> = { signed: 3, unknown: 2, cacheBuster: 1 };
function computeDynamicPenalty(
  observations: ParamObservation[] | undefined,
): { delta: number; risk?: string; explanation?: ScoreExplanationItem } {
  if (!observations?.length) return { delta: 0 };
  let worst: 'signed' | 'unknown' | 'cacheBuster' | null = null;
  for (const p of observations) {
    if (!p.dynamicLike) continue;
    const cls = p.signedLike ? 'signed' : p.cacheBusterLike ? 'cacheBuster' : 'unknown';
    if (!worst || DYNAMIC_CLASS_RANK[cls] > DYNAMIC_CLASS_RANK[worst]) worst = cls;
  }
  if (!worst) return { delta: 0 };
  if (worst === 'signed') {
    return { delta: -15, risk: 'signed_or_auth_param', explanation: { signal: 'signed_param', delta: -15, detail: 'signature/auth/anti-bot dynamic param (higher risk)' } };
  }
  if (worst === 'unknown') {
    return { delta: -5, risk: 'unexplained_dynamic_param', explanation: { signal: 'unknown_dynamic_param', delta: -5, detail: 'unexplained dynamic param (e.g. uuid/web_id/device_id)' } };
  }
  // cacheBuster: read-endpoint cache-buster — no score hit, risk-only (Codex).
  return { delta: 0, risk: 'cache_buster_param' };
}

// ── 第3步双轨:semanticBonus(Codex Moderate 1)──
// BE 内部表,**不在 ScoringProfile**(Codex High 5 倾向②:语义信号是 LLM 判的,放进 core profile
// 名不副实——core LLM-off 路径永远算不出来,挂在 profile 上只会让配置项看着可调实则空转)。
// 规则:① allowlist(只有这 6 个 semanticSignal 名计分,其它一律 0)② 每类按 strength 取一次
//       ③ 总 cap 40 ④ hardReject 时整段不计(在求分处强制 0,bonus 不翻案)。
const SEMANTIC_BONUS_TABLE: Record<string, { strong: number; medium: number; weak: number }> = {
  response_varies_with_seed: { strong: 15, medium: 10, weak: 5 },
  rich_business_data: { strong: 15, medium: 10, weak: 5 },
  endpoint_semantic_data: { strong: 10, medium: 6, weak: 3 },
  param_interpretable: { strong: 10, medium: 6, weak: 3 },
  pagination_supported: { strong: 8, medium: 5, weak: 2 },
  query_dimensions_available: { strong: 8, medium: 5, weak: 2 },
};
// 语义加分总 cap。2026-06-30 校准由 30→40(Codex,修 "无参数据接口分偏低" 的根因收口):
// 真机 juejin article_rank(稳定 JSON 列表 + 富业务数据,LLM 判 llmUtilityScore=84)带一个 uuid
// 缓存破坏参数。**根因**:旧 dynamic_field 平惩罚 -10 误伤读接口缓存破坏参数(_t/uuid 只是防缓存,
// 不减数据价值)+ 语义 cap 太低,叠加使这类**无参数据命令**数学上够不到 medium(rule 25-10=15,
// bonus 封顶 25 → 40 < MEDIUM_MIN 45 → low,用户核心抱怨"分数还低")。
// 现修:① dynamic 惩罚按 ParamObservation 事实分级(computeDynamicPenalty:signed -15 / unknown -5 /
//   cacheBuster 0),uuid 是 unknown-dynamic 仅 -5;② stable 提到 30;③ 语义表整体提权 + 补
//   query_dimensions_available;④ cap 提到 40。校准后 article_rank:rule=stable30-uuid5=25,
//   bonus=min(40, 15+10+8+6+5=44)=40 → finalScore=65 → medium(接近 high 70)。
// seed 接口仍能靠 rule(stable30+seed20+echo10=60)+ bonus 到 high(≥70)。
// 权威性不变:仍是 be 用固定 delta 双轨求和(rule + 语义 cap),不采信 LLM 自报总分;hardReject→0 不受影响。
const SEMANTIC_BONUS_CAP = 40;

/**
 * 双轨语义加分。返回 {bonus, items}:bonus=min(40, Σ allowlistedUnique),items=逐条 delta(供 scoreExplanation)。
 *
 * 去重边界(Codex Moderate 1,避免与确定性 ruleSignal 双重计分):
 * - allowlist:只有 SEMANTIC_BONUS_TABLE 里的 6 个名计分(含 query_dimensions_available),不在表 → 0。
 * - 每类一次:同名 semanticSignal 出现多次只取首条(按 strength 给分),不累加。
 * - rich_business_data vs stable_json_shape:stable_json_shape(ruleSignal)只证明响应是 array/object;
 *   rich_business_data 要求"字段丰富/列表规模可观"——prompt 已如此框定,信任 LLM 的 strength 判断,
 *   不在 array/object 之外再加确定性守卫(保持简单,主护栏是 allowlist+cap+hardReject)。
 * - param_interpretable vs seed_arg_maps_to_param:已通过 seed_arg ruleSignal(+20 profile delta)计入的
 *   参数不再用 param_interpretable 二次奖励 → present 含 seed_arg_maps_to_param 时跳过 param_interpretable。
 */
function computeSemanticBonus(
  semanticSignals: SemanticSignal[],
  presentRuleNames: Set<string>,
): { bonus: number; items: ScoreExplanationItem[] } {
  const items: ScoreExplanationItem[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const sig of semanticSignals) {
    const table = SEMANTIC_BONUS_TABLE[sig.name];
    if (!table) continue;            // allowlist:非 5 类语义信号不计分
    if (seen.has(sig.name)) continue; // 每类只计一次
    // 去重:seed_arg 已奖励的参数不用 param_interpretable 二次加分。
    if (sig.name === 'param_interpretable' && presentRuleNames.has('seed_arg_maps_to_param')) continue;
    seen.add(sig.name);
    const delta = table[sig.strength] ?? table.weak;
    total += delta;
    items.push({ signal: sig.name, delta, ...(sig.why ? { detail: sig.why } : {}) });
  }
  // 总 cap:封顶 40(逐条 delta 不缩放,只截总分——scoreExplanation 仍展示原始贡献)。
  return { bonus: Math.min(SEMANTIC_BONUS_CAP, total), items };
}

function bandFor(score: number, hardReject: string | null, p: ScoringProfile): ScoredCandidate['confidence'] {
  if (hardReject) return 'rejected';
  if (score < p.RANK_SCORE_LOW_MIN) return 'rejected';
  if (score >= p.RANK_SCORE_HIGH_MIN) return 'high';
  if (score >= p.RANK_SCORE_MEDIUM_MIN) return 'medium';
  return 'low';
}

const PROMPT_A = [
  '你是 byCLI recorder 的数据接口评审器。你会收到一次浏览器任务的 A/B 录制摘要(两个 sample 用不同输入)。',
  '',
  '🔴 重要前提:下面每个候选都是 recorder-core 已经按 (method + host + pathname) **聚拢好的一个 endpoint group**。',
  '`paramObservations` 是 core 产出的**确定性观测事实**(每个参数:observedVariation 值是否变过、valueKinds 运行时',
  '类型、dynamicLike/cursorLike 名字命中模式、observedCount/totalCalls/observedSamples 覆盖)。',
  '你**不要再自己按 URL 聚拢/拆分**,也不要质疑聚拢;你的工作是在这些事实之上做**语义推断**。',
  '',
  '只输出一个原始 JSON 对象(不要 markdown/正文/解释)。',
  '',
  '## 1. 接口功能(给用户看)',
  '`inferredFunction`:一句平实中文,说明这个 endpoint 做什么 / 返回什么数据(例:"按关键词搜索文章并返回结果列表")。',
  '',
  '## 2. 参数角色推断(paramUnion,逐个 paramObservation 输出)',
  '对每个观测到的参数,输出 `paramRole` ∈ {pagination, dynamic, infrastructure_constant, query_dimension,',
  '  seed_argument, auth_session, unknown_constant}、`exposeAsArg` ∈ {yes, optional_candidate, no}、`inferredMeaning`。',
  '铁律(必须遵守):',
  '- **不要把 observedVariation=false 等同于 "fixed / infrastructure"。** 值没变可能只是 A/B 恰好用了同一个值。',
  '- type / category_id / sort / tab / order 这类**查询维度**即使本次没变,也是 query_dimension(exposeAsArg=optional_candidate),不是 infrastructure_constant。',
  '- seed_argument 只能用于**值确实随用户输入变化**(observedVariation=true 且能对应到用户在 A/B 输入的不同值,或页面 URL 的 seed 参数)。值没真正跟随输入就不是 seed_argument。',
  '- dynamicLike=true(_t/ts/nonce/sign/token/csrf/cb/rand)→ paramRole=dynamic、exposeAsArg=no(同时进 risks)。',
  '- cursorLike=true(cursor/offset/page/page_token/limit)→ paramRole=pagination。',
  '- 依赖 cookie/session 的鉴权类参数 → auth_session、exposeAsArg=no。',
  '',
  '## 3. 双轨信号',
  'A) ruleSignals(可审计确定性事实,每条 present:true/false + why,只用下列固定名):',
  '- stable_json_shape: 响应是 array/object 的稳定列表/对象数据(非 HTML/静态)。',
  '- seed_arg_maps_to_param: A/B 证明用户输入映射到某 query/body/path/header 参数(或 A/B 页面 URL 仅 seed 参数不同,如 /search?q=apple vs ?q=banana,即使 XHR 未体现也算成立)。',
  '- response_echoes_seed: 响应体里**字面回显**了 seed 输入值(确定性可见,非语义判断)。',
  '- requires_session: 依赖 cookie/session/authSignals 且读用户自有数据。',
  '- dynamic_field: 含 dynamicLike 参数(_t/ts/timestamp/nonce/uuid/sign/csrf/token/cb/rand)。',
  '- weak_html_static: 响应像 HTML/静态资源/脚本/样式/图片/字体。',
  '- suspected_mutation: 写方法 POST/PUT/PATCH/DELETE 且响应不是读列表 array。',
  'B) semanticSignals(语义判断,每条 strength:strong|medium|weak + why,只用下列固定名):',
  '- response_varies_with_seed: A/B 响应随输入变化且可解释为查询结果(语义判断,与 rule 的字面 echo 区分;不要同时报成 ruleSignal)。',
  '- rich_business_data: 响应字段丰富 / 列表规模可观,是有价值的业务数据(不只是空壳/单标志)。',
  '- endpoint_semantic_data: 路径/参数/响应语义指向真实数据接口(非埋点/监控)。',
  '- query_dimensions_available: 存在可暴露的查询维度参数(type/category/sort 等)。',
  '- param_interpretable: 参数语义可解释、能映射成命令入参。',
  '- pagination_supported: 支持分页(cursor/offset/page)。',
  '',
  '## 4. hardReject(三类,优先于一切分数,直接拒)',
  '- confirmed_analytics:埋点/监控域名或路径(含字节 Slardar `/monitor_web/`、track、beacon、log、stat 等)。',
  '- confirmed_static:确认静态资源(html/js/css/字体/图片)。',
  '- mutation:写方法且响应不是读列表 array。',
  '**无参数据命令不杀**:稳定可读的列表/排行数据,即使用户输入未映射任何参数、A/B 基本相同,仍是有价值的',
  '无参数据命令 → isDataEndpoint=true、不要 hardReject、stable_json_shape=present;input_independent_across_ab 只进 risks。',
  '',
  '## 5. 效用分(辅助,非权威 —— be 会用固定 delta 双轨重算)',
  '`llmUtilityScore` 0-100、`llmUtilityBand` ∈ {high, medium, low, reject}。',
  '',
  '## 输出 JSON 结构',
  '{ "interfaces": [ {',
  '  "candidateId": 必须原样回传输入候选的 candidateId(下游按它映射回原始候选,务必一致),',
  '  "mergedCandidateIds": [可选,聚拢进来的 id],',
  '  "method", "pathname",',
  '  "inferredFunction": "一句话",',
  '  "paramUnion": [ { "name","in","requiredness","observedVariation","paramRole","exposeAsArg","inferredMeaning","why" } ],',
  '  "isDataEndpoint": bool,',
  '  "hardReject": null 或 "confirmed_analytics"|"confirmed_static"|"mutation",',
  '  "ruleSignals": [ { "name":固定名,"present":bool,"why" } ],',
  '  "semanticSignals": [ { "name":固定名,"strength":"strong"|"medium"|"weak","why" } ],',
  '  "llmUtilityScore": 0-100, "llmUtilityBand": "...",',
  '  "risks": [ ... ], "scoreRationale": "一句话"',
  '} ] }',
  '只用上面列出的固定信号名。',
  '',
  '## 证据形状(evidence,每候选一个数组,A/B 各一条)',
  '为控 prompt 体积,score 阶段**不再喂原始响应体**,改喂**结构摘要**(不含样本值,仅键/形状):',
  '- navigations: A/B 页面 URL 序列(仅 path+query,已去 origin、query 值截断);A/B 导航 diff 可暴露 seed 藏在 URL 里。',
  '- actions: endpoint 调用附近的用户操作(type/selector/valueShape/key)。',
  '- endpointCalls: 每条匹配调用 `{ urlParams(已解析的 query 键值), status, triggeredBy }`(不含原始响应体)。',
  '- responseSummary: 该 endpoint 代表调用的响应结构摘要 `{ status, kind(array/object/scalar/html/unknown),',
  '  topKeys(顶层键), arrayPaths[{path,count}], rowPath(行数据数组路径), rowKeys(行字段点分路径),',
  '  businessFieldHints(像业务数据的字段名) }`。据此判 stable_json_shape / rich_business_data:',
  '  rowKeys 丰富 + businessFieldHints 命真实数据(title/name/view/like/count…)= 有价值的业务列表。',
  '  解析失败时 responseSummary 为 `{ parse:"failed", kind, textPrefix }`(只有短前缀,无完整体)。',
  '输入候选(已聚拢,含 paramObservations 事实 + 上述 evidence)如下:',
].join('\n');

// ── prompt 全局预算闸门(第1步核心)──
// 根因:候选 × 样本 × 响应体在旧路径下相乘、无全局上限 → 真机 98KB。改喂结构摘要后单份已小,
// 但仍加硬上限做兜底:超预算就按「信息价值从低到高」逐级降级,直到 < MAX_SCORE_PROMPT_CHARS。
// 铁律:**绝不降 rowPath/topKeys/kind**(判接口性质的核心结构信息)。
const MAX_SCORE_PROMPT_CHARS = 10_000;
// 降级各级的裁剪量。
const DEGRADE_ACTIONS_CAP = 2;   // 步骤(2):actions 5→2
const DEGRADE_ROWKEYS_CAP = 10;  // 步骤(3):rowKeys 20→10
const DEGRADE_CANDIDATES_CAP = 2; // 步骤(4):候选 3→2

/** 降级动作日志(供 onError/返回统计诊断丢了什么)。 */
export interface ScorePromptStat {
  chars: number;
  candidates: number;
  degraded: string[];
}

type EvidenceList = ScoreEvidence[];
interface PerCand {
  candidateId: string;
  endpoint: Record<string, unknown>;
  paramObservations: unknown;
  responseShapeVariants: unknown;
  mergedRequestIds: unknown;
  prior: Record<string, unknown>;
  args: unknown;
  responseShape: unknown;
  evidence: EvidenceList;
}

function buildPerCand(top: RankCandidate[], samples: ScoreSample[]): PerCand[] {
  return top.map((c) => ({
    candidateId: c.id,
    endpoint: {
      method: c.endpoint?.method,
      host: c.endpoint?.host,
      pathname: c.endpoint?.pathname,
      urlTemplate: c.endpoint?.urlTemplate,
      queryParams: c.endpoint?.queryParams,
      authRequired: c.endpoint?.authRequired,
    },
    // core 聚拢事实:LLM 在其上判语义角色(14-plan 核心架构原则)。
    paramObservations: c.paramObservations,
    responseShapeVariants: c.responseShapeVariants,
    mergedRequestIds: c.mergedRequestIds,
    prior: { heuristicScore: c.score, heuristicConfidence: c.confidence, scoreExplanation: c.scoreExplanation },
    args: c.args,
    responseShape: c.responseShape,
    evidence: samples.map((s) => buildScoreEvidenceSummary(s, c)),
  }));
}

function renderPrompt(perCand: PerCand[]): string {
  return `${PROMPT_A}\n${JSON.stringify(perCand, null, 2)}`;
}

/**
 * 逐级降级(就地修改 perCand),每步后重算体积,直到 < MAX_SCORE_PROMPT_CHARS 或降无可降。
 * 顺序(信息价值从低到高):(1)去 action selector →(2)actions 5→2 →(3)rowKeys 20→10 →(4)候选 3→2。
 * 绝不动 rowPath/topKeys/kind。返回体积统计(含降级步骤)。
 */
function degradeToBudget(perCand: PerCand[]): { prompt: string; stat: ScorePromptStat } {
  const degraded: string[] = [];
  let prompt = renderPrompt(perCand);
  const under = () => prompt.length <= MAX_SCORE_PROMPT_CHARS;

  // (1) 去 action selector
  if (!under()) {
    for (const pc of perCand) for (const ev of pc.evidence) ev.actions = ev.actions.map(({ selector: _s, ...rest }) => rest);
    degraded.push('drop_action_selectors');
    prompt = renderPrompt(perCand);
  }
  // (2) actions 5→2
  if (!under()) {
    for (const pc of perCand) for (const ev of pc.evidence) ev.actions = ev.actions.slice(-DEGRADE_ACTIONS_CAP);
    degraded.push(`actions_to_${DEGRADE_ACTIONS_CAP}`);
    prompt = renderPrompt(perCand);
  }
  // (3) rowKeys 20→10(保留 rowPath/topKeys/kind)
  if (!under()) {
    for (const pc of perCand)
      for (const ev of pc.evidence)
        if (ev.responseSummary?.rowKeys) ev.responseSummary.rowKeys = ev.responseSummary.rowKeys.slice(0, DEGRADE_ROWKEYS_CAP);
    degraded.push(`rowkeys_to_${DEGRADE_ROWKEYS_CAP}`);
    prompt = renderPrompt(perCand);
  }
  // (4) 候选降级(最后手段,丢召回):先 3→2,仍超则继续每次 -1 直到 <budget 或剩 1 个。
  //     绝不动 rowPath/topKeys/kind —— 只能靠减候选数收口。
  if (!under() && perCand.length > DEGRADE_CANDIDATES_CAP) {
    perCand.splice(DEGRADE_CANDIDATES_CAP);
    degraded.push(`candidates_to_${DEGRADE_CANDIDATES_CAP}`);
    prompt = renderPrompt(perCand);
  }
  while (!under() && perCand.length > 1) {
    perCand.pop();
    degraded.push(`candidates_to_${perCand.length}`);
    prompt = renderPrompt(perCand);
  }

  return { prompt, stat: { chars: prompt.length, candidates: perCand.length, degraded } };
}

/** 构建 score prompt + 预算闸门统计(供调用方记日志)。 */
export function buildScorePromptWithStat(input: ScoreInput): { prompt: string; stat: ScorePromptStat } {
  const top = selectCandidatesForLlm(input.candidates, input.cap, input.candidateIds);
  const perCand = buildPerCand(top, input.samples);
  return degradeToBudget(perCand);
}

export function buildScorePrompt(input: ScoreInput): string {
  return buildScorePromptWithStat(input).prompt;
}

export function createScorer(opts: { apiKey?: string; baseURL?: string; model: string; client?: LlmClient; profile?: ScoringProfile; timeoutMs?: number; onError?: (err: unknown) => void }): Scorer {
  const client = makeLlmClient(opts);
  // 第3步 Codex High 6:profile 不冻结在闭包。createScorer 的 opts.profile 仅作**兜底默认**
  // (无调用方传入时用),真正求分以 score(input).profile 为准——handleRank 把 live/preview profile
  // 经 ScoreInput 传进来,确保规则 rank 与 LLM 双轨求和用同一套 profile(热 reload/preview 一致)。
  const fallbackProfile = opts.profile ?? DEFAULT_SCORING_PROFILE;
  return {
    async score(input) {
      if (!client) return null;
      const profile = input.profile ?? fallbackProfile;
      const deltas = signalDeltas(profile);
      try {
        // 评分只靠请求/响应证据判断接口性质,**不发截图**(省一大块 token 提速;截图留给 generate 阶段)。
        const { prompt, stat } = buildScorePromptWithStat(input);
        // 预算闸门降级可诊断:降过级就经 onError 报一条(非错误,是观测)。
        if (stat.degraded.length) {
          opts.onError?.({ kind: 'score_prompt_degraded', ...stat });
        }
        const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];
        const res = await client.messages.create({ model: opts.model, max_tokens: 8000, messages: [{ role: 'user', content }] });
        const text = res.content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
        const json = extractJson(text);
        if (!json) return null;
        // 新 PROMPT_A 输出 `interfaces`(ruleSignals/semanticSignals/paramUnion/inferredFunction);
        // 兼容旧形状 `candidates`(signals)。任一为数组即可解析。
        const parsed = JSON.parse(json) as {
          interfaces?: Array<Record<string, unknown>>;
          candidates?: Array<Record<string, unknown>>;
        };
        const rows = Array.isArray(parsed.interfaces)
          ? parsed.interfaces
          : Array.isArray(parsed.candidates)
            ? parsed.candidates
            : null;
        if (!rows) return null;
        // candidateId → 输入候选(取 paramObservations 事实,用于按参数分级动态惩罚)。
        const inputById = new Map(input.candidates.map((c) => [c.id, c]));
        const out: ScoredCandidate[] = rows
          .map((c) => {
            const candidateId = typeof c.candidateId === 'string' ? c.candidateId : '';
            const hardReject = typeof c.hardReject === 'string' && c.hardReject ? c.hardReject : null;
            // ruleSignals(新)优先,回退 signals(旧);两者形状相同 {name,present,why}。
            const rawRuleArr = Array.isArray(c.ruleSignals)
              ? (c.ruleSignals as Array<Record<string, unknown>>)
              : Array.isArray(c.signals)
                ? (c.signals as Array<Record<string, unknown>>)
                : [];
            const ruleSignals: ScoredSignal[] = rawRuleArr
              .filter((x) => x && typeof x.name === 'string')
              .map((x) => ({ name: x.name as string, present: x.present !== false, why: typeof x.why === 'string' ? x.why : undefined }));
            // 去重(Codex P2):布尔 ruleSignal 按名首现为准,重复只计一次。LLM 输出不保证名唯一,
            // 若把 stable_json_shape 报两次(都 present),+30 profile delta 会叠成 +60——与语义信号
            // 「每类一次」同理(computeSemanticBonus 已 dedup,rule 轨此前漏了)。去重同时影响求和 +
            // scoreExplanation + signals,保证三处一致。
            const seenRuleNames = new Set<string>();
            const present = ruleSignals.filter((x) => {
              if (!x.present || seenRuleNames.has(x.name)) return false;
              seenRuleNames.add(x.name);
              return true;
            });
            const presentRuleNames = seenRuleNames;
            // ① 确定性 rule 分 = be 用固定 profile delta 对成立 ruleSignal 求和(可复现,LLM 自报分忽略)。
            //    注:`dynamic_field` 的 profile delta 现为 0(见 signalDeltas 注释);真正的动态惩罚在下面
            //    按 ParamObservation 事实分级计算,避免误伤读接口缓存破坏参数。
            const baseRuleScore = present.reduce((sum, x) => sum + (deltas[x.name] ?? 0), 0);
            // 按参数事实分级的动态惩罚(signed -15 / unknown -5 / cacheBuster 0,取最严一次)。
            const dynamicPenalty = computeDynamicPenalty(inputById.get(candidateId)?.paramObservations);
            const deterministicRuleScore = baseRuleScore + dynamicPenalty.delta;
            const has = (n: string) => presentRuleNames.has(n);
            const isDataEndpoint = c.isDataEndpoint !== false && !hardReject;
            // 语义层透传(LLM 推断;双轨据此加分 + 前端展示)。先解析,供 semanticBonus 求和。
            const semanticSignals: SemanticSignal[] = Array.isArray(c.semanticSignals)
              ? (c.semanticSignals as Array<Record<string, unknown>>)
                  .filter((x) => x && typeof x.name === 'string')
                  .map((x) => ({
                    name: x.name as string,
                    strength: x.strength === 'strong' || x.strength === 'medium' || x.strength === 'weak' ? x.strength : 'weak',
                    why: typeof x.why === 'string' ? x.why : undefined,
                  }))
              : [];
            // ② 语义加分(allowlist + 每类一次 + cap 25 + seed_arg 去重)。
            const { bonus: rawSemanticBonus, items: semanticItems } = computeSemanticBonus(semanticSignals, presentRuleNames);
            // ③ hardReject 一票否决:finalScore=0、semanticBonus 不翻案(Codex Moderate 1)。
            const semanticBonus = hardReject ? 0 : rawSemanticBonus;
            // finalScore = clamp(deterministicRuleScore + semanticBonus, hardReject→0)。
            const score = hardReject ? 0 : deterministicRuleScore + semanticBonus;
            // B(2026-06-27):稳定可读的「无参数据接口」(列表/排行)即使 seed 未映射、A/B 基本相同,
            // 也值得做成无参数据命令 → 允许进 generate(seed 分够不到 MEDIUM 阈值时也放行,verify 兜底质量)。
            // 判据:数据接口 + 稳定 JSON 列表 + 非写 + 非 HTML/静态。hardReject(埋点/静态/写)仍一票否决;
            // dynamic_field(_t/时间戳缓存破坏)不否决。
            const noArgDataCommand = isDataEndpoint && has('stable_json_shape') && !has('suspected_mutation') && !has('weak_html_static');
            let confidence = bandFor(score, hardReject, profile);
            if (noArgDataCommand && confidence === 'rejected') confidence = 'low'; // 可用数据接口,只是无参
            const decision: ScoredCandidate['decision'] =
              confidence === 'rejected' ? 'reject'
                : noArgDataCommand ? 'generate'
                : confidence === 'low' ? 'review'
                : 'generate';
            // 真 delta 评分依据(Codex Moderate 2):rule signal=profile delta、semantic signal=bonus delta。
            // hardReject 时只留语义层为空、rule 仍展示其原始 delta(透明:为何被拒)。
            // 动态惩罚(signed/unknown)作为 rule 项进 explanation(cacheBuster 仅 risk、无 delta 项)。
            const scoreExplanation: ScoreExplanationItem[] = [
              ...present.map((x) => ({ signal: x.name, delta: deltas[x.name] ?? 0, ...(x.why ? { detail: x.why } : {}) })),
              ...(!hardReject && dynamicPenalty.explanation ? [dynamicPenalty.explanation] : []),
              ...(hardReject ? [] : semanticItems),
            ];
            const paramUnion: ParamUnionItem[] = Array.isArray(c.paramUnion)
              ? (c.paramUnion as Array<Record<string, unknown>>)
                  .filter((p) => p && typeof p.name === 'string')
                  .map((p) => {
                    const inVal = p.in === 'query' || p.in === 'body' || p.in === 'path' || p.in === 'header' ? p.in : 'query';
                    const requiredness = p.requiredness === 'always' || p.requiredness === 'optional' ? p.requiredness : undefined;
                    const exposeAsArg = p.exposeAsArg === 'yes' || p.exposeAsArg === 'optional_candidate' || p.exposeAsArg === 'no' ? p.exposeAsArg : undefined;
                    return {
                      name: p.name as string,
                      in: inVal,
                      ...(requiredness ? { requiredness } : {}),
                      ...(p.observedVariation === true || p.observedVariation === false ? { observedVariation: p.observedVariation } : {}),
                      ...(typeof p.paramRole === 'string' ? { paramRole: p.paramRole } : {}),
                      ...(exposeAsArg ? { exposeAsArg } : {}),
                      ...(typeof p.inferredMeaning === 'string' ? { inferredMeaning: p.inferredMeaning } : {}),
                      ...(typeof p.why === 'string' ? { why: p.why } : {}),
                    };
                  })
              : [];
            const mergedCandidateIds = Array.isArray(c.mergedCandidateIds)
              ? (c.mergedCandidateIds as unknown[]).filter((x): x is string => typeof x === 'string')
              : undefined;
            // reason 向后兼容:新字段是 scoreRationale,旧字段是 reason。
            const reason = typeof c.scoreRationale === 'string' ? c.scoreRationale : typeof c.reason === 'string' ? c.reason : '';
            // risks = LLM 报的 + 动态惩罚分级 risk(signed/unknown/cacheBuster 均记 risk,去重)。
            const llmRisks = Array.isArray(c.risks) ? (c.risks as unknown[]).map(String) : [];
            const risks = dynamicPenalty.risk && !llmRisks.includes(dynamicPenalty.risk)
              ? [...llmRisks, dynamicPenalty.risk]
              : llmRisks;
            return {
              candidateId,
              score,
              uiScore: Math.max(0, Math.min(100, score)),
              confidence,
              decision,
              isDataEndpoint,
              signals: present.map((x) => ({ name: x.name, present: true, why: x.why })),
              scoreExplanation,
              semanticBonus,
              risks,
              reason,
              inferredFunction: typeof c.inferredFunction === 'string' ? c.inferredFunction : undefined,
              paramUnion: paramUnion.length ? paramUnion : undefined,
              ruleSignals,
              semanticSignals: semanticSignals.length ? semanticSignals : undefined,
              llmUtilityScore: typeof c.llmUtilityScore === 'number' ? c.llmUtilityScore : undefined,
              llmUtilityBand: typeof c.llmUtilityBand === 'string' ? c.llmUtilityBand : undefined,
              mergedCandidateIds,
            };
          })
          .filter((c) => c.candidateId);
        out.sort(
          (a, b) =>
            (a.confidence === 'rejected' ? 1 : 0) - (b.confidence === 'rejected' ? 1 : 0) ||
            b.score - a.score ||
            a.candidateId.localeCompare(b.candidateId),
        );
        return { candidates: out };
      } catch (e) {
        // 不破坏 null-fallback 契约(调用方退回规则分,rank 永不失败),但**不再静默吞**:
        // 经 onError 把错误暴露给注入方(be 用结构化 logger 记 status:"error")。超时/网络/解析失败
        // 从此可诊断——此前 bare catch 让 618s 超时与「无 key」都表现为 null,日志误报「no key」。
        opts.onError?.(e);
        return null;
      }
    },
  };
}
