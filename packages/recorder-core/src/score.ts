/**
 * Scoring (06-recorder-core-engine.md · "Scoring" + 09 ScoringProfile).
 *
 * The ranker reads ALL score values from the injected ScoringProfile — never inline
 * (06/09). Hard rejects (mutation / confirmed analytics / unparseable URL / missing
 * method / confirmed static / pairing-failed-without-shape) are domain invariants that
 * OVERRIDE the profile and force `rejected`, independent of the numeric score.
 *
 * Produces a stable scoreExplanation[] whose `signal` keys are stable for UI i18n.
 *
 * 14-plan · 第4步 reachability note: the default bands are now 70/45/20 (was 75/50/20).
 * This pure-core path computes ONLY the deterministic rule deltas (positive cap
 * stable30+seed20+echo10+session5 = 65), so on its own `high` (≥70) remains unreachable
 * and `medium` (≥45) is the realistic top band. `high` becomes reachable only via the
 * BE dual-track path (dashboard-be/src/llm/score.ts): deterministicRuleScore + the
 * LLM-judged semanticBonus (cap 40) → up to 105. Semantic richness lives in the BE-internal
 * SEMANTIC_BONUS_TABLE, NOT this profile (Codex High 5 ②: core can't compute semantics, so
 * adding them to the profile would be config that core never reads).
 *
 * The `dynamic_field` delta is now 0 in DEFAULT_SCORING_PROFILE (14-plan 校准): the flat -10
 * over-penalized read-endpoint cache-busters (_t/uuid). The graded dynamic penalty (signed -15 /
 * unknown -5 / cacheBuster 0) is applied in be from ParamObservation facts, which core lacks here.
 */

import type {
  ScoringProfile, ScoreExplanationItem, Confidence, RecorderNetworkEntry,
} from './types.js';
import type { NormalizedEntry } from './normalize.js';

export type HardReject =
  | 'mutation'
  | 'confirmed_analytics'
  | 'unparseable_url'
  | 'missing_method'
  | 'confirmed_static'
  | 'pairing_failed_no_shape';

export interface ScoreResult {
  score: number;
  confidence: Confidence;
  scoreExplanation: ScoreExplanationItem[];
  risks: string[];
  hardReject?: HardReject;
}

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Confirmed third-party analytics/tracking hosts (hard reject, not the weak -25 delta).
const ANALYTICS_HOST_RE = /(google-analytics|googletagmanager|doubleclick|segment\.io|mixpanel|sentry\.io|hotjar|facebook\.com\/tr|stats\.|analytics\.|track(ing)?\.)/i;
// Path-based analytics/telemetry (host looks first-party but the path is埋点/监控 —— e.g. ByteDance
// Slardar `/monitor_web/`, `/slardar/`, RUM/beacon endpoints). Matched against pathname.
// 保守:只列**埋点专名段**(不会是数据接口的词);锚定路径段(前 `/`、后 `/`|$|`?`)。
// 刻意**不含** collect/report/log 等通用词 —— `/api/collect/items`(收藏)、`/report/list`(报表)、
// `/log/list`(日志列表)都是真数据接口,含这些词会误杀。core hardReject 是一票否决,从严宁漏勿杀。
const ANALYTICS_PATH_RE = /\/(monitor_web|slardar|rgpv|sdk-log|apmplus|track_event|log_report|web_report|__log|sensorsdata|log-report)(\/|$|\?)/i;

export interface ScoreContext {
  entry: RecorderNetworkEntry;
  normalized: NormalizedEntry;
  /** paired A/B proves a read endpoint; single-sample cannot disprove mutation. */
  paired: boolean;
  /** a query/body param matched a seed arg (proves seed→param). */
  seedArgMapped: boolean;
  /** response weakly echoes a seed arg value. */
  responseEchoesSeed: boolean;
}

function bandFor(score: number, hardReject: HardReject | undefined, p: ScoringProfile): Confidence {
  if (hardReject) return 'rejected';
  if (score < p.RANK_SCORE_LOW_MIN) return 'rejected';
  if (score >= p.RANK_SCORE_HIGH_MIN) return 'high';
  if (score >= p.RANK_SCORE_MEDIUM_MIN) return 'medium';
  return 'low';
}

export function scoreCandidate(ctx: ScoreContext, profile: ScoringProfile): ScoreResult {
  const { entry, normalized, seedArgMapped, responseEchoesSeed } = ctx;
  const explanation: ScoreExplanationItem[] = [];
  const risks: string[] = [];
  let score = 0;
  const add = (signal: string, delta: number, detail?: string) => {
    if (delta === 0) return;
    score += delta;
    explanation.push(detail ? { signal, delta, detail } : { signal, delta });
  };

  // ── hard rejects (override profile) ──
  let hardReject: HardReject | undefined;
  const host = entry.host ?? '';
  const respKind = entry.response?.bodyShape?.kind;
  if (ANALYTICS_HOST_RE.test(host) || ANALYTICS_PATH_RE.test(entry.pathname ?? '')) hardReject = 'confirmed_analytics';
  else if (normalized.signals.suspectedStatic && /\.(js|css|png|jpg|svg|woff2?|ico)(\?|$)/i.test(entry.pathname ?? '')) {
    hardReject = 'confirmed_static';
  } else if (MUTATION_METHODS.has(entry.method) && respKind !== 'array') {
    // Write-method without a stable read-list (array) response → suspected mutation
    // (hard reject). A write that returns a JSON array is treated as a read query
    // (e.g. search-post-json-read); an object ack like {ok:true} is a mutation.
    hardReject = 'mutation';
  }

  // ── profile-driven deltas ──
  if (respKind === 'array' || respKind === 'object') {
    add('stable_json_shape', profile.RANK_SCORE_STABLE_JSON_SHAPE_DELTA, 'response has stable JSON list/object shape');
  }
  if (seedArgMapped) {
    add('seed_arg_maps_to_param', profile.RANK_SCORE_SEED_ARG_PARAM_DELTA, 'seed arg maps to query/body param');
  }
  if (responseEchoesSeed) {
    add('response_echoes_seed', profile.RANK_SCORE_RESPONSE_ECHO_DELTA, 'response weakly echoes seed arg');
  }
  if (normalized.signals.requiresSession) {
    add('requires_session', profile.RANK_SCORE_REQUIRES_SESSION_DELTA, 'requires cookie/session');
  }
  if (normalized.signals.hasDynamicFields) {
    add('dynamic_field', profile.RANK_SCORE_DYNAMIC_FIELD_DELTA, 'timestamp/nonce/sign present');
    risks.push('unexplained_dynamic_or_sign_param');
  }
  if (normalized.signals.suspectedStatic && !hardReject) {
    add('weak_html_static', profile.RANK_SCORE_HTML_STATIC_ANALYTICS_DELTA, 'weak HTML/static-like signal (suspected)');
  }
  if (hardReject === 'mutation') {
    add('suspected_mutation', profile.RANK_SCORE_SUSPECTED_MUTATION_DELTA, 'mutation-like write with no read shape');
  }

  if (normalized.signals.authRequired) risks.push('auth_or_login_required');
  if (normalized.signals.antiBotSignal) risks.push('anti_bot_signal');

  const confidence = bandFor(score, hardReject, profile);
  return { score, confidence, scoreExplanation: explanation, risks, hardReject };
}
