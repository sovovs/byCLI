/**
 * Scoring (06-recorder-core-engine.md · "Scoring" + 09 ScoringProfile).
 *
 * The ranker reads ALL score values from the injected ScoringProfile — never inline
 * (06/09). Hard rejects (mutation / confirmed analytics / unparseable URL / missing
 * method / confirmed static / pairing-failed-without-shape) are domain invariants that
 * OVERRIDE the profile and force `rejected`, independent of the numeric score.
 *
 * Produces a stable scoreExplanation[] whose `signal` keys are stable for UI i18n.
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
  if (ANALYTICS_HOST_RE.test(host)) hardReject = 'confirmed_analytics';
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
