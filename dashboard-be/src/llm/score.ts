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
export interface ScoreResult { candidates: ScoredCandidate[]; /** LLM 返回的原始 interfaces JSON 文本(透明展示用;解析失败/无返回时缺省)。 */ rawInterfacesJson?: string }
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

/** core 已一票否决(hardReject:埋点/静态/mutation)的候选 —— 带 `hard_reject:` risk。这类不该占 LLM
 *  名额(core 规则层已确定拒绝,送 LLM 是浪费 + 挤掉真候选)。注:低分 rejected(score<LOW_MIN)不在此列
 *  (无 hard_reject risk),仍可进 LLM 被救回。 */
function isHardRejected(c: RankCandidate): boolean {
  return (c.risks ?? []).some((r) => r.startsWith('hard_reject:'));
}

/** 选要喂给 LLM 的候选:用户显式选集优先(按选中顺序,仍去确定垃圾/硬拒) → 否则去垃圾+去硬拒+按分降序+软上限截断。
 *  全垃圾时回退原集(永不喂空)。 */
export function selectCandidatesForLlm(candidates: RankCandidate[], cap = LLM_CANDIDATE_CAP, candidateIds?: string[]): RankCandidate[] {
  // 用户手选:只保留选中的(过滤确定垃圾/硬拒仍生效,防误选 beacon/埋点);保持降序便于 prompt 稳定。
  if (candidateIds && candidateIds.length) {
    const want = new Set(candidateIds);
    const picked = candidates.filter((c) => want.has(c.id) && !isConfirmedJunk(c) && !isHardRejected(c));
    if (picked.length) return [...picked].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    // 选集全是垃圾/不存在 → 落到自动选(永不喂空)。
  }
  // 去确定垃圾 + 去 core 硬拒(埋点/静态/mutation),再按分降序取 top-cap。
  const usable = candidates.filter((c) => !isConfirmedJunk(c) && !isHardRejected(c));
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
  '你是 byCLI recorder 的数据接口评审器。收到一次浏览器任务的 A/B 录制摘要(两个 sample 用不同输入)。',
  '每个候选是 recorder-core 已按 (method+host+pathname) **聚拢好的 endpoint group**;你**不重新聚拢/拆分/质疑聚拢**,',
  '只在给定事实上做语义推断。只输出一个原始 JSON 对象(无 markdown/正文/解释)。',
  '',
  '## 读表说明(paramObservations 用 TOON 表格)',
  '`paramObservations[N]{列名...}:` 声明行数与列序,其后每行按列序取值。约定:',
  '- 空单元 = 该列对本行不适用/未命中;`dynamicLike/signedLike/cacheBusterLike/cursorLike` 命中为 `1`、否则空。',
  '- `observedVariation` 是**三态**:`true`(值跨调用变过)/`false`(值稳定)/`unknown`(只见一次或未捕获值)。',
  '  **`unknown` 不等于 `false`** —— 别把"没判过"当成"值稳定"。`coverage`="出现次数/总调用次数"。',
  '- evidence(navigations/actions/endpointCalls/responseSummary)仍是 JSON;endpointCalls 无原始响应体。',
  '',
  '## 1. 接口功能',
  '`inferredFunction`:一句平实中文,说明这个 endpoint 做什么/返回什么数据(例:"按关键词搜索文章并返回结果列表")。',
  '',
  '## 2. 参数角色推断(paramUnion,逐个参数输出)',
  '每参数输出 `paramRole` ∈ {pagination, dynamic, infrastructure_constant, query_dimension, seed_argument,',
  '  auth_session, unknown_constant}、`exposeAsArg` ∈ {yes, optional_candidate, no}、`inferredMeaning`。铁律:',
  '- observedVariation=false **不等于** fixed/infrastructure(可能只是 A/B 恰好同值);unknown 更不是。',
  '- type/category_id/sort/tab/order 这类**查询维度**即使没变也是 query_dimension(exposeAsArg=optional_candidate)。',
  '- seed_argument 仅当**值确实随用户输入变化**(observedVariation=true 且对应 A/B 不同输入,或页面 URL 的 seed 参数)。',
  '- dynamicLike → paramRole=dynamic、exposeAsArg=no(进 risks);cursorLike → paramRole=pagination;',
  '  cookie/session 鉴权参数 → auth_session、exposeAsArg=no。',
  '',
  '## 3. 双轨信号(只用下列固定名)',
  'A) ruleSignals(确定性事实,每条 present:true/false + why):',
  '- stable_json_shape: 响应是 array/object 的稳定列表/对象数据(非 HTML/静态)。',
  '- seed_arg_maps_to_param: A/B 证明用户输入映射到某 query/body/path/header 参数(或 A/B 页面 URL 仅 seed 参数不同,如 /search?q=apple vs ?q=banana,XHR 未体现也算)。',
  '- response_echoes_seed: 响应体**字面回显** seed 输入值(确定性,非语义)。',
  '- requires_session: 依赖 cookie/session/authSignals 且读用户自有数据。',
  '- dynamic_field: 含 dynamicLike 参数。',
  '- weak_html_static: 响应像 HTML/静态资源/脚本/样式/图片/字体。',
  '- suspected_mutation: 写方法 POST/PUT/PATCH/DELETE 且响应不是读列表 array。',
  'B) semanticSignals(语义判断,每条 strength:strong|medium|weak + why):',
  '- response_varies_with_seed: A/B 响应随输入变化且可解释为查询结果(与 rule 的字面 echo 区分,别两处都报)。',
  '- rich_business_data: 响应字段丰富/列表规模可观,是有价值业务数据(非空壳/单标志)。',
  '- endpoint_semantic_data: 路径/参数/响应语义指向真实数据接口(非埋点/监控)。',
  '- query_dimensions_available: 存在可暴露的查询维度参数(type/category/sort 等)。',
  '- param_interpretable: 参数语义可解释、能映射成命令入参。',
  '- pagination_supported: 支持分页(cursor/offset/page)。',
  '',
  '## 4. hardReject(优先于一切分数,直接拒)',
  '- confirmed_analytics:埋点/监控域名或路径(字节 Slardar `/monitor_web/`、track、beacon、log、stat 等)。',
  '- confirmed_static:静态资源(html/js/css/字体/图片)。',
  '- mutation:写方法且响应不是读列表 array。',
  '**无参数据命令不杀**:稳定可读的列表/排行数据,即使输入未映射任何参数、A/B 基本相同,仍 isDataEndpoint=true、',
  '不 hardReject、stable_json_shape=present;input_independent_across_ab 只进 risks。',
  '',
  '## 5. 效用分(辅助,非权威 —— be 用固定 delta 双轨重算,别自行调权)',
  '`llmUtilityScore` 0-100、`llmUtilityBand` ∈ {high, medium, low, reject}。',
  '',
  '## 输出 JSON 结构',
  '⚠️ interfaces 与输入候选**一一对应、同序、同数量**:逐个候选各一条,不重排/遗漏/合并/新增。只用上面的固定信号名。',
  '{ "interfaces": [ {',
  '  "candidateId": 原样回传输入的 candidateId(下游按它映射,顺序也须一致),',
  '  "mergedCandidateIds": [可选], "method", "pathname",',
  '  "inferredFunction": "一句话",',
  '  "paramUnion": [ { "name","in","requiredness","observedVariation","paramRole","exposeAsArg","inferredMeaning","why" } ],',
  '  "isDataEndpoint": bool,',
  '  "hardReject": null | "confirmed_analytics"|"confirmed_static"|"mutation",',
  '  "ruleSignals": [ { "name","present":bool,"why" } ],',
  '  "semanticSignals": [ { "name","strength":"strong"|"medium"|"weak","why" } ],',
  '  "llmUtilityScore": 0-100, "llmUtilityBand": "...",',
  '  "risks": [ ... ], "scoreRationale": "一句话"',
  '} ] }',
  '',
  '## 证据字段速览(evidence,每候选 A/B 各一条;不含原始响应体)',
  '- navigations: A/B 页面 URL(path+query);A/B 导航 diff 可暴露 seed 藏在 URL 里。',
  '- actions: endpoint 调用附近用户操作(type/valueShape/key;valueShape.len 的 A/B 差异是 seed 线索)。',
  '- endpointCalls: `{urlParams,status,triggeredBy}`。urlParams **只列证明性键**(值随 A/B 变的 seed / 分页 cursor);',
  '  稳定常量键不重复(其名字与稳定性已在 paramObservations 表里)—— urlParams 里没有的键即"稳定常量",非缺失。',
  '- responseSummary: `{status,kind,topKeys,arrayPaths[{path,count}],rowPath,rowKeys,businessFieldHints}`。',
  '  rowKeys 丰富 + businessFieldHints 命真实数据(title/name/view/like/count…)= 有价值业务列表 → stable_json_shape/rich_business_data。',
  '  解析失败时为 `{parse:"failed",kind,textPrefix}`(仅短前缀)。',
  '输入候选如下:',
].join('\n');

