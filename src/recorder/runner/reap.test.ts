import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseVerifyMarker, cmdlineMatchesMarker, isReapableTempDir, isOrphan, isAgedOut,
  effectiveLeakThresholdMs, isOwnerPidReused, reapOrphanedVerifyRuns, type ProcProbe, type VerifyMarker,
} from './reap.js';

const marker = (over: Partial<VerifyMarker> = {}): VerifyMarker => ({
  requestId: 'req_abc', pid: 4242, ownerPid: 1111, startedAt: 0, tempRoot: '/tmp/x', operation: 'verify', ...over,
});

describe('parseVerifyMarker', () => {
  it('parses a well-formed marker', () => {
    const m = parseVerifyMarker(JSON.stringify({ requestId: 'req_1', pid: 9, ownerPid: 7, startedAt: 5, tempRoot: '/t', operation: 'verify' }));
    expect(m).toEqual({ requestId: 'req_1', pid: 9, ownerPid: 7, startedAt: 5, tempRoot: '/t', operation: 'verify' });
  });
  it('rejects non-JSON / wrong operation / missing fields', () => {
    expect(parseVerifyMarker('not json')).toBeNull();
    expect(parseVerifyMarker(JSON.stringify({ requestId: 'r', tempRoot: '/t', operation: 'init' }))).toBeNull();
    expect(parseVerifyMarker(JSON.stringify({ tempRoot: '/t', operation: 'verify' }))).toBeNull(); // no requestId
    expect(parseVerifyMarker(JSON.stringify({ requestId: 'r', operation: 'verify' }))).toBeNull(); // no tempRoot
  });
  it('coerces absent/invalid pid + ownerPid to null (legacy markers)', () => {
    const m = parseVerifyMarker(JSON.stringify({ requestId: 'r', tempRoot: '/t', operation: 'verify' }));
    expect(m).toMatchObject({ pid: null, ownerPid: null });
    const m2 = parseVerifyMarker(JSON.stringify({ requestId: 'r', tempRoot: '/t', operation: 'verify', pid: -1, ownerPid: 0 }));
    expect(m2).toMatchObject({ pid: null, ownerPid: null });
  });
});

describe('cmdlineMatchesMarker (pid-reuse guard)', () => {
  it('requires both verify-runner and the requestId', () => {
    expect(cmdlineMatchesMarker('node main.js internal verify-runner --request-id req_abc', marker())).toBe(true);
    expect(cmdlineMatchesMarker('node main.js internal verify-runner --request-id req_OTHER', marker())).toBe(false);
    expect(cmdlineMatchesMarker('node some-other-process req_abc', marker())).toBe(false);
  });
});

describe('isReapableTempDir (containment)', () => {
  it('only matches our prefix directly under tmpRoot', () => {
    expect(isReapableTempDir('/tmp/bycli-verify-xyz', '/tmp')).toBe(true);
    expect(isReapableTempDir('/tmp/other-app', '/tmp')).toBe(false);
    expect(isReapableTempDir('/tmp/nested/bycli-verify-xyz', '/tmp')).toBe(false); // not a direct child
  });
});

describe('isOrphan', () => {
  it('orphan iff ownerPid known AND not alive', () => {
    expect(isOrphan(marker({ ownerPid: 5 }), false)).toBe(true);   // owner dead
    expect(isOrphan(marker({ ownerPid: 5 }), true)).toBe(false);   // owner alive
    expect(isOrphan(marker({ ownerPid: null }), false)).toBe(false); // legacy → never reap
  });
});

