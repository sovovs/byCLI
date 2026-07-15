/**
 * Real RunnerPort (M6a · 08) — the child-process verify runner mechanism.
 *
 * Replaces M5c's stubRunnerPort. Responsibilities (08 Process Rules):
 *  - create requestId BEFORE launch; async registry of in-flight runs
 *  - write input.json securely: per-request `0700` temp dir (owner/mode/realpath/lstat
 *    checked), exclusive `0600` file; raw seed args live here only, never in status/log
 *  - spawn `bycli internal verify-runner --jsonl …` with an args array (no shell), minimal env
 *  - parse stdout JSONL via the pure parseRunnerEvent; one and only one terminal `result`
 *  - hard timeout → SIGTERM (graceful) → SIGKILL; stdout/stderr byte caps
 *  - cancel is idempotent; temp dir is always cleaned on done/cancel/timeout
 *
 * M6a does NOT implement: startup reap, browser-adapter execution (needs a daemon Page),
 * concurrency-queue refinement — those are M6b/c. Browser adapters report not-yet from the
 * runner itself (see verify-runner-main.ts).
 *
 * SECURITY: `rawSeedArgs` go into input.json (0600) only. getVerifyStatus returns a
 * summary-only VerifySummary (normalizeRunnerResult) — raw values never reach it.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getUserClisDir } from '../../config-paths.js';
import {
  parseRunnerEvent, normalizeRunnerResult, buildRunnerArgs, createMetrics,
  type VerifySummary, type SeedArgEvidence, type RunnerConfig, type Metrics, type TempCapacity,
} from '@sovovs/bycli-recorder-core';
import type { RunnerPort } from '../highlevel/verify.js';
import { createRecorderLogger, type Logger } from '../observability/logger.js';
import { resolveRunnerConfig } from './config.js';

type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled';

interface StartInput {
  name: string;
  requestId?: string;
  evidenceSeedArgs: Record<string, SeedArgEvidence>;
  rawSeedArgs: Record<string, unknown>;
  fixture: string;
  trace: string;
  /** N3:显式 adapter 路径 override(verify 录制器临时草稿用);缺省按 name 派生 ~/.bycli/clis/<site>/<cmd>.js。 */
  adapterPath?: string;
  expectedSourceSha256?: string;
}

