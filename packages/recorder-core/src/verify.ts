/**
 * Verify — PURE pieces (M5c).
 *
 * Deterministic, no IO, no child process: seed-arg evidence derivation (session-keyed
 * HMAC), runner JSONL event parsing, and runner-result normalization to a summary-only
 * shape. The actual child-process runner (spawn, JSONL transport, env isolation,
 * input.json 0600/0700, timeout, reap) is M6 (08) — it lives main-repo side, not here.
 *
 * SECURITY (07:123-124, 167): raw executionSeedArgs never leave memory/input.json.
 * deriveEvidenceSeedArgs turns each raw value into display-only evidence (placeholder +
 * type + session-keyed HMAC + length); the raw value is never echoed into the evidence,
 * report, status, or logs.
 */

import { createHmac } from 'node:crypto';

// ── Seed-arg evidence (HMAC-derived, display-only) ──────────────────────────

export interface SeedArgEvidence {
  placeholder: string;
  type: string;
  hmac: string;
  length: number;
  hmacScope: 'recorder_session';
  comparableAcrossRuns: false;
  usage: 'display_only';
}

/**
 * Derive display-only evidence from raw execution seed args. `sessionHmacKey` is the
 * per-session secret (caller-injected, keeping this pure). The raw value is HMAC'd and
 * never stored — only placeholder/type/hmac/length are returned.
 */
export function deriveEvidenceSeedArgs(
  raw: Record<string, unknown>,
  sessionHmacKey: string,
): Record<string, SeedArgEvidence> {
  const out: Record<string, SeedArgEvidence> = {};
  let i = 0;
  for (const [name, value] of Object.entries(raw)) {
    i += 1;
    const str = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    out[name] = {
      placeholder: `${name}_${i}`,
      type: typeof value,
      hmac: createHmac('sha256', sessionHmacKey).update(str).digest('hex').slice(0, 32),
      length: str.length,
      hmacScope: 'recorder_session',
      comparableAcrossRuns: false,
      usage: 'display_only',
    };
  }
  return out;
}

// ── Runner JSONL events (mirror of bundle $defs; M6 runner emits these) ─────

export interface RunnerStartedEvent { type: 'started'; requestId: string; pid?: number; stage?: string; }
export interface RunnerProgressEvent { type: 'progress'; requestId: string; stage?: string; message?: string; }
export interface RunnerResultEvent {
  type: 'result';
  requestId: string;
  ok: boolean;
  data?: {
    stage?: 'fixture' | 'load' | 'execute' | 'validate';
    rows?: number;
    // field COUNT only, never the key names — a key could be a seed value if the adapter keys its
    // output rows on one (Codex M7c audit). The names never leave the child.
    fieldCount?: number;
    fixture?: { status: 'matched' | 'updated' | 'ignored' };
    trace?: { policy?: string; retained: boolean; path?: string | null };
  };
  error?: { code: string; message: string; hint?: string } | null;
}
export type RunnerEvent = RunnerStartedEvent | RunnerProgressEvent | RunnerResultEvent;

export type ParseEventResult =
  | { ok: true; event: RunnerEvent }
  | { ok: false; errorCode: 'runner_protocol_error'; reason: string };

/**
 * Parse one runner JSONL line into a RunnerEvent. Malformed JSON, oversize line, a
 * requestId mismatch, or an unknown type → runner_protocol_error (08:67). Caller tracks
 * duplicate `result` across lines (also runner_protocol_error).
 */
