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
  RANK_SCORE_STABLE_JSON_SHAPE_DELTA: 25,
  RANK_SCORE_SEED_ARG_PARAM_DELTA: 20,
  RANK_SCORE_RESPONSE_ECHO_DELTA: 10,
  RANK_SCORE_REQUIRES_SESSION_DELTA: 5,
  RANK_SCORE_DYNAMIC_FIELD_DELTA: -10,
  RANK_SCORE_HTML_STATIC_ANALYTICS_DELTA: -25,
  RANK_SCORE_SUSPECTED_MUTATION_DELTA: -100,
  RANK_SCORE_HIGH_MIN: 75,
  RANK_SCORE_MEDIUM_MIN: 50,
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
