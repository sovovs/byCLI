/**
 * Startup reap (08:37) + age-based TTL sweep (M7b). On daemon (Local Service) restart, a
 * verify-runner child and its temp dir can outlive the parent that spawned it (the parent crashed
 * before cleanup). On startup — and periodically while running — we scan os.tmpdir() for
 * `bycli-verify-*` dirs and clean up two classes:
 *   1. TRUE orphans: runs whose `ownerPid` (the spawning daemon/CLI) is no longer alive.
 *   2. AGED-OUT leaks (M7b): dirs older than the EFFECTIVE threshold, regardless of owner liveness.
 *      The caller floors that threshold at the run's hard deadline (`minLeakAgeMs` = timeoutMs +
 *      killGraceMs) — a verify cannot legitimately outlive its own kill deadline, and the runner-port
 *      deletes the temp dir on settle, so a dir still present past the deadline is a definite leak
 *      (the owning process died mid-run), never a live run. NOTE: the raw configured TTL alone is NOT
 *      safe — RECORDER_TEMP_TTL_MS can be set as low as 60000ms while timeoutMs reaches 600000ms, so
 *      without the floor the periodic sweep could kill a still-running verify.
 * A run that is neither an orphan nor aged-out is left untouched, so a sibling process's in-flight
 * verify is never disturbed.
 *
 * For a confirmed reap target whose child pid is still alive AND whose live cmdline matches
 * (`verify-runner` + the marker requestId — a pid-reuse guard), we SIGTERM then SIGKILL. The
 * temp dir (which holds input.json with raw seed args) is always deleted for a confirmed target.
 *
 * Pure helpers (parse / match / orphan / aged-out decision) are exported for unit testing; the IO
 * entry point takes an injectable ProcProbe + clock so tests never read /proc, run `ps`, or kill.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface VerifyMarker {
  requestId: string;
  /** The runner child pid (backfilled into marker.json after spawn). */
  pid: number | null;
  /** The process that spawned the runner (daemon/CLI); stands in for 08's localServiceRunId. */
  ownerPid: number | null;
  startedAt: number;
  tempRoot: string;
  operation: 'verify';
}

/** Parse + validate marker.json. Returns null unless it is a well-formed verify marker. */
export function parseVerifyMarker(raw: string): VerifyMarker | null {
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (o.operation !== 'verify') return null;
  if (typeof o.requestId !== 'string' || !o.requestId) return null;
  if (typeof o.tempRoot !== 'string' || !o.tempRoot) return null;
  const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
  return {
    requestId: o.requestId,
    pid: intOrNull(o.pid),
    ownerPid: intOrNull(o.ownerPid),
    startedAt: typeof o.startedAt === 'number' ? o.startedAt : 0,
    tempRoot: o.tempRoot,
    operation: 'verify',
  };
}

/** Does a live process's command line belong to THIS marker's runner? (pid-reuse guard) */
export function cmdlineMatchesMarker(cmdline: string, marker: VerifyMarker): boolean {
  return cmdline.includes('verify-runner') && cmdline.includes(marker.requestId);
}

/** Containment: the dir must sit directly under tmpRoot and carry our prefix. */
export function isReapableTempDir(dir: string, tmpRoot: string): boolean {
  const resolved = path.resolve(dir);
  return path.dirname(resolved) === path.resolve(tmpRoot) && path.basename(resolved).startsWith('bycli-verify-');
}

/**
 * True orphan iff the spawning owner is gone. An unknown ownerPid (legacy marker without the
 * field) is treated as live → skipped, so we never kill a run we cannot attribute to a dead owner.
 */
export function isOrphan(marker: VerifyMarker, ownerAlive: boolean): boolean {
  return marker.ownerPid !== null && !ownerAlive;
}

/**
 * Aged-out leak (M7b · RECORDER_TEMP_TTL_MS / RECORDER_STARTUP_REAP_MAX_AGE_MS, 09:27-28):
 * a temp dir older than `maxAgeMs` is reaped regardless of owner liveness. CALLERS MUST pass the
 * floored threshold from `effectiveLeakThresholdMs` (never the raw config) — `maxAgeMs` here is
 * assumed to already exceed the run's hard deadline, so a dir older than it is a definite leak,
 * never a live run. An undatable legacy marker (startedAt<=0) is never aged-out (we cannot
 * attribute its age). maxAgeMs<=0 disables age-based reaping (orphan-only, the pre-M7b behavior).
 */
export function isAgedOut(marker: VerifyMarker, now: number, maxAgeMs: number): boolean {
  return maxAgeMs > 0 && marker.startedAt > 0 && now - marker.startedAt > maxAgeMs;
}

/**
 * Effective age-reap threshold: the configured `maxAgeMs` floored at the run's hard deadline
 * (`minLeakAgeMs` = timeoutMs + killGraceMs). A threshold below the max legitimate run lifetime would
 * let the sweep kill a still-running verify — a live run can outlive a short TTL but never its own
 * kill deadline, so flooring closes that hole. A 0/negative configured value keeps age-reaping
 * disabled (orphan-only).
 */
export function effectiveLeakThresholdMs(maxAgeMs: number, minLeakAgeMs: number): number {
  return maxAgeMs > 0 ? Math.max(maxAgeMs, minLeakAgeMs) : 0;
}

export interface ProcProbe {
  isAlive(pid: number): boolean;
  cmdline(pid: number): string | null;
  /** Process start time (epoch ms) for the live pid, or null if undeterminable (win32 / ps failure).
   * Used for the owner pid-reuse guard (#6); optional so injected test probes need not implement it. */
  startTime?(pid: number): number | null;
  kill(pid: number, signal: NodeJS.Signals): void;
}

function defaultIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function defaultCmdline(pid: number): string | null {
  if (process.platform === 'win32') return null; // no portable cmdline probe → don't kill on win32
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch { return null; } // ps non-zero → pid not alive
}
function defaultStartTime(pid: number): number | null {
  if (process.platform === 'win32') return null; // no portable start-time probe on win32
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 }).trim();
    if (!out) return null;
    const t = new Date(out).getTime(); // `ps -o lstart` is an absolute local-time stamp Date can parse
    return Number.isNaN(t) ? null : t;
  } catch { return null; }
}
const defaultProbe: ProcProbe = {
  isAlive: defaultIsAlive,
  cmdline: defaultCmdline,
  startTime: defaultStartTime,
  kill: (pid, signal) => { process.kill(pid, signal); },
};

/** Tolerance (ms) absorbing start-time measurement granularity (`ps lstart` is second-resolution). */
const OWNER_PID_REUSE_TOLERANCE_MS = 60_000;

/**
 * Owner pid-reuse guard (#6): the spawning owner necessarily started BEFORE it created this run, so a
 * process now occupying `ownerPid` whose start time is meaningfully AFTER the run was created cannot be
 * that owner — the real owner died and the pid was recycled, making this a true orphan. Undeterminable
 * start time (win32 / ps failure → null) → NOT reused: we never escalate to a kill on a guess, so a
 * live owner is never misclassified (its start time is ≤ runStartedAt, far below the threshold).
 */
export function isOwnerPidReused(liveStartTime: number | null, runStartedAt: number, toleranceMs: number): boolean {
  if (liveStartTime === null || runStartedAt <= 0) return false;
  return liveStartTime > runStartedAt + toleranceMs;
}

export interface ReapResult { scanned: number; orphans: number; agedOut: number; killed: number; deleted: number; }

/**
 * Scan tmpRoot for orphaned / aged-out verify temp dirs and clean them up. Synchronous (runs at
 * daemon startup and on a periodic sweep); the SIGKILL backstop is scheduled async + unref'd so it
 * never blocks. `maxAgeMs` (M7b) enables age-based reaping; 0/undefined keeps orphan-only behavior.
 */
export function reapOrphanedVerifyRuns(opts: {
  tmpRoot?: string;
  log?: (msg: string) => void;
  graceMs?: number;
  /** Age-based leak threshold (M7b). 0/undefined → orphan-only (pre-M7b behavior). */
  maxAgeMs?: number;
  /** Run hard-deadline floor (timeoutMs + killGraceMs); the age threshold is never lower than this
   * so a still-running verify is never age-reaped (08 / M7b safety floor). */
  minLeakAgeMs?: number;
  /** Injectable clock (tests). */
  now?: number;
  probe?: ProcProbe;
} = {}): ReapResult {
  const tmpRoot = opts.tmpRoot ?? os.tmpdir();
  const log = opts.log ?? (() => {});
  const probe = opts.probe ?? defaultProbe;
  const graceMs = opts.graceMs ?? 2000;
  const maxAgeMs = effectiveLeakThresholdMs(opts.maxAgeMs ?? 0, opts.minLeakAgeMs ?? 0);
  const now = opts.now ?? Date.now();
  const result: ReapResult = { scanned: 0, orphans: 0, agedOut: 0, killed: 0, deleted: 0 };

  let entries: string[];
  try { entries = fs.readdirSync(tmpRoot); } catch { return result; }

  for (const entry of entries) {
    if (!entry.startsWith('bycli-verify-')) continue;
    const dir = path.join(tmpRoot, entry);
    if (!isReapableTempDir(dir, tmpRoot)) continue;
    result.scanned++;

    let marker: VerifyMarker | null = null;
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;                                   // skip non-dirs / symlinks
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) continue;        // not ours
      marker = parseVerifyMarker(fs.readFileSync(path.join(dir, 'marker.json'), 'utf8'));
    } catch { continue; } // unreadable / missing marker → leave it (can't attribute ownership)

    if (!marker) continue;
    let ownerAlive = marker.ownerPid !== null ? probe.isAlive(marker.ownerPid) : true;
    if (ownerAlive && marker.ownerPid !== null) {
      // pid-reuse guard (#6): an "alive" ownerPid that started after this run was created is a
      // recycled pid, not the original owner → the real owner is dead → orphan.
      const liveStart = probe.startTime ? probe.startTime(marker.ownerPid) : null;
      if (isOwnerPidReused(liveStart, marker.startedAt, OWNER_PID_REUSE_TOLERANCE_MS)) ownerAlive = false;
    }
    const orphan = isOrphan(marker, ownerAlive);
    const aged = isAgedOut(marker, now, maxAgeMs);
    if (!orphan && !aged) continue; // live owner + within TTL → still an active/managed run
    if (orphan) result.orphans++;
    if (aged) result.agedOut++;

    // Confirmed target: terminate the child only if it is still alive AND identifiably ours.
    if (marker.pid !== null && probe.isAlive(marker.pid)) {
      const cmdline = probe.cmdline(marker.pid);
      if (cmdline && cmdlineMatchesMarker(cmdline, marker)) {
        const pid = marker.pid;
        try { probe.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        setTimeout(() => { try { probe.kill(pid, 'SIGKILL'); } catch { /* gone */ } }, graceMs).unref?.();
        result.killed++;
        log(`[reap] terminated verify runner pid=${pid} req=${marker.requestId}`);
      }
    }

    try { fs.rmSync(dir, { recursive: true, force: true }); result.deleted++; } catch { /* best-effort */ }
  }

  if (result.scanned > 0) {
    log(`[reap] verify temp: scanned=${result.scanned} orphans=${result.orphans} agedOut=${result.agedOut} killed=${result.killed} deleted=${result.deleted}`);
  }
  return result;
}