// ── prompt 全局预算闸门(第1步核心)──
// 根因:候选 × 样本 × 响应体在旧路径下相乘、无全局上限 → 真机 98KB。改喂结构摘要后单份已小,
// 但仍加硬上限做兜底:超预算就按「信息价值从低到高」逐级降级,直到 < MAX_SCORE_PROMPT_CHARS。
// 铁律:**绝不降 rowPath/topKeys/kind**(判接口性质的核心结构信息)。
//
// 2026-07-01 由 10_000 提到 40_000(修 scored=1/N 根因)。旧值 10_000 是「原始响应体」时代的兜底,
// 改喂结构摘要 + cap 20→5 后从未重调:实测 PROMPT_A 基座 ~4.3KB,单个 juejin 富数据候选完全降级后仍 ~8KB,
// 于是 2 个候选(~11.7KB)就超 10_000 → 候选降级把 cap=5 一路 pop 到 1 → LLM 只收到 1 个候选 →
// 只回 1 个 interface → 合并回 scored=1/N(其余 N-1 被静默丢在预算闸门,非 LLM 失败)。
// 2026-07-02 由 40_000 提到 68_000(修 /search 被 pop + ②③ 匹配):真机诊断 cap=8 时预算把 8 pop 到 2。
// paramObservations 精简(compactParamObs)后单候选实测 ~6.1KB(原 6.9KB),cap=10 → 基座 2.9KB + 10×6.1KB
// ≈ 64KB;预算 68_000 给足余量让 cap=10 富数据候选全进 LLM、不再 pop。红线:98KB 级撞过网关超时;
// 68_000 chars ≈ 17K tokens,远低于超时线。降级阶梯仍保留兜底病态输入。真机以 score_candidate_selection
// 的 sent 数 == selected 数为准(全进,无 pop)。
const MAX_SCORE_PROMPT_CHARS = 68_000;
// 分批并发(破 CF 120s 硬墙):LLM 网关 api.ikuncode.cc 前套 Cloudflare,120s Proxy Read Timeout 硬限。
// 候选多→输出 token 多→逐 token 生成 >120s → CF 524 掐断 → 全走规则分。实测 2 候选 87s(<120s ok)、
// 7 候选 371s(524 失败)。故把候选切成小批,每批独立调 LLM,并发跑;墙钟≈最慢单批而非串行和。
// 每批 SCORE_BATCH_SIZE 个候选控制单批输出量 <120s;并发度限 SCORE_BATCH_CONCURRENCY 防网关 QPS 限流。
const SCORE_BATCH_SIZE = 3;
const SCORE_BATCH_CONCURRENCY = 3;
// 降级各级的裁剪量。
const DEGRADE_ACTIONS_CAP = 2;   // 步骤(2):actions 5→2
const DEGRADE_ROWKEYS_CAP = 10;  // 步骤(3):rowKeys 20→10
const DEGRADE_CANDIDATES_CAP = 2; // 步骤(4):候选 3→2

