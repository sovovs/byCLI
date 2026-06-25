/**
 * Pure config resolvers (M8a · 09-config-observability.md).
 *
 * Same pattern as `validateRunnerConfig`: take a raw partial (env strings, INJECTED — never
 * `process.env` here, so this stays pure-domain and unit-testable) and produce a validated config
 * object, or `config_invalid` with a reason. The process layer (be / daemon) reads env and calls
 * these. Single source of truth for the ScoringProfile + FeatureFlags schemas (09 forbids inline
 * constants and direct `process.env` reads in business code).
 */
import { type ScoringProfile, DEFAULT_SCORING_PROFILE, validateScoringProfile } from './types.js';

export type ConfigResolveError = { ok: false; errorCode: 'config_invalid'; reason: string };

const PROFILE_KEYS = Object.keys(DEFAULT_SCORING_PROFILE) as (keyof ScoringProfile)[];

/**
 * Resolve a ScoringProfile from raw `RANK_SCORE_*` env strings: missing/empty → default, else
 * parsed + range/band-order validated (09). The env key names ARE the ScoringProfile field names.
 */
export function resolveScoringProfile(
  raw: Partial<Record<keyof ScoringProfile, string | undefined>>,
): { ok: true; profile: ScoringProfile } | ConfigResolveError {
  const p: ScoringProfile = { ...DEFAULT_SCORING_PROFILE };
  for (const k of PROFILE_KEYS) {
    const v = raw[k];
    if (v === undefined || v === '') continue; // default
    const n = Number(v);
    if (!Number.isInteger(n)) return { ok: false, errorCode: 'config_invalid', reason: `${k}=${JSON.stringify(v)} must be an integer` };
    p[k] = n;
  }
  const err = validateScoringProfile(p);
  if (err) return { ok: false, errorCode: 'config_invalid', reason: err };
  return { ok: true, profile: p };
}

// ── Feature flags (09 · local config flags, schema-validated, default fail-closed) ──────────────

export interface FeatureFlags {
  /** restart-only — exposes a new capture surface */
  FEATURE_DIRECT_CDP_CAPTURE: boolean;
  /** restart-only — changes the endpoint surface (localhost HTTP UI) */
  FEATURE_LOCALHOST_HTTP_UI: boolean;
  /** restart-only — exposes a new local admin endpoint */
  FEATURE_ADMIN_LOG_LEVEL_TOGGLE: boolean;
  /** hot — gates whether a candidate/preview ScoringProfile may be applied (default profile is always externalized) */
  FEATURE_PREVIEW_SCORING_PROFILE: boolean;
  /** hot — new sessions / rank jobs only */
  RELEASE_CHANNEL: 'stable' | 'preview';
  /** hot — new sessions / rank jobs only */
  LOCAL_EXPERIMENT_PROFILE: 'off' | 'control' | 'candidate';
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  FEATURE_DIRECT_CDP_CAPTURE: false,
  FEATURE_LOCALHOST_HTTP_UI: false,
  FEATURE_ADMIN_LOG_LEVEL_TOGGLE: false,
  FEATURE_PREVIEW_SCORING_PROFILE: false,
  RELEASE_CHANNEL: 'stable',
  LOCAL_EXPERIMENT_PROFILE: 'off',
};

const BOOL_FLAG_KEYS = [
  'FEATURE_DIRECT_CDP_CAPTURE', 'FEATURE_LOCALHOST_HTTP_UI',
  'FEATURE_ADMIN_LOG_LEVEL_TOGGLE', 'FEATURE_PREVIEW_SCORING_PROFILE',
] as const;
const RELEASE_CHANNELS = ['stable', 'preview'] as const;
const EXPERIMENT_PROFILES = ['off', 'control', 'candidate'] as const;

/** Parse a strict boolean flag: true/1 → true, false/0 → false, missing/empty → default, else invalid. */
function parseBool(v: string | undefined, def: boolean): boolean | null {
  if (v === undefined || v === '') return def;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return null;
}

/** Resolve FeatureFlags from raw env strings; default fail-closed, any malformed value → config_invalid. */
export function resolveFeatureFlags(
  raw: Partial<Record<keyof FeatureFlags, string | undefined>>,
): { ok: true; flags: FeatureFlags } | ConfigResolveError {
  const flags: FeatureFlags = { ...DEFAULT_FEATURE_FLAGS };
  for (const k of BOOL_FLAG_KEYS) {
    const b = parseBool(raw[k], DEFAULT_FEATURE_FLAGS[k]);
    if (b === null) return { ok: false, errorCode: 'config_invalid', reason: `${k}=${JSON.stringify(raw[k])} must be a boolean (true/false/1/0)` };
    flags[k] = b;
  }
  const rc = raw.RELEASE_CHANNEL;
  if (rc !== undefined && rc !== '') {
    if (!(RELEASE_CHANNELS as readonly string[]).includes(rc)) return { ok: false, errorCode: 'config_invalid', reason: `RELEASE_CHANNEL=${JSON.stringify(rc)} must be one of ${RELEASE_CHANNELS.join('|')}` };
    flags.RELEASE_CHANNEL = rc as FeatureFlags['RELEASE_CHANNEL'];
  }
  const ep = raw.LOCAL_EXPERIMENT_PROFILE;
  if (ep !== undefined && ep !== '') {
    if (!(EXPERIMENT_PROFILES as readonly string[]).includes(ep)) return { ok: false, errorCode: 'config_invalid', reason: `LOCAL_EXPERIMENT_PROFILE=${JSON.stringify(ep)} must be one of ${EXPERIMENT_PROFILES.join('|')}` };
    flags.LOCAL_EXPERIMENT_PROFILE = ep as FeatureFlags['LOCAL_EXPERIMENT_PROFILE'];
  }
  return { ok: true, flags };
}
