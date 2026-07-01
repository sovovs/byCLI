/**
 * Recorder Core Engine — type mirror of schemas/adapter-recorder.bundle.json $defs.
 *
 * KEEP IN SYNC with dashboard-docs/system/adapter-recorder-system/schemas/
 * adapter-recorder.bundle.json ($defs) and the prose in 06-recorder-core-engine.md.
 * These are hand-written to match the wire contract (same pattern as the frontend's
 * dashboard/src/types/recorder.ts); the bundle is the single source of truth.
 */

// ── Canonical capture ($defs: SourceCompleteness / RecorderNetworkEntry / CaptureSample) ──

export type Completeness = 'present' | 'missing';
export type BodyCompleteness = 'present' | 'missing' | 'truncated';

export interface SourceCompleteness {
  requestHeaders: Completeness;
  requestBody: BodyCompleteness;
  responseBody: BodyCompleteness;
  timing: Completeness;
}

export type BodyShapeType = 'json' | 'form' | 'text' | 'empty';
export type ResponseKind = 'array' | 'object' | 'scalar' | 'html' | 'unknown';

export interface RequestBodyShape {
  type?: BodyShapeType;
  keys?: string[];
}

export interface CanonicalResponse {
  status?: number;
  mime?: string;
  bodyShape?: { kind?: ResponseKind; itemKeys?: string[] };
  shapeConfidence?: number;
}

export interface RecorderNetworkEntry {
  requestId: string;
  page?: string;
  method: string;
  url: string;
  host?: string;
  pathname?: string;
  queryParams?: Record<string, unknown>;
  requestHeadersShape?: Record<string, unknown>;
  authSignals?: Record<string, unknown>;
  requestBodyShape?: RequestBodyShape;
  response?: CanonicalResponse;
  timing?: { startedAt?: number; durationMs?: number };
  sourceCompleteness: SourceCompleteness;
}

export interface EvidenceSeedArg {
  placeholder?: string;
  type?: string;
  hmac?: string;
  length?: number;
  hmacScope?: 'recorder_session';
  comparableAcrossRuns?: false;
  usage?: 'display_only';
}

export type SampleName = 'A' | 'B';

export interface CaptureSample {
  sampleName: SampleName;
  seedArgsEvidence?: Record<string, EvidenceSeedArg>;
  entries: RecorderNetworkEntry[];
}

// ── Rank output ($defs: EndpointDescriptor / ArgMapping / ResponseShape / RankCandidate / …) ──

export interface EndpointDescriptor {
  method: string;
  urlTemplate: string;
  host: string;
  pathname: string;
  queryParams?: Record<string, unknown>;
  dynamicParams?: string[];
  excludedParams?: string[];
  requestBodyShape?: RequestBodyShape;
  authRequired?: boolean;
}

export type ArgIn = 'query' | 'body' | 'path' | 'header';

export interface ArgMapping {
  argName: string;
  in: ArgIn;
  paramName: string;
  valueType?: string;
  evidenceId?: string;
}

export interface ResponseShape {
  kind?: ResponseKind;
  itemKeys?: string[];
  count?: number;
  shapeConfidence?: number;
  echoesSeedArg?: boolean;
}

export interface ColumnDescriptor {
  name?: string;
  path?: string;
  type?: string;
}

export interface ScoreExplanationItem {
  signal: string;
  delta: number;
  detail?: string;
}

export type Confidence = 'high' | 'medium' | 'low' | 'rejected';

/**
 * A deterministic, OBSERVED FACT about a single request param across the calls that hit
 * one aggregated endpoint (method+host+pathname). This is the recorder-core (pure-domain)
 * half of param analysis: it records ONLY what was observed, never a semantic judgement.
 *
 * 🔴 Architecture invariant (14-candidate-aggregation-scoring-plan.md · "核心架构原则"):
 * recorder-core MUST NOT emit paramRole / exposeAsArg / inferredMeaning — those are the
 * LLM layer's job in a later step. Keep this struct facts-only.
 *
 * Mirrors a new bundle $def (ParamObservation) — bundle sync happens in a later step.
 */