interface VerifyRun {
  requestId: string;
  status: RunStatus;
  startedAt: number;
  /** Original start input — retained so a queued run can be launched later. Raw seed args live
   * in memory only until launch() writes input.json (a queued run holds no temp dir / child). */
  input: StartInput;
  child?: ChildProcess;
  tempRoot?: string;
  killTimer?: NodeJS.Timeout;
  /** Post-SIGTERM force-kill timer (timeout path); survives settle, cleared on child exit. */
  graceTimer?: NodeJS.Timeout;
  /** Post-result lingering-child force-kill timer (M6c); cleared on settle or child exit. */
  resultGrace?: NodeJS.Timeout;
  summary: VerifySummary | null;
  settled: Promise<VerifySummary>;
  resolveSettled: (s: VerifySummary) => void;
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** How long a terminal run lingers in `runs` for status reads before GC (Codex M9 review · High):
 * long enough for getRunStatus/whenSettled consumers (incl. the M9 wrapper's background finalize)
 * to read the summary, short enough that the map stays bounded. */
const TERMINAL_RUN_RETENTION_MS = 300_000;
/** Sentinel input swapped in once a run is terminal — drops the retained StartInput (rawSeedArgs +
 * evidence) so no raw seed / run input lingers in memory after settle. */
const MINIMAL_INPUT: StartInput = { name: '', evidenceSeedArgs: {}, rawSeedArgs: {}, fixture: '', trace: '' };

export interface RunnerPortOptions {
  /** Range-validated config (09). Defaults to env (resolveRunnerConfig). */
  config?: RunnerConfig;
  /** What to launch: command + the args placed BEFORE the `internal verify-runner …` argv.
   * Default: this node binary + the main entry, i.e. `node <main.js> internal verify-runner …`.
   * Tests inject a fixture runner script here. */
  launcher?: { command: string; prefixArgs: string[] };
  /** site/command → adapter module path. Default: ~/.bycli/clis/<site>/<command>.js. */
  resolveAdapterPath?: (name: string) => string;
  /** Injectable spawn (tests). Default node:child_process.spawn. */
  spawnImpl?: SpawnFn;
  /** Daemon port handed to the child (BYCLI_DAEMON_PORT) so M6b adapters can reach the Page. */
  daemonPort?: number;
  /** How long a terminal run lingers in `runs` for status reads before GC (default 5min). */
  terminalRetentionMs?: number;
  /** Observability (#1c · 09). The daemon injects its process singletons (shared with GET /metrics)
   *  via setDefaultRunnerObservability; standalone/tests get a throwaway registry + silent logger. */
  metrics?: Metrics;
  logger?: Logger;
  /** Temp-store capacity guard (#1d · 09). When set, the runner measures verify temp usage before
   *  writing a new run and refuses (temp_store_full) past the high watermark. Undefined → no guard
   *  (one-shot CLI verify; only the long-running daemon enforces). */
  tempCapacity?: TempCapacity;
  /** Injectable temp-usage measurement (bytes). Default scans os.tmpdir() bycli-verify-* dirs.
   *  A throw is treated as over-capacity (fail-closed). Tests inject to force pressure without IO. */
  measureTempBytes?: () => number;
  /** Best-effort on-pressure sweep (shed orphan/aged temp dirs before re-measuring). The daemon
   *  passes its reap; default no-op (the periodic daemon sweep is the backstop). */
  sweepTemp?: () => void;
}

/** The default runner port also exposes test/lifecycle helpers beyond the RunnerPort seam. */
export interface RunnerPortWithLifecycle extends RunnerPort {
  /** Resolve when the run reaches a terminal state (test hook / status await). */
  whenSettled(requestId: string): Promise<VerifySummary> | null;
  /** Count of runs currently in the `running` state. */
  activeCount(): number;
  /** Count of runs waiting in the queue (status `queued`, not yet launched). */
  queuedCount(): number;
  /** Status + summary for an in-flight or settled run (daemon GET /v1/requests). null = unknown id. */
  getRunStatus(requestId: string): { status: RunStatus; summary: VerifySummary | null } | null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** dist/src/recorder/runner/runner-port.js → dist/src/main.js (same relative layout in src/). */
const DEFAULT_MAIN_ENTRY = path.resolve(__dirname, '../../main.js');

/** Dedicated protocol fd (Codex #3): the child writes JSONL here, not stdout, so an adapter's
 * console.log / process.stdout.write can never pollute or forge the protocol stream. The child is
 * spawned with stdio `['ignore','ignore','ignore','pipe']` — adapter stdout/stderr go to /dev/null. */
const PROTOCOL_FD = 3;

function defaultResolveAdapterPath(name: string): string {
  const slash = name.indexOf('/');
  const site = slash === -1 ? name : name.slice(0, slash);
  const command = slash === -1 ? name : name.slice(slash + 1);
  return path.join(getUserClisDir(), site, `${command}.js`);
}

/**
 * Create a per-request temp dir + input.json with the 08 security guarantees (POSIX:
 * 0700 dir, owner/mode/realpath/lstat checks, 0600 exclusive file). Returns the real temp
 * root and input path. Raw seed args are written here and nowhere else.
 */
function writeInputJson(requestId: string, payload: Record<string, unknown>): { tempRoot: string; inputPath: string } {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-verify-'));
  fs.chmodSync(tempRoot, 0o700);
  const st = fs.lstatSync(tempRoot);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('verify temp root is not a real directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('verify temp root owner mismatch');
  if (typeof process.getuid === 'function' && (st.mode & 0o777) !== 0o700) throw new Error('verify temp root mode mismatch');

  const realRoot = fs.realpathSync(tempRoot);
  // 08 child marker: cleanup manifest, no seed args / tokens. `ownerPid` is the process that
  // spawned this runner (daemon or CLI) and stands in for 08's localServiceRunId: startup reap
  // only touches runs whose ownerPid is DEAD (true orphans), so a live sibling's in-flight
  // verify is never killed. `pid` (the child) is backfilled by updateMarkerPid after spawn.
  const markerPath = path.join(realRoot, 'marker.json');
  fs.writeFileSync(markerPath, JSON.stringify({ requestId, pid: null, ownerPid: process.pid, startedAt: Date.now(), tempRoot: realRoot, operation: 'verify' }), { mode: 0o600 });

  const inputPath = path.join(realRoot, `${requestId}-input.json`);
  const fd = fs.openSync(inputPath, 'wx', 0o600); // exclusive create, fails if exists
  try { fs.writeSync(fd, JSON.stringify(payload)); } finally { fs.closeSync(fd); }
  return { tempRoot: realRoot, inputPath };
}

function safeCleanup(tempRoot: string): void {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best-effort; startup reap (M6b) is the backstop */ }
}

/** Best-effort byte size of one verify temp dir; per-entry races (a vanished file mid-scan) are skipped. */
function dirSizeBestEffort(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSizeBestEffort(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch { /* entry vanished (race) — skip */ }
  }
  return total;
}

/** Default temp-usage measurement (#1d): sum of all `bycli-verify-*` dirs under os.tmpdir(). The
 * top-level readdir is NOT guarded — an unreadable tmpdir throws, which the caller treats as
 * over-capacity (fail-closed). Per-dir scanning is best-effort (races are normal). */
function defaultMeasureTempBytes(): number {
  const root = os.tmpdir();
  let total = 0;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.startsWith('bycli-verify-')) total += dirSizeBestEffort(path.join(root, e.name));
  }
  return total;
}

/** Backfill the spawned child pid into marker.json (08 startup reap needs the live pid). */
function updateMarkerPid(tempRoot: string, pid: number): void {
  const markerPath = path.join(tempRoot, 'marker.json');
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    marker.pid = pid;
    fs.writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600 });
  } catch { /* marker missing/unreadable — reap falls back to temp deletion only */ }
}