/** 降级动作日志(供 onError/返回统计诊断丢了什么)。 */
export interface ScorePromptStat {
  chars: number;
  candidates: number;
  degraded: string[];
  /** 实际发送给 LLM 的候选 id(post-degradation,按 prompt 内顺序);score() 用于回填 id 位置对齐兜底。 */
  sentIds: string[];
  /** cap 选中(去垃圾+降序+软上限)但**降级前**的候选 id;与 sentIds 对比可看谁被预算 pop。 */
  selectedIds: string[];
  /** 全部候选 id + rank 规则分(降序);诊断某接口是没被提取、还是 cap 截断(看排第几)、还是预算 pop。 */
  allScored: Array<{ id: string; score: number }>;
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

/** score 专用精简 paramObservations(②b 压体积):只留 LLM 判角色的核心信号,砍冗余观测子字段。
 *  保留 name/in/observedVariation + 名字命中标志(dynamic/signed/cacheBuster/cursorLike)+ 覆盖率
 *  (observedCount/totalCalls 合成 "n/m")。砍 observedSamples(A/B 数组)、valueKinds、observedAlways
 *  (可由覆盖率推)。只在信号为 true 时带该键(false/空不占字符)。core 原 paramObservations 不变。 */
function compactParamObs(obs: unknown): CompactParamObs[] | unknown {
  if (!Array.isArray(obs)) return obs;
  return obs.map((p: Record<string, unknown>) => {
    const out: CompactParamObs = { name: String(p.name ?? ''), in: String(p.in ?? '') };
    // observedVariation 是**三态** true|false|'unknown'(core aggregate.ts):unknown 不能当 false,
    // 否则 LLM 会把"只出现一次/body 未捕获值"误判成"值稳定"。原样透传三态。
    if (p.observedVariation !== undefined) out.observedVariation = p.observedVariation as boolean | 'unknown';
    if (typeof p.observedCount === 'number' && typeof p.totalCalls === 'number') out.coverage = `${p.observedCount}/${p.totalCalls}`;
    for (const flag of ['dynamicLike', 'signedLike', 'cacheBusterLike', 'cursorLike'] as const) {
      if (p[flag]) out[flag] = true;
    }
    return out;
  });
}

/** compactParamObs 单行形状(TOON 编码器输入)。 */
interface CompactParamObs {
  name: string;
  in: string;
  observedVariation?: boolean | 'unknown';
  coverage?: string;
  dynamicLike?: true;
  signedLike?: true;
  cacheBusterLike?: true;
  cursorLike?: true;
}

// TOON(Token-Oriented Object Notation)表格列序 —— 表头声明一次,逐行按此序取值,消除每行重复的字段名。
// 顺序固定 = 表头即 schema;endpointCalls/rowKeys 不 TOON 化(codex A2/A3:urlParams 嵌套键随接口变、
// rowKeys 收益小),仅 paramObservations 这种**同构 + 字段稳定**的数组表格化。
const TOON_PARAM_COLS = ['name', 'in', 'observedVariation', 'coverage', 'dynamicLike', 'signedLike', 'cacheBusterLike', 'cursorLike'] as const;

/**
 * 把 compactParamObs 数组编码成 TOON 表格(表头 + 逐行)。零字段丢失:每参数每信号位都逐行保留。
 * 编码约定(须与 PROMPT_A 的"读表说明"一致):
 * - 首行 `paramObservations[N]{col,col,...}:` 声明行数 + 列序。
 * - observedVariation **保留三态**字面量(true/false/unknown),绝不压成 1/空 —— unknown≠false(codex 红线)。
 * - 布尔命中列(dynamicLike/signedLike/cacheBusterLike/cursorLike):命中→`1`,未命中/缺省→空单元。
 * - coverage 原样 "n/m";空单元 = 该列对本行不适用。
 * 非数组(异常输入)→ 退回 JSON 串(不抛,保证 renderPrompt 永不崩)。
 */
export function toonParamObservations(compacted: unknown): string {
  if (!Array.isArray(compacted)) return JSON.stringify(compacted);
  const header = `paramObservations[${compacted.length}]{${TOON_PARAM_COLS.join(',')}}:`;
  // 命中列(布尔):命中→1、缺省→空。observedVariation 是三态列,绝不用 1/空,始终写字面量 true/false/unknown。
  const FLAG_COLS = new Set(['dynamicLike', 'signedLike', 'cacheBusterLike', 'cursorLike']);
  const cell = (p: CompactParamObs, col: (typeof TOON_PARAM_COLS)[number]): string => {
    const v = (p as unknown as Record<string, unknown>)[col];
    if (col === 'observedVariation') return v === undefined ? '' : String(v); // 三态字面量:true/false/unknown
    if (FLAG_COLS.has(col)) return v === true ? '1' : '';                     // 命中列:1 / 空
    return v === undefined ? '' : String(v);                                   // name/in/coverage 原样
  };
  const rows = compacted.map((p) => '  ' + TOON_PARAM_COLS.map((c) => cell(p as CompactParamObs, c)).join(','));
  return [header, ...rows].join('\n');
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
    // score 专用精简(②b 压体积):保留 LLM 判 paramRole 的核心信号位(observedVariation + dynamic/signed/
    // cacheBuster/cursorLike 名字命中 + 覆盖率),砍冗余(observedSamples 数组、valueKinds、observedCount/
    // totalCalls/observedAlways 三个可合成一个 coverage)。实测单候选大头是这些每参数一整套字段的累积。
    paramObservations: compactParamObs(c.paramObservations),
    responseShapeVariants: c.responseShapeVariants,
    mergedRequestIds: c.mergedRequestIds,
    prior: { heuristicScore: c.score, heuristicConfidence: c.confidence, scoreExplanation: c.scoreExplanation },
    args: c.args,
    responseShape: c.responseShape,
    // 逐样本、逐候选隔离 evidence 构建:某个候选(或其某个 sample)在摘要构建中抛错,
    // **绝不能**让整批 buildScorePromptWithStat 抛出 → score() 外层 catch → 返回 null → 所有候选丢分。
    // 该候选降级为空 evidence(仍带 endpoint/paramObservations 事实,LLM 仍能判性质),其余候选照常。
    evidence: samples
      .map((s) => {
        try {
          return buildScoreEvidenceSummary(s, c);
        } catch {
          return null;
        }
      })
      .filter((e): e is ScoreEvidence => e != null),
  }));
}