export function parseRunnerEvent(
  line: string,
  expectedRequestId: string,
  maxLineLength: number,
): ParseEventResult {
  if (line.length > maxLineLength) {
    return { ok: false, errorCode: 'runner_protocol_error', reason: `line exceeds ${maxLineLength} bytes` };
  }
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(line) as Record<string, unknown>; }
  catch { return { ok: false, errorCode: 'runner_protocol_error', reason: 'malformed JSON' }; }

  if (obj.requestId !== expectedRequestId) {
    return { ok: false, errorCode: 'runner_protocol_error', reason: 'requestId mismatch' };
  }
  if (obj.type !== 'started' && obj.type !== 'progress' && obj.type !== 'result') {
    // Do NOT echo obj.type: it is attacker-controlled if a forged event reaches the protocol fd, and
    // this reason becomes a runner_protocol_error message surfaced in the summary (Codex M7c audit).
    return { ok: false, errorCode: 'runner_protocol_error', reason: 'unknown event type' };
  }
  return { ok: true, event: obj as unknown as RunnerEvent };
}

// ── Result normalization (summary-only; never raw stdout/seed/trace bytes) ──

export interface VerifySummary {
  ok: boolean;
  stage?: string;
  rows?: number;
  /** Field count of the produced rows — NOT the key names (a key could be a seed value; Codex M7c). */
  fieldCount?: number;
  fixture?: { status: string };
  trace?: { retained: boolean };
  error?: { code: string; message: string; hint?: string };
}

/**
 * Fixed text that replaces an adapter-thrown error's message in the user-facing summary. An error
 * raised at the `execute` stage comes from the adapter's own `throw`, whose message can interpolate
 * raw seed-arg values (M7c outer redaction gate · Codex #2). We keep the structured `code` (so the
 * caller still learns the adapter errored) but withhold the raw text; precise details stay in the
 * isolated diagnostics channel (the runner's inner redaction layer). Non-execute errors
 * (load / fixture / validate) are runner-generated and pass through verbatim for debuggability.
 */
export const REDACTED_ADAPTER_ERROR_MESSAGE =
  'adapter raised an error during execution (message withheld to avoid leaking seed values)';

/**
 * Error codes an adapter may legitimately surface at the `execute` stage. An adapter can set `e.code`
 * to ANY string (the runner copies it verbatim), so an arbitrary code is adapter-controlled free text
 * that could echo a seed value — anything outside this allowlist is collapsed to adapter_runtime_error
 * so the structured `code` field can never leak a secret (Codex M7c audit).
 */
export const EXECUTE_SAFE_ERROR_CODES: ReadonlySet<string> = new Set(['auth_required']);

/** Normalize a terminal RunnerResultEvent into a summary-only shape (07:138). */
export function normalizeRunnerResult(ev: RunnerResultEvent): VerifySummary {
  const s: VerifySummary = { ok: ev.ok };
  const d = ev.data;
  if (d) {
    if (d.stage) s.stage = d.stage;
    if (typeof d.rows === 'number') s.rows = d.rows;
    if (typeof d.fieldCount === 'number') s.fieldCount = d.fieldCount;
    if (d.fixture) s.fixture = { status: d.fixture.status };
    // trace: only the retained flag, never the path/bytes.
    if (d.trace) s.trace = { retained: d.trace.retained };
  }
  if (ev.error) {
    // At the `execute` stage BOTH message and hint are adapter-controlled (the adapter's thrown
    // Error) and may echo raw seed values — redact regardless of the code (an adapter can set a known
    // code too), and withhold the hint entirely (defense-in-depth: even if a future error path
    // populates an execute-stage hint, it can never surface a seed). Other stages are runner-generated,
    // so their message + hint are safe to surface verbatim for debuggability.
    const adapterControlled = ev.data?.stage === 'execute';
    s.error = adapterControlled
      ? {
          // `code` is adapter-controlled too — only surface it if it is a known-safe code, else
          // collapse to adapter_runtime_error so a seed-valued code cannot leak (Codex M7c audit).
          code: EXECUTE_SAFE_ERROR_CODES.has(ev.error.code) ? ev.error.code : 'adapter_runtime_error',
          message: REDACTED_ADAPTER_ERROR_MESSAGE,
        }
      : { code: ev.error.code, message: ev.error.message, hint: ev.error.hint };
  }
  return s;
}

// ── Runner config (M6, 09 HighLevelConfig table) ────────────────────────────