/** Minimal child env (08 isolation): no inherited NODE_OPTIONS, scratch HOME/config/cache,
 * daemon port so the child can reach the daemon `/command` surface (M6b browser adapters).
 * Deliberately omits the user env: no NODE_OPTIONS, no sensitive tokens. The scratch
 * HOME + BYCLI_CONFIG_DIR mean the child cannot read the user's adapters/cookies/config. */
function buildChildEnv(tempRoot: string, daemonPort?: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: tempRoot,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    BYCLI_CONFIG_DIR: tempRoot,
    BYCLI_CACHE_DIR: tempRoot,
  };
  if (daemonPort !== undefined) env.BYCLI_DAEMON_PORT = String(daemonPort);
  return env;
}

export function createRunnerPort(opts: RunnerPortOptions = {}): RunnerPortWithLifecycle {
  const config = opts.config ?? resolveRunnerConfig();
  const launcher = opts.launcher ?? { command: process.execPath, prefixArgs: [DEFAULT_MAIN_ENTRY] };
  const resolveAdapterPath = opts.resolveAdapterPath ?? defaultResolveAdapterPath;
  const spawnImpl: SpawnFn = opts.spawnImpl ?? (nodeSpawn as SpawnFn);
  const terminalRetentionMs = opts.terminalRetentionMs ?? TERMINAL_RUN_RETENTION_MS;
  // #1c observability: default to a throwaway registry + silent logger so standalone/test construction
  // stays zero-config and the existing runner tests don't change. The daemon injects shared instances.
  const metrics = opts.metrics ?? createMetrics();
  const logger = opts.logger ?? createRecorderLogger('error', () => { /* silent */ });
  // #1d temp guard (off unless tempCapacity injected — only the daemon enforces).
  const tempCapacity = opts.tempCapacity;
  const measureTempBytes = opts.measureTempBytes ?? defaultMeasureTempBytes;
  const sweepTemp = opts.sweepTemp ?? (() => { /* no-op; periodic daemon sweep is the backstop */ });
  const runs = new Map<string, VerifyRun>();
  const queue: string[] = []; // requestIds in 'queued' state, FIFO

  const runningCount = (): number => { let n = 0; for (const r of runs.values()) if (r.status === 'running') n++; return n; };

  /** Reach a terminal state exactly once (idempotent). Clears the kill + result-grace timers,
   * cleans temp, resolves, then pulls the next queued run into the freed slot. The grace timer
   * (a pending SIGKILL after a timeout) deliberately survives — it is cleared on child exit. */
  function settle(run: VerifyRun, status: RunStatus, summary: VerifySummary): void {
    if (run.status !== 'running' && run.status !== 'queued') return; // already terminal
    run.status = status;
    run.summary = summary;
    // #1c observability — single terminal choke point: every settle records duration + outcome, plus
    // the 09 named counters (runner timeout / protocol error). errorCode is the bounded ErrorCode enum;
    // never logs raw seed/stdout/stderr/trace (summary is already normalized to summary-only).
    const durationMs = Date.now() - run.startedAt;
    const errorCode = summary.ok ? undefined : summary.error?.code;
    metrics.observe('runner_verify_duration_ms', durationMs);
    metrics.inc('runner_verify_total', { status });
    if (status === 'timeout') metrics.inc('runner_timeout_total');
    if (errorCode === 'runner_protocol_error') metrics.inc('runner_protocol_error_total');
    logger.info('runner.verify', { requestId: run.requestId, status, errorCode, durationMs, queueDepth: queue.length });
    if (run.killTimer) clearTimeout(run.killTimer);
    if (run.resultGrace) clearTimeout(run.resultGrace);
    if (run.tempRoot) safeCleanup(run.tempRoot);
    run.input = MINIMAL_INPUT; // drop retained StartInput (rawSeedArgs/evidence) once terminal — never needed again
    run.resolveSettled(summary);
    // Retain the terminal run briefly so getRunStatus/whenSettled consumers can read the summary,
    // then GC it — the `runs` map otherwise grows unbounded and retains run metadata forever
    // (Codex M9 review · High). Unref'd so it never keeps the process alive.
    setTimeout(() => { runs.delete(run.requestId); }, terminalRetentionMs).unref();
    scheduleNext();
  }

  /** #1d temp-store capacity gate: is there room for another verify temp dir? Over the high watermark
   * → shed orphan/aged dirs (sweepTemp) and re-measure once; still over → temp_store_full. A
   * measurement throw counts as over-capacity (fail-closed — never fill the disk on a bad read). */
  function checkTempCapacity(): { ok: true } | { ok: false; reason: string } {
    if (!tempCapacity) return { ok: true };
    const highBytes = tempCapacity.maxBytes * tempCapacity.highWatermarkRatio;
    let used: number;
    try { used = measureTempBytes(); } catch { metrics.inc('temp_store_full_total'); return { ok: false, reason: 'verify temp usage unmeasurable (fail-closed)' }; }
    if (used <= highBytes) return { ok: true };
    metrics.inc('temp_store_pressure_total');
    try { sweepTemp(); } catch { /* best-effort shed */ }
    let after: number;
    try { after = measureTempBytes(); } catch { metrics.inc('temp_store_full_total'); return { ok: false, reason: 'verify temp usage unmeasurable after sweep (fail-closed)' }; }
    if (after <= highBytes) return { ok: true };
    metrics.inc('temp_store_full_total');
    return { ok: false, reason: `verify temp store over capacity (${after} > ${Math.floor(highBytes)} bytes, high watermark)` };
  }

  /** Launch a queued run: write input.json, spawn the child, wire timers + JSONL handling.
   * A synchronous launch failure (temp/spawn) settles the run rather than throwing — the
   * requestId is already minted, so callers always observe a terminal status. */
  function launch(run: VerifyRun): void {
    // #1d: refuse to write a new temp dir past the high watermark (fail-closed) before doing any work.
    const cap = checkTempCapacity();
    if (!cap.ok) { settle(run, 'failed', { ok: false, error: { code: 'temp_store_full', message: cap.reason } }); return; }
    run.status = 'running';
    run.startedAt = Date.now();
    const { requestId, input } = run;

    let inputPath: string;
    let child: ChildProcess;
    try {
      const written = writeInputJson(requestId, {
        requestId,
        name: input.name,
        adapterPath: input.adapterPath ?? resolveAdapterPath(input.name),
        expectedSourceSha256: input.expectedSourceSha256,
        executionSeedArgs: input.rawSeedArgs, // raw → input.json only
        fixture: input.fixture,
        trace: input.trace,
        // contextId intentionally NOT written — M6b verifies against the daemon default
        // profile; RunnerInput.contextId is a tested forward seam (see verify-runner-main).
      });
      run.tempRoot = written.tempRoot;
      inputPath = written.inputPath;
      // raw seed args are now persisted to the 0600 input.json; drop them from memory immediately so a
      // long-running verify doesn't hold the raw secret for its whole lifetime (Codex M9 review · High).
      input.rawSeedArgs = {};
      // maxRuntimeMs (#7): the child's orphan self-watchdog deadline — above our own timeout +
      // grace so it only fires if WE die before killing it (e.g. win32 reaper can't kill the child).
      const maxRuntimeMs = config.timeoutMs + config.killGraceMs + 5000;
      const args = [...launcher.prefixArgs, ...buildRunnerArgs({ requestId, name: input.name, inputPath, protocolFd: PROTOCOL_FD, maxRuntimeMs })];
      // Adapter stdin/stdout/stderr → /dev/null; the JSONL protocol gets its own pipe at fd 3, so
      // user console.log can neither break (pollute) nor forge it (Codex #3). Parent reads stdio[3].
      const spawnOpts: SpawnOptions = { env: buildChildEnv(written.tempRoot, opts.daemonPort), stdio: ['ignore', 'ignore', 'ignore', 'pipe'] };
      child = spawnImpl(launcher.command, args, spawnOpts);
      run.child = child;
      if (typeof child.pid === 'number') updateMarkerPid(written.tempRoot, child.pid);
    } catch (err) {
      settle(run, 'failed', { ok: false, error: { code: 'runner_protocol_error', message: `launch failed: ${err instanceof Error ? err.message : String(err)}` } });
      return;
    }

    run.killTimer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      run.graceTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, config.killGraceMs);
      settle(run, 'timeout', { ok: false, error: { code: 'verify_timeout', message: `verify exceeded ${config.timeoutMs}ms` } });
    }, config.timeoutMs);

    // ── protocol JSONL on fd 3 — buffer-until-exit (M6c strict duplicate-result, 08:67) ──
    // The protocol is read ONLY from the dedicated fd (Codex #3); the adapter's stdout/stderr are
    // /dev/null, so user output can neither pollute nor forge it. The first `result` is RECORDED,
    // not settled immediately: we keep reading so a SECOND result (or a post-result protocol
    // violation) is caught as runner_protocol_error. The recorded result settles on child exit; a
    // child that emits a result then never exits is force-killed after a short grace and settled
    // with the captured result (not a timeout). `stdoutLimitBytes` now caps the protocol stream.
    let protocolBytes = 0;
    let buf = '';
    let sawResult = false;
    let pending: VerifySummary | null = null;

    const finishWithPending = (): void => {
      if (run.status !== 'running') return;
      if (sawResult && pending) settle(run, pending.ok ? 'succeeded' : 'failed', pending);
      else settle(run, 'failed', { ok: false, error: { code: 'runner_protocol_error', message: 'child exited without a result event' } });
    };

    const protocol = child.stdio[PROTOCOL_FD] as NodeJS.ReadableStream | null | undefined;
    protocol?.on('data', (chunk: Buffer) => {
      if (run.status !== 'running') return;
      protocolBytes += chunk.length;
      if (protocolBytes > config.stdoutLimitBytes) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        settle(run, 'failed', { ok: false, error: { code: 'output_truncated', message: `runner protocol exceeded ${config.stdoutLimitBytes} bytes` } });
        return;
      }
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const parsed = parseRunnerEvent(line, requestId, config.jsonlLineLimit);
        if (!parsed.ok) {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          settle(run, 'failed', { ok: false, error: { code: 'runner_protocol_error', message: parsed.reason } });
          return;
        }
        if (parsed.event.type === 'result') {
          if (sawResult) {
            // A second terminal result is a protocol violation (08: one and only one result).
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
            settle(run, 'failed', { ok: false, error: { code: 'runner_protocol_error', message: 'duplicate result event' } });
            return;
          }
          sawResult = true;
          pending = normalizeRunnerResult(parsed.event);
          // Settle on exit; force-kill + settle if the child lingers past the grace.
          run.resultGrace = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finishWithPending(); }, config.killGraceMs);
        }
      }
    });

    child.on('error', (err) => {
      settle(run, 'failed', { ok: false, error: { code: 'runner_protocol_error', message: `spawn failed: ${err.message}` } });
    });

    // 'close' (not 'exit'): stdout is only guaranteed fully drained at close, so a buffered
    // terminal result is always seen before we decide "no result". Settle with the captured
    // result if any, else a no-result protocol violation (unless already settled via
    // timeout/cancel/cap/duplicate).
    child.on('close', () => {
      if (run.graceTimer) clearTimeout(run.graceTimer);
      finishWithPending();
    });
  }

  /** Pull queued runs into freed slots, FIFO, up to maxConcurrency. */
  function scheduleNext(): void {
    while (runningCount() < config.maxConcurrency && queue.length > 0) {
      const id = queue.shift()!;
      const run = runs.get(id);
      if (run && run.status === 'queued') launch(run);
    }
  }

  /** A request id not already tracked (canonical from the caller, else generated with collision
   * avoidance — Codex #5: a generated id must never alias a live run). */
  function freshRequestId(provided?: string): string {
    if (provided !== undefined) return provided;
    let id: string;
    do { id = `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`; } while (runs.has(id));
    return id;
  }

  function startVerify(input: StartInput): Promise<{ requestId: string }> {
    // Idempotency / anti-clobber (Codex #5 · P2): a repeat start for an id already tracked must NOT
    // overwrite the existing run — `runs.set` would orphan the live child + its kill/grace timers and
    // leak the temp dir, while status/cancel would silently retarget the new run. Return the existing
    // id instead (a canonical-id retry — e.g. be re-forwarding after a network blip — is idempotent;
    // the caller polls getRunStatus for whatever state that run is in).
    if (input.requestId !== undefined) {
      const existing = runs.get(input.requestId);
      if (existing) return Promise.resolve({ requestId: existing.requestId });
    }
    // requestId created BEFORE launch (08). Use the caller's canonical id when provided
    // (be ↔ daemon ↔ runner share one id); else generate (standalone CLI / tests).
    const requestId = freshRequestId(input.requestId);

    // Concurrency gate (synchronous, in-memory): launch if a slot is free, else enqueue, else
    // reject queue_full (08 `queued` status; 09 HIGH_LEVEL_QUEUE_LIMIT; 03 queue_full → 429).
    // Invariant maintained by scheduleNext: runningCount < max ⟹ queue empty, so a free slot
    // never jumps the queue.
    const canLaunch = runningCount() < config.maxConcurrency;
    if (!canLaunch && queue.length >= config.queueLimit) {
      metrics.inc('runner_queue_rejected_total'); // #1c · 09 queue rejected count
      return Promise.reject(Object.assign(new Error(`verify queue is full (limit ${config.queueLimit})`), { code: 'queue_full' }));
    }

    let resolveSettled!: (s: VerifySummary) => void;
    const settled = new Promise<VerifySummary>((res) => { resolveSettled = res; });
    const run: VerifyRun = { requestId, status: 'queued', startedAt: Date.now(), input, summary: null, settled, resolveSettled };
    runs.set(requestId, run);

    if (canLaunch) launch(run);
    else { queue.push(requestId); metrics.observe('runner_queue_depth', queue.length); } // #1c · 09 queue depth

    return Promise.resolve({ requestId });
  }

  async function getVerifyStatus(requestId: string): Promise<VerifySummary | null> {
    return runs.get(requestId)?.summary ?? null; // null while queued/running; VerifySummary once terminal
  }

  async function cancelVerify(requestId: string): Promise<{ cancelled: boolean }> {
    const run = runs.get(requestId);
    if (!run) return { cancelled: false };
    if (run.status !== 'running' && run.status !== 'queued') {
      // Idempotent: already terminal. "cancelled" only if it ended via cancellation.
      return { cancelled: run.status === 'cancelled' };
    }
    if (run.status === 'queued') {
      const i = queue.indexOf(requestId);
      if (i >= 0) queue.splice(i, 1); // drop from queue; no child/temp to clean
    } else {
      // SIGTERM first so the child can release its browser lease (#4), then SIGKILL after the grace
      // (mirrors the timeout path). The grace timer is unref'd — settle() already finalizes the run.
      const child = run.child;
      try { child?.kill('SIGTERM'); } catch { /* already gone */ }
      if (child) setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, config.killGraceMs).unref?.();
    }
    settle(run, 'cancelled', { ok: false, error: { code: 'runner_protocol_error', message: 'cancelled' } });
    return { cancelled: true };
  }

  return {
    startVerify,
    getVerifyStatus,
    cancelVerify,
    whenSettled: (requestId: string) => runs.get(requestId)?.settled ?? null,
    activeCount: () => runningCount(),
    queuedCount: () => queue.length,
    getRunStatus: (requestId: string) => {
      const run = runs.get(requestId);
      return run ? { status: run.status, summary: run.summary } : null;
    },
  };
}