/**
 * 渲染 perCand 数组为 prompt 数据段。paramObservations **表格化为 TOON**(表头+行,省重复字段名);
 * 其余字段(endpoint/evidence/endpointCalls/responseSummary/rowKeys)保持 JSON(codex A2/A3:
 * urlParams 嵌套键随接口变、rowKeys 收益小,不 TOON 化)。
 *
 * 实现:每候选先把 paramObservations 从对象里摘出、其余字段 minified-JSON(无缩进),再把 TOON 表格块拼在该候选后。
 * 这样 degradeToBudget 就地改 perCand(actions/rowKeys/候选数)后重新 renderPrompt 仍成立。
 */
function renderPrompt(perCand: PerCand[]): string {
  const blocks = perCand.map((pc) => {
    const { paramObservations, ...rest } = pc;
    // minify(不带缩进):JSON 语义不变、LLM 解析等价,但省掉所有换行/缩进空格(实测数据段省 ~38%)。
    const restJson = JSON.stringify(rest);
    const toon = toonParamObservations(paramObservations);
    // 候选块:其余字段 JSON(单行)+ 一段 TOON paramObservations(表头+行)。用 --- 分隔让 LLM 明确二者同属一个候选。
    return `${restJson}\n${toon}`;
  });
  return `${PROMPT_A}\n[\n${blocks.join('\n---\n')}\n]`;
}