/**
 * Validated verify-runner config. Bounds mirror 09-config-observability.md. The runner
 * port (main-repo, M6) builds this from env; keeping the validation here keeps it pure
 * and unit-testable (no process.env access).
 */
export interface RunnerConfig {
  maxConcurrency: number;
  /** Max queued (not-yet-launched) verifies once maxConcurrency is saturated; over this →
   * queue_full (09 HIGH_LEVEL_QUEUE_LIMIT). 0 = no queue (saturated → immediate queue_full). */
  queueLimit: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
  jsonlLineLimit: number;
  timeoutMs: number;
  killGraceMs: number;
}

export type RunnerConfigResult =
  | { ok: true; config: RunnerConfig }
  | { ok: false; errorCode: 'config_invalid'; reason: string };

/** One config field spec: env key, default, inclusive [min,max]. */
interface FieldSpec { key: keyof RunnerConfig; def: number; min: number; max: number; }

const RUNNER_FIELDS: readonly FieldSpec[] = [
  { key: 'maxConcurrency', def: 2, min: 1, max: 1024 },
  { key: 'queueLimit', def: 10, min: 0, max: 1000 }, // 09 HIGH_LEVEL_QUEUE_LIMIT
  { key: 'stdoutLimitBytes', def: 1_048_576, min: 1024, max: 16_777_216 },
  { key: 'stderrLimitBytes', def: 65_536, min: 1024, max: 1_048_576 },
  { key: 'jsonlLineLimit', def: 65_536, min: 1024, max: 1_048_576 },
  { key: 'timeoutMs', def: 30_000, min: 1000, max: 600_000 },
  { key: 'killGraceMs', def: 1500, min: 100, max: 30_000 },
];

/**
 * Validate a partial raw config (each value a string from env or undefined). Missing/empty
 * → default; out of range / non-integer → config_invalid (09). `maxConcurrency` upper bound
 * is clamped to CPU count by the caller (env-side); here we only enforce the static range.
 */
export function validateRunnerConfig(
  raw: Partial<Record<keyof RunnerConfig, string | undefined>>,
): RunnerConfigResult {
  const out = {} as RunnerConfig;
  for (const { key, def, min, max } of RUNNER_FIELDS) {
    const v = raw[key];
    if (v === undefined || v === '') { out[key] = def; continue; }
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      return { ok: false, errorCode: 'config_invalid', reason: `${key}: must be integer in [${min}, ${max}], got ${JSON.stringify(v)}` };
    }
    out[key] = n;
  }
  return { ok: true, config: out };
}

// ── Runner process args (no shell string; 08 launch rule) ───────────────────

/**
 * Build the argv for `bycli internal verify-runner --jsonl` (08). Pure: requestId + name +
 * inputPath → a flat args array, no shell interpolation. The caller spawns with this array.
 *
 * `protocolFd` (Codex #3) selects the dedicated file descriptor the child writes the JSONL
 * protocol to, keeping it off the adapter's stdout/stderr so user `console.log` can never pollute
 * or forge the protocol stream. Omitted → the child falls back to stdout (standalone debugging).
 *
 * `maxRuntimeMs` (Codex #7) is the child's self-watchdog deadline: if the parent dies (orphan) and
 * cannot SIGKILL the child — e.g. on win32 the reaper has no portable cmdline guard — the child
 * force-exits itself after this many ms so a leaked runner never runs forever. The parent sets it
 * above its own timeout so it only fires when orphaned. Omitted → no self-watchdog (standalone).
 */
export function buildRunnerArgs(input: { requestId: string; name: string; inputPath: string; protocolFd?: number; maxRuntimeMs?: number }): string[] {
  const args = [
    'internal', 'verify-runner', '--jsonl',
    '--request-id', input.requestId,
    '--name', input.name,
    '--input', input.inputPath,
  ];
  if (input.protocolFd !== undefined) args.push('--protocol-fd', String(input.protocolFd));
  if (input.maxRuntimeMs !== undefined) args.push('--max-runtime-ms', String(input.maxRuntimeMs));
  return args;
}
