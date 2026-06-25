/**
 * Verify-runner config — read VERIFY_RUNNER_* from the environment (09 HighLevelConfig).
 *
 * The static range validation is the pure `validateRunnerConfig` in recorder-core (no
 * process.env access, unit-tested there). This thin wrapper reads the env keys and applies
 * the one env-side rule the pure layer can't: clamp `maxConcurrency` to the CPU count
 * (09: "int, 1-CPU count"). A range error is surfaced as a thrown ConfigError (fail closed,
 * 08: unsupported config fails before launch).
 */

import * as os from 'node:os';
import { validateRunnerConfig, validateTempCapacity, type RunnerConfig, type TempCapacity } from '@sovovs/bycli-recorder-core';
import { ConfigError } from '../../errors.js';

const ENV_KEYS: Record<keyof RunnerConfig, string> = {
  maxConcurrency: 'VERIFY_RUNNER_MAX_CONCURRENCY',
  queueLimit: 'HIGH_LEVEL_QUEUE_LIMIT',
  stdoutLimitBytes: 'VERIFY_RUNNER_STDOUT_LIMIT_BYTES',
  stderrLimitBytes: 'VERIFY_RUNNER_STDERR_LIMIT_BYTES',
  jsonlLineLimit: 'VERIFY_RUNNER_JSONL_LINE_LIMIT',
  timeoutMs: 'VERIFY_RUNNER_TIMEOUT_MS',
  killGraceMs: 'VERIFY_RUNNER_KILL_GRACE_MS',
};

/**
 * Resolve the verify-runner config from `env` (defaults to process.env). Missing/empty →
 * default; out-of-range/non-integer → ConfigError. `maxConcurrency` is additionally clamped
 * down to the CPU count (never below 1).
 */
export function resolveRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const raw = {} as Record<keyof RunnerConfig, string | undefined>;
  for (const key of Object.keys(ENV_KEYS) as (keyof RunnerConfig)[]) {
    raw[key] = env[ENV_KEYS[key]];
  }
  const r = validateRunnerConfig(raw);
  if (!r.ok) throw new ConfigError(r.reason, 'Fix the VERIFY_RUNNER_* environment variable and retry.');

  const cpus = Math.max(1, os.cpus().length || 1);
  return { ...r.config, maxConcurrency: Math.min(r.config.maxConcurrency, cpus) };
}

/**
 * Temp-store reap policy (M7b · 09:27-29 RecorderConfig). Read on the daemon side (the process
 * that owns verify temp dirs) to drive startup reap + the periodic TTL sweep.
 */
export interface TempPolicy {
  /** Periodic sweep threshold: a temp dir older than this is a leak (09: default 1h). */
  tempTtlMs: number;
  /** Startup reap age backstop: clean dirs older than this regardless of owner (09: default 24h). */
  startupReapMaxAgeMs: number;
  /** SIGTERM→SIGKILL grace when terminating a reaped child (09: default 1500ms). */
  orphanKillGraceMs: number;
}

interface TempPolicyField { key: string; def: number; min: number; max: number; }
const TEMP_POLICY_FIELDS: Record<keyof TempPolicy, TempPolicyField> = {
  tempTtlMs:           { key: 'RECORDER_TEMP_TTL_MS',             def: 3_600_000,  min: 60_000, max: 86_400_000 },
  startupReapMaxAgeMs: { key: 'RECORDER_STARTUP_REAP_MAX_AGE_MS', def: 86_400_000, min: 60_000, max: 86_400_000 },
  orphanKillGraceMs:   { key: 'RECORDER_ORPHAN_KILL_GRACE_MS',    def: 1_500,      min: 100,    max: 30_000 },
};

/**
 * Temp-store capacity env keys (#1d · 09:33-36). The pure range/band-order validation is
 * `validateTempCapacity` in recorder-core; this maps env key names → field names (mirroring
 * resolveRunnerConfig) and fail-closes via ConfigError. The temp ROOT is restart-only (09:182):
 * these are read at daemon startup, not hot-reloaded.
 */
const TEMP_CAPACITY_ENV_KEYS: Record<keyof TempCapacity, string> = {
  maxBytes: 'RECORDER_TEMP_MAX_BYTES',
  highWatermarkRatio: 'RECORDER_TEMP_HIGH_WATERMARK_RATIO',
  lowWatermarkRatio: 'RECORDER_TEMP_LOW_WATERMARK_RATIO',
};

export function resolveTempCapacity(env: NodeJS.ProcessEnv = process.env): TempCapacity {
  const raw = {} as Record<keyof TempCapacity, string | undefined>;
  for (const k of Object.keys(TEMP_CAPACITY_ENV_KEYS) as (keyof TempCapacity)[]) {
    raw[k] = env[TEMP_CAPACITY_ENV_KEYS[k]];
  }
  const r = validateTempCapacity(raw);
  if (!r.ok) throw new ConfigError(r.reason, 'Fix the RECORDER_TEMP_* environment variable and retry.');
  return r.capacity;
}

/**
 * Resolve the temp-store reap policy from `env` (defaults to process.env). Missing/empty → default;
 * out-of-range / non-integer → ConfigError (fail closed, consistent with resolveRunnerConfig).
 */
export function resolveTempPolicy(env: NodeJS.ProcessEnv = process.env): TempPolicy {
  const out = {} as TempPolicy;
  for (const k of Object.keys(TEMP_POLICY_FIELDS) as (keyof TempPolicy)[]) {
    const f = TEMP_POLICY_FIELDS[k];
    const raw = env[f.key];
    if (raw === undefined || raw === '') { out[k] = f.def; continue; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < f.min || n > f.max) {
      throw new ConfigError(
        `${f.key}=${raw} is out of range [${f.min}, ${f.max}]`,
        `Fix the ${f.key} environment variable and retry.`,
      );
    }
    out[k] = n;
  }
  return out;
}