describe('isAgedOut (M7b TTL leak)', () => {
  const NOW = 10_000_000;
  it('aged-out iff dir is older than maxAgeMs', () => {
    expect(isAgedOut(marker({ startedAt: NOW - 5000 }), NOW, 1000)).toBe(true);  // 5s old > 1s ttl
    expect(isAgedOut(marker({ startedAt: NOW - 500 }), NOW, 1000)).toBe(false);  // 0.5s old < 1s ttl
    expect(isAgedOut(marker({ startedAt: NOW }), NOW, 1000)).toBe(false);        // brand new
  });
  it('never aged-out when maxAgeMs<=0 (age reaping disabled)', () => {
    expect(isAgedOut(marker({ startedAt: 1 }), NOW, 0)).toBe(false);
    expect(isAgedOut(marker({ startedAt: 1 }), NOW, -1)).toBe(false);
  });
  it('never aged-out for an undatable legacy marker (startedAt<=0)', () => {
    expect(isAgedOut(marker({ startedAt: 0 }), NOW, 1000)).toBe(false);
  });
});

describe('effectiveLeakThresholdMs (M7b safety floor)', () => {
  const FLOOR = 630_000; // max timeoutMs + max killGraceMs
  it('floors a configured threshold up to the run hard-deadline', () => {
    expect(effectiveLeakThresholdMs(60_000, FLOOR)).toBe(FLOOR);       // short TTL raised to the floor
    expect(effectiveLeakThresholdMs(3_600_000, FLOOR)).toBe(3_600_000); // generous TTL kept as-is
    expect(effectiveLeakThresholdMs(FLOOR, FLOOR)).toBe(FLOOR);
  });
  it('keeps age-reaping disabled for a 0/negative configured value', () => {
    expect(effectiveLeakThresholdMs(0, FLOOR)).toBe(0);
    expect(effectiveLeakThresholdMs(-1, FLOOR)).toBe(0);
  });
});

describe('isOwnerPidReused (#6 pid-reuse guard)', () => {
  const TOL = 60_000;
  it('flags a live pid that started after the run was created (recycled owner pid)', () => {
    expect(isOwnerPidReused(200_000, 100_000, TOL)).toBe(true); // started 100s after the run → reused
  });
  it('does NOT flag the genuine owner (started at/before the run) or sub-tolerance skew', () => {
    expect(isOwnerPidReused(100_000, 100_000, TOL)).toBe(false);   // same instant
    expect(isOwnerPidReused(50_000, 100_000, TOL)).toBe(false);    // owner predates the run
    expect(isOwnerPidReused(130_000, 100_000, TOL)).toBe(false);   // within tolerance
  });
  it('never flags when start time is undeterminable (win32 / ps failure) — no kill on a guess', () => {
    expect(isOwnerPidReused(null, 100_000, TOL)).toBe(false);
    expect(isOwnerPidReused(999_999, 0, TOL)).toBe(false);         // undatable run
  });
});