/**
 * 逐级降级(就地修改 perCand),每步后重算体积,直到 < MAX_SCORE_PROMPT_CHARS 或降无可降。
 * 顺序(信息价值从低到高):(1)actions 5→2 →(2)rowKeys 20→10 →(3)候选 3→2。
 * 绝不动 rowPath/topKeys/kind。返回体积统计(含降级步骤)。
 * 注:score 侧 actions 已不带 selector(见 buildScoreEvidenceSummary),旧的"去 selector"降级步已删。
 */
function degradeToBudget(perCand: PerCand[]): { prompt: string; stat: ScorePromptStat } {
  const degraded: string[] = [];
  let prompt = renderPrompt(perCand);
  const under = () => prompt.length <= MAX_SCORE_PROMPT_CHARS;

  // (1) actions 5→2
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

  return { prompt, stat: { chars: prompt.length, candidates: perCand.length, degraded, sentIds: perCand.map((pc) => pc.candidateId), selectedIds: [], allScored: [] } };
}

/** 构建 score prompt + 预算闸门统计(供调用方记日志)。 */
export function buildScorePromptWithStat(input: ScoreInput): { prompt: string; stat: ScorePromptStat } {
  const top = selectCandidatesForLlm(input.candidates, input.cap, input.candidateIds);
  const perCand = buildPerCand(top, input.samples);
  const { prompt, stat } = degradeToBudget(perCand);
  // 诊断:全部候选(id+rank分,降序)+ cap 选中集,供定位某接口死在「未提取 / cap 截断 / 预算 pop」哪一关。
  stat.selectedIds = top.map((c) => c.id);
  stat.allScored = [...input.candidates]
    .map((c) => ({ id: c.id, score: c.score ?? 0 }))
    .sort((a, b) => b.score - a.score);
  return { prompt, stat };
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
      // 全量候选索引:动态惩罚(computeDynamicPenalty)按参数事实算,须用**原始**候选(非分批子集/compact)。
      const inputById = new Map(input.candidates.map((c) => [c.id, c]));

      /** 单批评分:对一批候选独立 buildPrompt→调 LLM→解析→逐行求分(位置对齐按**本批** sentIds)。
       *  失败(CF 524/超时/解析失败)→ 返回 null(该批候选保留规则分,不拖垮其余批)。 */
      const scoreBatch = async (batchCands: RankCandidate[]): Promise<{ out: ScoredCandidate[]; rawJson: string } | null> => {
        try {
          // 用本批候选构建 prompt(candidateIds 锁定本批,cap 给足不再截断——批已够小)。
          const batchInput: ScoreInput = { candidates: batchCands, samples: input.samples, profile, cap: batchCands.length, candidateIds: batchCands.map((c) => c.id) };
          const { prompt, stat } = buildScorePromptWithStat(batchInput);
          if (stat.degraded.length) {
            opts.onError?.({ kind: 'score_prompt_degraded', chars: stat.chars, candidates: stat.candidates, degraded: stat.degraded, sentIds: stat.sentIds });
          }
          const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];
          const tLlm = Date.now();
          const res = await client.messages.create({ model: opts.model, max_tokens: 8000, messages: [{ role: 'user', content }] });
          const text = res.content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
          // 诊断:每批 LLM 墙钟 + 输入/输出量。破 CF 120s 硬墙看这条——单批 ms 必须 <120s。
          opts.onError?.({
            kind: 'score_llm_timing', ms: Date.now() - tLlm,
            promptChars: prompt.length, outChars: text.length, sent: stat.sentIds.length,
            ...(res.usage ? { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } : {}),
            ...(res.stop_reason ? { stopReason: res.stop_reason } : {}),
          });
          const json = extractJson(text);
          if (!json) return null;
          const parsed = JSON.parse(json) as { interfaces?: Array<Record<string, unknown>>; candidates?: Array<Record<string, unknown>> };
          const rows = Array.isArray(parsed.interfaces) ? parsed.interfaces : Array.isArray(parsed.candidates) ? parsed.candidates : null;
          if (!rows) return null;
          // 位置对齐兜底(按本批 sentIds):LLM 漏填/改写 candidateId 时按发送顺序 + endpoint 交叉校验归位。
          const sentIds = stat.sentIds;
          const alignByPosition = rows.length === sentIds.length && new Set(sentIds).size === sentIds.length;
          if (rows.length !== sentIds.length) opts.onError?.({ kind: 'score_rows_count_mismatch', rows: rows.length, sent: sentIds.length });
          const rowMatchesSlot = (row: Record<string, unknown>, slotId: string): boolean => {
            const cand = inputById.get(slotId);
            if (!cand) return false;
            const rm = typeof row.method === 'string' ? row.method.toUpperCase() : '';
            const rp = typeof row.pathname === 'string' ? row.pathname : '';
            const cm = (cand.endpoint?.method ?? '').toUpperCase();
            const cp = cand.endpoint?.pathname ?? '';
            if (!rm && !rp) return true;
            return (!rm || rm === cm) && (!rp || rp === cp);
          };
          let matchedById = 0, matchedByPos = 0, posMismatch = 0;
          const out: ScoredCandidate[] = rows
            .map((c, i) => {
              const rawId = typeof c.candidateId === 'string' ? c.candidateId : '';
              const idHit = rawId && inputById.has(rawId);
              let candidateId = rawId;
              if (idHit) { matchedById++; }
              else if (alignByPosition && sentIds[i] && rowMatchesSlot(c, sentIds[i])) { candidateId = sentIds[i]; matchedByPos++; }
              else if (alignByPosition && sentIds[i]) { posMismatch++; }
              const hardReject = typeof c.hardReject === 'string' && c.hardReject ? c.hardReject : null;
              const rawRuleArr = Array.isArray(c.ruleSignals) ? (c.ruleSignals as Array<Record<string, unknown>>) : Array.isArray(c.signals) ? (c.signals as Array<Record<string, unknown>>) : [];
              const ruleSignals: ScoredSignal[] = rawRuleArr
                .filter((x) => x && typeof x.name === 'string')
                .map((x) => ({ name: x.name as string, present: x.present !== false, why: typeof x.why === 'string' ? x.why : undefined }));
              const seenRuleNames = new Set<string>();
              const present = ruleSignals.filter((x) => {
                if (!x.present || seenRuleNames.has(x.name)) return false;
                seenRuleNames.add(x.name);
                return true;
              });
              const presentRuleNames = seenRuleNames;
              const baseRuleScore = present.reduce((sum, x) => sum + (deltas[x.name] ?? 0), 0);
              const dynamicPenalty = computeDynamicPenalty(inputById.get(candidateId)?.paramObservations);
              const deterministicRuleScore = baseRuleScore + dynamicPenalty.delta;
              const has = (n: string) => presentRuleNames.has(n);
              const isDataEndpoint = c.isDataEndpoint !== false && !hardReject;
              const semanticSignals: SemanticSignal[] = Array.isArray(c.semanticSignals)
                ? (c.semanticSignals as Array<Record<string, unknown>>)
                    .filter((x) => x && typeof x.name === 'string')
                    .map((x) => ({ name: x.name as string, strength: x.strength === 'strong' || x.strength === 'medium' || x.strength === 'weak' ? x.strength : 'weak', why: typeof x.why === 'string' ? x.why : undefined }))
                : [];
              const { bonus: rawSemanticBonus, items: semanticItems } = computeSemanticBonus(semanticSignals, presentRuleNames);
              const semanticBonus = hardReject ? 0 : rawSemanticBonus;
              const score = hardReject ? 0 : deterministicRuleScore + semanticBonus;
              const noArgDataCommand = isDataEndpoint && has('stable_json_shape') && !has('suspected_mutation') && !has('weak_html_static');
              let confidence = bandFor(score, hardReject, profile);
              if (noArgDataCommand && confidence === 'rejected') confidence = 'low';
              const decision: ScoredCandidate['decision'] =
                confidence === 'rejected' ? 'reject' : noArgDataCommand ? 'generate' : confidence === 'low' ? 'review' : 'generate';
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
                        name: p.name as string, in: inVal,
                        ...(requiredness ? { requiredness } : {}),
                        ...(p.observedVariation === true || p.observedVariation === false ? { observedVariation: p.observedVariation } : {}),
                        ...(typeof p.paramRole === 'string' ? { paramRole: p.paramRole } : {}),
                        ...(exposeAsArg ? { exposeAsArg } : {}),
                        ...(typeof p.inferredMeaning === 'string' ? { inferredMeaning: p.inferredMeaning } : {}),
                        ...(typeof p.why === 'string' ? { why: p.why } : {}),
                      };
                    })
                : [];
              const mergedCandidateIds = Array.isArray(c.mergedCandidateIds) ? (c.mergedCandidateIds as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;
              const reason = typeof c.scoreRationale === 'string' ? c.scoreRationale : typeof c.reason === 'string' ? c.reason : '';
              const llmRisks = Array.isArray(c.risks) ? (c.risks as unknown[]).map(String) : [];
              const risks = dynamicPenalty.risk && !llmRisks.includes(dynamicPenalty.risk) ? [...llmRisks, dynamicPenalty.risk] : llmRisks;
              return {
                candidateId, score, uiScore: Math.max(0, Math.min(100, score)), confidence, decision, isDataEndpoint,
                signals: present.map((x) => ({ name: x.name, present: true, why: x.why })),
                scoreExplanation, semanticBonus, risks, reason,
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
          opts.onError?.({ kind: 'score_id_alignment', matchedById, matchedByPos, posMismatch, rows: rows.length, sent: sentIds.length });
          return { out, rawJson: json };
        } catch (e) {
          opts.onError?.(e);
          return null;
        }
      };

      try {
        // 先选定要评分的候选(cap + 去垃圾/硬拒),诊断照打(all/selected/sent 三集)。
        const selected = selectCandidatesForLlm(input.candidates, input.cap, input.candidateIds);
        opts.onError?.({
          kind: 'score_candidate_selection',
          total: input.candidates.length,
          selected: selected.map((c) => c.id),
          sent: selected.map((c) => c.id), // 分批后全部选中候选都会被送(不再有预算 pop);保留字段兼容诊断
          all: [...input.candidates].map((c) => ({ id: c.id, score: c.score ?? 0 })).sort((a, b) => b.score - a.score).map((a) => `${a.id}:${a.score}`),
        });
        if (!selected.length) return null;
        // 切批:每 SCORE_BATCH_SIZE 个一批,破 CF 120s(候选多→输出多→单次 >120s 524)。
        const batches: RankCandidate[][] = [];
        for (let i = 0; i < selected.length; i += SCORE_BATCH_SIZE) batches.push(selected.slice(i, i + SCORE_BATCH_SIZE));
        // 受限并发跑各批(并发度 SCORE_BATCH_CONCURRENCY,防网关 QPS 限流);合并所有批的 ScoredCandidate[]。
        const results: Array<{ out: ScoredCandidate[]; rawJson: string } | null> = new Array(batches.length);
        let cursor = 0;
        const worker = async (): Promise<void> => {
          while (cursor < batches.length) {
            const idx = cursor++;
            const batch = batches[idx];
            if (batch) results[idx] = await scoreBatch(batch);
          }
        };
        await Promise.all(Array.from({ length: Math.min(SCORE_BATCH_CONCURRENCY, batches.length) }, worker));
        const merged = results.filter((r): r is { out: ScoredCandidate[]; rawJson: string } => r != null);
        // 全批失败 → null(调用方退回规则分,契约不变);部分失败 → 成功批照常,失败批候选保留规则分。
        if (!merged.length) return null;
        const out = merged.flatMap((r) => r.out);
        out.sort(
          (a, b) =>
            (a.confidence === 'rejected' ? 1 : 0) - (b.confidence === 'rejected' ? 1 : 0) ||
            b.score - a.score ||
            a.candidateId.localeCompare(b.candidateId),
        );
        // rawInterfacesJson:合并各批原始 JSON(前端「LLM 返回内容」展示);多批用数组包裹。
        const rawInterfacesJson = merged.length === 1 ? merged[0]!.rawJson : JSON.stringify(merged.map((r) => { try { return JSON.parse(r.rawJson); } catch { return r.rawJson; } }));
        return { candidates: out, rawInterfacesJson };
      } catch (e) {
        opts.onError?.(e);
        return null;
      }
    },
  };
}