export interface ParamObservation {
  name: string;
  in: 'query' | 'body';
  /** how many member calls carried this param. */
  observedCount: number;
  /** total member calls in the endpoint group (observedCount ≤ totalCalls). */
  totalCalls: number;
  /** which capture samples (A/B) this param was observed in (deduped). */
  observedSamples: SampleName[];
  /** observedCount === totalCalls (present on every member call). */
  observedAlways: boolean;
  /**
   * Did the param's VALUE differ across member calls?
   * true = differing values seen, false = identical value every time,
   * 'unknown' = only seen once OR body param (request body values aren't captured).
   */
  observedVariation: true | false | 'unknown';
  /** distinct runtime value kinds observed (e.g. 'string','number'); body → []. */
  valueKinds: string[];
  /** name matches DYNAMIC_PARAM_RE (timestamp/nonce/sign/token/…). FACT, not a verdict. */
  dynamicLike: boolean;
  /**
   * name matches SIGNED_PARAM_RE (sign/signature/nonce/csrf/token/w_rid/x-bogus/…).
   * REFINES dynamicLike: a signature/auth/anti-bot param. FACT, not a verdict — be's
   * scorer applies the (penalizing) judgement in a later step. Signed wins over
   * cacheBuster on the (by-design impossible) overlap.
   */
  signedLike: boolean;
  /**
   * name matches CACHE_BUSTER_PARAM_RE (_t/ts/timestamp/cb/rand/…).
   * REFINES dynamicLike: a read-endpoint cache-buster param (harmless). FACT, not a
   * verdict. A dynamicLike param that is NEITHER signedLike NOR cacheBusterLike (e.g.
   * uuid/web_id/device_id) is the "unknown dynamic" class → both refinement flags false.
   */
  cacheBusterLike: boolean;
  /** name matches CURSOR_PARAM_RE (cursor/offset/page_token/…). FACT, not a verdict. */
  cursorLike: boolean;
}

/**
 * A SEMANTIC judgement about one request param, inferred by the LLM layer ON TOP OF the
 * recorder-core ParamObservation facts. This is the LLM half of param analysis: paramRole /
 * exposeAsArg / inferredMeaning are interpretations, not observations.
 *
 * 🔴 Architecture invariant (14-candidate-aggregation-scoring-plan.md · "核心架构原则"):
 * recorder-core never emits these — they originate in dashboard-be/src/llm/score.ts
 * (ScoredCandidate.paramUnion) and are merged onto the wire RankCandidate by be's /recorder/rank.
 * Shape mirrors PROMPT_A's `paramUnion` output and the ScoredCandidate parser in score.ts.
 *
 * Mirrors bundle $def ParamUnionItem.
 */
export interface ParamUnionItem {
  name: string;
  in: 'query' | 'body' | 'path' | 'header';
  /** LLM verdict on whether the param is always present vs optional. */
  requiredness?: 'always' | 'optional';
  /** echoed from the core ParamObservation fact the LLM reasoned over. */
  observedVariation?: boolean;
  /** pagination | dynamic | infrastructure_constant | query_dimension | seed_argument | auth_session | unknown_constant. */
  paramRole?: string;
  /** whether to surface this param as a generated command arg. */
  exposeAsArg?: 'yes' | 'optional_candidate' | 'no';
  /** one-line plain-language meaning of the param (for the user). */
  inferredMeaning?: string;
  /** LLM rationale for the role/expose verdict. */
  why?: string;
}

export interface RankCandidate {
  id: string;
  endpoint: EndpointDescriptor;
  score: number;
  confidence: Confidence;
  reviewRequired: boolean;
  args?: ArgMapping[];
  excludedParams?: string[];
  responseShape?: ResponseShape;
  columns?: ColumnDescriptor[];
  scoreExplanation?: ScoreExplanationItem[];
  risks?: string[];
  evidenceIds?: string[];
  /**
   * Endpoint-aggregation facts (14-plan · 第1步). OPTIONAL + additive — older candidates
   * and the LLM-off path may omit them. Mirror new bundle $defs (paramObservations /
   * responseShapeVariants / mergedRequestIds); bundle sync happens in a later step, not now.
   */
  /** union of observed request params across all member calls of this endpoint group (FACTS ONLY). */
  paramObservations?: ParamObservation[];
  /** distinct response bodyShape.kind seen across member calls (e.g. ['array','object']). */
  responseShapeVariants?: ResponseKind[];
  /** requestIds of every member entry aggregated into this candidate. */
  mergedRequestIds?: string[];
  /**
   * LLM semantic layer (14-plan · 第2/5步), merged onto the wire by be's /recorder/rank.
   * OPTIONAL + additive — the LLM-off path leaves both undefined. recorder-core itself never
   * sets these (they come from dashboard-be ScoredCandidate). Mirror new bundle fields.
   */
  /** one-line "what this endpoint does / returns" sentence for the user. */
  inferredFunction?: string;
  /** per-param semantic roles + expose-as-arg verdicts (on top of paramObservations facts). */
  paramUnion?: ParamUnionItem[];
}

// ── Engine I/O ──

export interface RankInput {
  sessionId: string;
  samples: CaptureSample[];
}

/** Engine result: either ranked candidates, or an explicit error code (never silent empty). */
export type RankResult =
  | { ok: true; candidates: RankCandidate[] }
  | { ok: false; errorCode: 'insufficient_samples'; reason: string };

// ── ScoringProfile (09-config-observability.md · 06 default table) ──
// The ranker reads ALL score values from a validated profile, never inline (06/09).
// Hard rejects are domain invariants and override the profile — not part of it.