describe('reapOrphanedVerifyRuns (IO, injected probe)', () => {
  let tmpRoot: string;
  beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-test-')); });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  const makeDir = (name: string, body: object | string | null): string => {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    if (body !== null) fs.writeFileSync(path.join(dir, 'marker.json'), typeof body === 'string' ? body : JSON.stringify(body));
    return dir;
  };
  const probe = (alive: number[], cmdlines: Record<number, string>, killed: Array<[number, string]>, startTimes: Record<number, number | null> = {}): ProcProbe => ({
    isAlive: (pid) => alive.includes(pid),
    cmdline: (pid) => cmdlines[pid] ?? null,
    startTime: (pid) => startTimes[pid] ?? null,
    kill: (pid, sig) => { killed.push([pid, sig]); },
  });

  it('skips a run whose owner is still alive (no kill, no delete)', () => {
    const dir = makeDir('bycli-verify-live', marker({ requestId: 'req_live', pid: 4242, ownerPid: 1111, tempRoot: '' }));
    const killed: Array<[number, string]> = [];
    const r = reapOrphanedVerifyRuns({ tmpRoot, probe: probe([1111, 4242], { 4242: 'verify-runner req_live' }, killed) });
    expect(r).toMatchObject({ scanned: 1, orphans: 0, killed: 0, deleted: 0 });
    expect(fs.existsSync(dir)).toBe(true);
    expect(killed).toHaveLength(0);
  });

  it('#6: reaps when the owner pid is alive but recycled (started long after the run)', () => {
    const NOW = 10_000_000;
    const dir = makeDir('bycli-verify-reused-owner', marker({ requestId: 'req_ro', pid: 4242, ownerPid: 1111, startedAt: NOW - 7_200_000 })); // run created 2h ago
    const killed: Array<[number, string]> = [];
    // ownerPid 1111 is "alive" but its process started 1 min ago — long after the run → pid reused.
    const r = reapOrphanedVerifyRuns({
      tmpRoot, now: NOW,
      probe: probe([1111, 4242], { 4242: 'node main.js internal verify-runner --request-id req_ro' }, killed, { 1111: NOW - 60_000 }),
    });
    expect(r).toMatchObject({ scanned: 1, orphans: 1, killed: 1, deleted: 1 });
    expect(killed).toContainEqual([4242, 'SIGTERM']);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('#6: does NOT reap when the live owner predates the run (genuine owner)', () => {
    const NOW = 10_000_000;
    const dir = makeDir('bycli-verify-real-owner', marker({ requestId: 'req_real', pid: 4242, ownerPid: 1111, startedAt: NOW - 30_000 }));
    const killed: Array<[number, string]> = [];
    const r = reapOrphanedVerifyRuns({
      tmpRoot, now: NOW,
      probe: probe([1111, 4242], { 4242: 'verify-runner req_real' }, killed, { 1111: NOW - 3_600_000 }), // owner started 1h before the run
    });
    expect(r).toMatchObject({ scanned: 1, orphans: 0, killed: 0, deleted: 0 });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('reaps an orphan (owner dead) and kills a live, matching child', () => {
    const dir = makeDir('bycli-verify-orphan', marker({ requestId: 'req_orph', pid: 5050, ownerPid: 2222 }));
    const killed: Array<[number, string]> = [];
    const r = reapOrphanedVerifyRuns({
      tmpRoot, graceMs: 100000,
      probe: probe([5050], { 5050: 'node main.js internal verify-runner --request-id req_orph' }, killed),
    });
    expect(r).toMatchObject({ scanned: 1, orphans: 1, killed: 1, deleted: 1 });
    expect(killed).toContainEqual([5050, 'SIGTERM']);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('reaps an orphan but does NOT kill when cmdline mismatches (pid reuse)', () => {
    const dir = makeDir('bycli-verify-reused', marker({ requestId: 'req_reuse', pid: 6060, ownerPid: 3333 }));
    const killed: Array<[number, string]> = [];
    const r = reapOrphanedVerifyRuns({
      tmpRoot, probe: probe([6060], { 6060: 'totally-unrelated-process' }, killed),
    });
    expect(r).toMatchObject({ orphans: 1, killed: 0, deleted: 1 });
    expect(killed).toHaveLength(0);
    expect(fs.existsSync(dir)).toBe(false); // temp (seed args) still purged
  });

  it('reaps an orphan whose child is already dead (delete only)', () => {
    makeDir('bycli-verify-dead', marker({ requestId: 'req_dead', pid: 7070, ownerPid: 4444 }));
    const killed: Array<[number, string]> = [];
    const r = reapOrphanedVerifyRuns({ tmpRoot, probe: probe([], {}, killed) });
    expect(r).toMatchObject({ orphans: 1, killed: 0, deleted: 1 });
  });

  it('leaves legacy markers (no ownerPid) untouched', () => {
    const dir = makeDir('bycli-verify-legacy', { requestId: 'req_legacy', pid: 8080, tempRoot: '/t', operation: 'verify' });
    const r = reapOrphanedVerifyRuns({ tmpRoot, probe: probe([], {}, []) });
    expect(r).toMatchObject({ scanned: 1, orphans: 0, deleted: 0 });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('ignores unrelated dirs and missing-marker dirs', () => {
    makeDir('some-other-app', { foo: 1 });
    makeDir('bycli-verify-nomarker', null);
    const r = reapOrphanedVerifyRuns({ tmpRoot, probe: probe([], {}, []) });
    expect(r.scanned).toBe(1);   // only the bycli-verify-* dir is scanned
    expect(r.orphans).toBe(0);   // no readable marker → left alone
  });

  it('M7b: reaps an aged-out dir even when its owner is still alive', () => {
    const NOW = 10_000_000;
    const dir = makeDir('bycli-verify-stale', marker({ requestId: 'req_stale', pid: 9090, ownerPid: 1111, startedAt: NOW - 7_200_000 })); // 2h old
    const killed: Array<[number, string]> = [];
    const r = reapOrphanedVerifyRuns({
      tmpRoot, now: NOW, maxAgeMs: 3_600_000, // 1h ttl
      probe: probe([1111, 9090], { 9090: 'node main.js internal verify-runner --request-id req_stale' }, killed),
    });
    expect(r).toMatchObject({ scanned: 1, orphans: 0, agedOut: 1, killed: 1, deleted: 1 });
    expect(killed).toContainEqual([9090, 'SIGTERM']);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('M7b: leaves a young dir with a live owner untouched under TTL', () => {
    const NOW = 10_000_000;
    const dir = makeDir('bycli-verify-young', marker({ requestId: 'req_young', pid: 8080, ownerPid: 2222, startedAt: NOW - 30_000 })); // 30s old
    const killed: Array<[number, string]> = [];
    const r = reapOrphanedVerifyRuns({
      tmpRoot, now: NOW, maxAgeMs: 3_600_000,
      probe: probe([2222, 8080], { 8080: 'verify-runner req_young' }, killed),
    });
    expect(r).toMatchObject({ scanned: 1, orphans: 0, agedOut: 0, killed: 0, deleted: 0 });
    expect(fs.existsSync(dir)).toBe(true);
    expect(killed).toHaveLength(0);
  });

  it('M7b regression (Codex #1): does NOT kill a live run older than a short TTL but within its hard deadline', () => {
    const NOW = 10_000_000;
    // Operator sets RECORDER_TEMP_TTL_MS=60s, but the verify legitimately runs 2min (well within the
    // 10min timeoutMs). Without the minLeakAgeMs floor the sweep would SIGKILL this live run.
    const dir = makeDir('bycli-verify-shortttl', marker({ requestId: 'req_short', pid: 9091, ownerPid: 1111, startedAt: NOW - 120_000 })); // 2min old
    const killed: Array<[number, string]> = [];
    const r = reapOrphanedVerifyRuns({
      tmpRoot, now: NOW, maxAgeMs: 60_000, minLeakAgeMs: 630_000, // floor at max run lifetime
      probe: probe([1111, 9091], { 9091: 'node main.js internal verify-runner --request-id req_short' }, killed),
    });
    expect(r).toMatchObject({ scanned: 1, orphans: 0, agedOut: 0, killed: 0, deleted: 0 });
    expect(fs.existsSync(dir)).toBe(true);
    expect(killed).toHaveLength(0);
  });

  it('M7b: still reaps a leak older than the floored hard-deadline (owner alive, past max lifetime)', () => {
    const NOW = 10_000_000;
    // ~11.6min old > the 630s floor: a legit run would have been SIGKILLed + cleaned long ago, so a
    // surviving dir is a true leak even with a (stale) live ownerPid.
    const dir = makeDir('bycli-verify-pastfloor', marker({ requestId: 'req_past', pid: 9092, ownerPid: 1111, startedAt: NOW - 700_000 }));
    const killed: Array<[number, string]> = [];
    const r = reapOrphanedVerifyRuns({
      tmpRoot, now: NOW, maxAgeMs: 60_000, minLeakAgeMs: 630_000,
      probe: probe([1111, 9092], { 9092: 'node main.js internal verify-runner --request-id req_past' }, killed),
    });
    expect(r).toMatchObject({ scanned: 1, orphans: 0, agedOut: 1, killed: 1, deleted: 1 });
    expect(killed).toContainEqual([9092, 'SIGTERM']);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