/** Lazily-constructed process-wide default (used by verifyAdapter when no runner is injected). */
let _default: RunnerPortWithLifecycle | null = null;
let _defaultDaemonPort: number | undefined;
let _defaultMetrics: Metrics | undefined;
let _defaultLogger: Logger | undefined;
let _defaultTempCapacity: TempCapacity | undefined;
let _defaultSweepTemp: (() => void) | undefined;

/**
 * Configure the daemon port the default runner hands to child processes via
 * BYCLI_DAEMON_PORT (M6b: browser adapters connect back to this daemon for a Page).
 * The daemon calls this at startup BEFORE the first defaultRunnerPort() use; calling it
 * after the singleton is built is a no-op (the port is fixed at construction).
 */
export function setDefaultRunnerDaemonPort(port: number): void {
  _defaultDaemonPort = port;
}

/**
 * Share the daemon's metrics + structured logger with the default runner (#1c), so runner counters
 * (timeout / queue depth / protocol error / verify duration) surface on the daemon's GET /metrics and
 * runner verify logs share the daemon's level. Same injection contract as setDefaultRunnerDaemonPort:
 * the daemon calls this at startup BEFORE the first defaultRunnerPort() use; later calls are no-ops.
 */
export function setDefaultRunnerObservability(metrics: Metrics, logger: Logger): void {
  _defaultMetrics = metrics;
  _defaultLogger = logger;
}

/**
 * Enable the temp-store capacity guard on the default runner (#1d). Only the daemon (the long-running
 * owner of verify temp dirs) calls this; one-shot CLI verify leaves it off. `sweepTemp` is the daemon's
 * on-pressure shed (its reap). Same injection contract: call BEFORE the first defaultRunnerPort() use.
 */
export function setDefaultRunnerTempGuard(capacity: TempCapacity, sweepTemp?: () => void): void {
  _defaultTempCapacity = capacity;
  _defaultSweepTemp = sweepTemp;
}

export function defaultRunnerPort(): RunnerPortWithLifecycle {
  return (_default ??= createRunnerPort({
    daemonPort: _defaultDaemonPort,
    metrics: _defaultMetrics,
    logger: _defaultLogger,
    tempCapacity: _defaultTempCapacity,
    sweepTemp: _defaultSweepTemp,
  }));
}
