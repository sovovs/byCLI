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

/** 产品录制形态(应用层策略,与底层 BindMode 区分):
 *  - tab_projection:扩展拥有的真 tab + 投屏画面进 dashboard + Input 回传(对所有站通用,默认)。
 *  - embedded_iframe:dashboard 嵌跨源目标 iframe + attach dashboard tab 录 iframe 内请求
 *    (仅适用不反嵌的公开站,受 FEATURE_EMBEDDED_IFRAME_RECORDING gate)。
 *  - vnc:浏览器+扩展+daemon 全在 podman 容器内,dashboard 用 noVNC 投容器画面、用户操作容器 Chromium 录制
 *    (be 同机起容器,命令经容器网关反代到容器内 daemon;受 FEATURE_VNC_RECORDING gate)。 */
export type RecordingMode = 'tab_projection' | 'embedded_iframe' | 'vnc';
export const RECORDING_MODES: readonly RecordingMode[] = ['tab_projection', 'embedded_iframe', 'vnc'] as const;
/** 缺省录制形态;契约 recordingMode 缺省即此(向后兼容:老客户端不传 → 投屏)。 */
export const DEFAULT_RECORDING_MODE: RecordingMode = 'tab_projection';

export interface FeatureFlags {
  /**
   * restart-only — RESERVED. Would expose a direct-CDP capture surface, but that capability does
   * not exist yet (capture is hardwired through the daemon network-capture path + interceptor
   * fallback), so there is NO consumer reading this flag. It is schema-validated, restart-only
   * pinned and fail-closed (default false → exposes nothing). Wire a consumer only when the
   * direct-CDP capture surface is actually designed (a feature, not flag wiring; out of M10 scope).
   */
  FEATURE_DIRECT_CDP_CAPTURE: boolean;
  /** restart-only — master switch for the localhost HTTP UI form. Gates dashboard-be same-origin
   *  UI hosting (server.ts createApp staticServer); UI_DIST alone no longer enables it (#5a). */
  FEATURE_LOCALHOST_HTTP_UI: boolean;
  /** restart-only — gates the loopback admin log-level endpoint POST /recorder/admin/log-level
   *  (dashboard-be server.ts; off → endpoint absent / request_not_found) (#5b). */
  FEATURE_ADMIN_LOG_LEVEL_TOGGLE: boolean;
  /** restart-only — gates the embedded-iframe recording mode (dashboard 嵌跨源目标 iframe + attach
   *  dashboard tab,录 iframe 内请求,适用不反嵌的公开站)。off → bind 请求 embedded_iframe 回 feature_disabled,
   *  且 CSP frame-src 不放宽(保持 default-src 'self')。默认 false。投屏模式(tab_projection)不受此 flag 影响。 */
  FEATURE_EMBEDDED_IFRAME_RECORDING: boolean;
  /** restart-only — gates the VNC recording mode (浏览器+扩展+daemon 全在 podman 容器内,dashboard 用
   *  noVNC 投容器画面、用户操作容器 Chromium 录制;be 同机起容器,命令经容器网关反代到容器内 daemon)。
   *  off → bind 请求 vnc 回 feature_disabled。默认 false。tab_projection/embedded_iframe 不受此 flag 影响。 */
  FEATURE_VNC_RECORDING: boolean;
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
  FEATURE_EMBEDDED_IFRAME_RECORDING: false,
  FEATURE_VNC_RECORDING: false,
  FEATURE_PREVIEW_SCORING_PROFILE: false,
  RELEASE_CHANNEL: 'stable',
  LOCAL_EXPERIMENT_PROFILE: 'off',
};

const BOOL_FLAG_KEYS = [
  'FEATURE_DIRECT_CDP_CAPTURE', 'FEATURE_LOCALHOST_HTTP_UI',
  'FEATURE_ADMIN_LOG_LEVEL_TOGGLE', 'FEATURE_EMBEDDED_IFRAME_RECORDING', 'FEATURE_VNC_RECORDING', 'FEATURE_PREVIEW_SCORING_PROFILE',
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

// ── Temp-store capacity (#1d · 09:33-36 RecorderConfig) ───────────────────────────────────────────
// The verify runner writes per-request temp dirs; without a ceiling a runaway / leak could fill the
// disk. These three keys define the cap + watermarks; the runner refuses a new run (temp_store_full)
// rather than write past the high watermark. Pure validation only — the runner does the fs measuring.

export interface TempCapacity {
  /** Hard ceiling for the sum of verify temp dirs (bytes). */
  maxBytes: number;
  /** Refuse / shed above this fraction of maxBytes (the runner gate). */
  highWatermarkRatio: number;
  /** Target to sweep back down to (fraction of maxBytes); must be < high. */
  lowWatermarkRatio: number;
}

export const DEFAULT_TEMP_CAPACITY: TempCapacity = {
  maxBytes: 1_073_741_824, // 1 GiB — verify temp dirs are tiny, so this is a runaway safety net
  highWatermarkRatio: 0.9,
  lowWatermarkRatio: 0.7,
};

interface TempCapacityField { def: number; min: number; max: number; integer: boolean }
const TEMP_CAPACITY_FIELDS: Record<keyof TempCapacity, TempCapacityField> = {
  maxBytes:           { def: DEFAULT_TEMP_CAPACITY.maxBytes,           min: 10_485_760, max: 10_737_418_240, integer: true },  // 10 MiB – 10 GiB
  highWatermarkRatio: { def: DEFAULT_TEMP_CAPACITY.highWatermarkRatio, min: 0.5,        max: 0.95,           integer: false },
  lowWatermarkRatio:  { def: DEFAULT_TEMP_CAPACITY.lowWatermarkRatio,  min: 0.1,        max: 0.9,            integer: false },
};

/**
 * Resolve a TempCapacity from raw env strings (field-name-keyed; the process layer maps env keys →
 * field names, mirroring resolveRunnerConfig). Missing/empty → default; out-of-range/NaN → config_invalid;
 * `low >= high` is a band-order error (mirrors validateScoringProfile's ordering invariant).
 */
export function validateTempCapacity(
  raw: Partial<Record<keyof TempCapacity, string | undefined>>,
): { ok: true; capacity: TempCapacity } | ConfigResolveError {
  const out = { ...DEFAULT_TEMP_CAPACITY };
  for (const k of Object.keys(TEMP_CAPACITY_FIELDS) as (keyof TempCapacity)[]) {
    const f = TEMP_CAPACITY_FIELDS[k];
    const v = raw[k];
    if (v === undefined || v === '') { out[k] = f.def; continue; }
    const n = Number(v);
    if (Number.isNaN(n) || n < f.min || n > f.max || (f.integer && !Number.isInteger(n))) {
      return { ok: false, errorCode: 'config_invalid', reason: `${k}=${JSON.stringify(v)} is out of range [${f.min}, ${f.max}]` };
    }
    out[k] = n;
  }
  if (out.lowWatermarkRatio >= out.highWatermarkRatio) {
    return { ok: false, errorCode: 'config_invalid', reason: `lowWatermarkRatio (${out.lowWatermarkRatio}) must be < highWatermarkRatio (${out.highWatermarkRatio})` };
  }
  return { ok: true, capacity: out };
}