export interface ScoringProfile {
  RANK_SCORE_STABLE_JSON_SHAPE_DELTA: number;
  RANK_SCORE_SEED_ARG_PARAM_DELTA: number;
  RANK_SCORE_RESPONSE_ECHO_DELTA: number;
  RANK_SCORE_REQUIRES_SESSION_DELTA: number;
  RANK_SCORE_DYNAMIC_FIELD_DELTA: number;
  RANK_SCORE_HTML_STATIC_ANALYTICS_DELTA: number;
  RANK_SCORE_SUSPECTED_MUTATION_DELTA: number;
  RANK_SCORE_HIGH_MIN: number;
  RANK_SCORE_MEDIUM_MIN: number;
  RANK_SCORE_LOW_MIN: number;
}

export const DEFAULT_SCORING_PROFILE: ScoringProfile = {
  // 14-plan 校准(2026-06-30):stable 25→30(稳定 JSON 列表是最强的读数据信号,提权)。
  RANK_SCORE_STABLE_JSON_SHAPE_DELTA: 30,
  RANK_SCORE_SEED_ARG_PARAM_DELTA: 20,
  RANK_SCORE_RESPONSE_ECHO_DELTA: 10,
  RANK_SCORE_REQUIRES_SESSION_DELTA: 5,
  // 14-plan 校准:旧 -10 平惩罚**任何** dynamicLike 参数(误伤读接口的 _t/uuid 缓存破坏)。现置 0——
  //   真正的动态惩罚移到 be 侧按 ParamObservation 事实分级(signed -15 / unknown -5 / cacheBuster 0,
  //   见 dashboard-be/src/llm/score.ts computeDynamicPenalty)。core 纯规则路径无参数事实分级能力,故不惩罚。
  RANK_SCORE_DYNAMIC_FIELD_DELTA: 0,
  RANK_SCORE_HTML_STATIC_ANALYTICS_DELTA: -25,
  RANK_SCORE_SUSPECTED_MUTATION_DELTA: -100,
  // 14-plan · 第4步:阈值下调让 high 可达。旧 75/50/20 下 core 纯规则正分上限 60 < 75,high 数学不可达。
  // 现 high=70:**双轨**可达——be 侧 deterministicRuleScore(规则正分上限 stable30+seed20+echo10+session5=65)
  //   + semanticBonus(LLM 语义层,cap 40)≥ 70(见 dashboard-be/src/llm/score.ts SEMANTIC_BONUS_TABLE)。
  // 注:纯 core LLM-off 路径仍只有规则分(上限 65),high 对它仍不可达——这是 Codex High 5 ② 的取舍
  //   (语义富集只经 LLM 双轨,不放进 core profile),core 的实际可达上限是 medium。
  RANK_SCORE_HIGH_MIN: 70,
  RANK_SCORE_MEDIUM_MIN: 45,
  RANK_SCORE_LOW_MIN: 20,
};

const DELTA_KEYS: Array<keyof ScoringProfile> = [
  'RANK_SCORE_STABLE_JSON_SHAPE_DELTA', 'RANK_SCORE_SEED_ARG_PARAM_DELTA',
  'RANK_SCORE_RESPONSE_ECHO_DELTA', 'RANK_SCORE_REQUIRES_SESSION_DELTA',
  'RANK_SCORE_DYNAMIC_FIELD_DELTA', 'RANK_SCORE_HTML_STATIC_ANALYTICS_DELTA',
  'RANK_SCORE_SUSPECTED_MUTATION_DELTA',
];
const BAND_KEYS: Array<keyof ScoringProfile> = [
  'RANK_SCORE_HIGH_MIN', 'RANK_SCORE_MEDIUM_MIN', 'RANK_SCORE_LOW_MIN',
];

/**
 * Validate a ScoringProfile per 09: deltas int -1000..1000; bands int 0..1000 with
 * HIGH > MEDIUM > LOW. Returns null when valid, else a config_invalid reason string.
 */
export function validateScoringProfile(p: ScoringProfile): string | null {
  for (const k of DELTA_KEYS) {
    const v = p[k];
    if (!Number.isInteger(v) || v < -1000 || v > 1000) return `${k}=${v} out of range (int -1000..1000)`;
  }
  for (const k of BAND_KEYS) {
    const v = p[k];
    if (!Number.isInteger(v) || v < 0 || v > 1000) return `${k}=${v} out of range (int 0..1000)`;
  }
  if (!(p.RANK_SCORE_HIGH_MIN > p.RANK_SCORE_MEDIUM_MIN && p.RANK_SCORE_MEDIUM_MIN > p.RANK_SCORE_LOW_MIN)) {
    return 'bands must satisfy HIGH_MIN > MEDIUM_MIN > LOW_MIN';
  }
  return null;
}
