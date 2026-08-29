# Adapter Start Interval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a five-second minimum interval between isolated Adapter lease grants in the same profile-and-site pool while retaining three-way execution concurrency.

**Architecture:** Add daemon-memory pacing state to `AdapterScheduler`, which already owns pool membership, FIFO ordering, concurrency, and authentication closure. The first grant is immediate, subsequent grants are timer-driven, and the last grant window survives a temporarily drained pool so quick commands cannot recreate the pool and bypass pacing.

**Tech Stack:** TypeScript, Node.js timers, Vitest fake timers, daemon HTTP integration tests, npm release workflow.

---

## File map

- Modify `src/adapter-scheduler.ts`: own the five-second grant window and pacing timer lifecycle.
- Modify `src/adapter-scheduler.test.ts`: add deterministic timing tests and keep unrelated scheduler tests fast with a zero interval.
- Modify `src/daemon.test.ts`: update the real daemon lease test for paced grants and assert grant timestamps.
- Modify `package.json` and `package-lock.json`: release version `2.1.44`.

### Task 1: Specify scheduler pacing with failing tests

**Files:**
- Modify: `src/adapter-scheduler.test.ts`

- [ ] **Step 1: Keep existing non-pacing tests deterministic**

Use `new AdapterScheduler({ startIntervalMs: 0 })` in tests whose purpose is not start pacing, preserving their current immediate-grant assumptions.

- [ ] **Step 2: Add the primary paced-grant test**

Use Vitest fake timers and a fixed system time. Queue three distinct sessions and assert:

```ts
expect((await first).grantedAt).toBe(1_000);
await vi.advanceTimersByTimeAsync(4_999);
expect(secondGranted).toBe(false);
await vi.advanceTimersByTimeAsync(1);
expect((await second).grantedAt).toBe(6_000);
await vi.advanceTimersByTimeAsync(5_000);
expect((await third).grantedAt).toBe(11_000);
```

- [ ] **Step 3: Add boundary tests**

Cover these exact outcomes:

- releasing at 2 seconds does not grant queued work before 5 seconds;
- different profiles and different sites grant immediately and independently;
- a drained pool retains its next grant boundary;
- queue timeout wins when it expires before the next start window;
- `auth_gate` rejects a paced queued request and prevents timer-driven execution;
- `reset()` clears pacing work and rejects the queue.

- [ ] **Step 4: Run the focused test and verify RED**

Run `npx vitest run src/adapter-scheduler.test.ts`.

Expected: failures because `AdapterSchedulerOptions.startIntervalMs` and paced grant behavior do not exist.

### Task 2: Implement central lease pacing

**Files:**
- Modify: `src/adapter-scheduler.ts`
- Test: `src/adapter-scheduler.test.ts`

- [ ] **Step 1: Add configuration and pool state**

Add:

```ts
interface PoolState {
  // existing fields remain
  nextGrantAt: number;
  scheduleTimer?: ReturnType<typeof setTimeout>;
}

export interface AdapterSchedulerOptions {
  // existing fields remain
  startIntervalMs?: number;
}
```

Store a validated non-negative integer interval, defaulting to `5_000`, and initialize new pools with `nextGrantAt: 0`.

- [ ] **Step 2: Add one-timer scheduling helpers**

Implement helpers equivalent to:

```ts
private clearPoolTimer(pool: PoolState): void {
  if (pool.scheduleTimer) clearTimeout(pool.scheduleTimer);
  pool.scheduleTimer = undefined;
}

private armPoolTimer(pool: PoolState, dueAt: number): void {
  if (pool.scheduleTimer) return;
  pool.scheduleTimer = setTimeout(() => {
    pool.scheduleTimer = undefined;
    this.sweepExpired();
  }, Math.max(0, dueAt - this.now()));
  pool.scheduleTimer.unref?.();
}
```

The callback re-enters normal scheduling so closed pools, expired requests, capacity, and session eligibility are revalidated.

- [ ] **Step 3: Replace burst granting with paced granting**

Change `schedule(pool)` so it selects the first FIFO eligible request; arms the timer and returns when `now < nextGrantAt`; grants exactly one lease; sets `nextGrantAt = grantedAt + startIntervalMs`; then schedules again so either an immediate zero-interval grant or one future timer is established.

- [ ] **Step 4: Preserve and clean drained windows**

Change `removeDrainedPool(pool)` to retain an empty pool until `nextGrantAt`, using the same timer. Delete it immediately only when the window has expired. Ensure pool closure and `reset()` clear the pacing timer.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run `npx vitest run src/adapter-scheduler.test.ts`.

Expected: all scheduler tests pass without real five-second waits.

### Task 3: Verify pacing through the daemon HTTP boundary

**Files:**
- Modify: `src/daemon.test.ts`

- [ ] **Step 1: Extend lease timeout for the real interval**

Set the integration fixture's `queueTimeoutMs` to at least `20_000`, allowing grants near 0, 5, and 10 seconds.

- [ ] **Step 2: Assert observed grant gaps**

After acquiring workers a, b, and c, compare their numeric `grantedAt` fields:

```ts
expect(Number(leases[1].data.grantedAt) - Number(leases[0].data.grantedAt)).toBeGreaterThanOrEqual(4_900);
expect(Number(leases[2].data.grantedAt) - Number(leases[1].data.grantedAt)).toBeGreaterThanOrEqual(4_900);
```

Keep the existing fourth-request queue, resource lock, lease fencing, and release assertions.

- [ ] **Step 3: Run focused daemon and coordination tests**

Run `npx vitest run src/daemon.test.ts src/adapter-coordination.test.ts`.

Expected: all tests pass; the daemon integration test takes roughly ten seconds longer than before.

### Task 4: Complete regression verification

**Files:**
- No production file changes expected.

- [ ] **Step 1: Run static and focused checks**

Run `npm run typecheck` and the focused scheduler, daemon, and coordination tests. Expected: exit code 0.

- [ ] **Step 2: Run full Adapter and repository suites**

Run `npm run test:adapters`, `npm test`, and `npm run build`. Expected: exit code 0 with only documented skips.

### Task 5: Release byCLI 2.1.44

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Bump the package version**

Change only the root package version entries from `2.1.43` to `2.1.44`.

- [ ] **Step 2: Verify the package archive**

Run `npm pack --dry-run`. Expected: archive metadata reports `@sovovs/bycli@2.1.44`.

- [ ] **Step 3: Commit implementation and release metadata**

Stage `src/adapter-scheduler.ts`, `src/adapter-scheduler.test.ts`, `src/daemon.test.ts`, `package.json`, and `package-lock.json`, then commit with `feat: pace isolated adapter session starts`.

- [ ] **Step 4: Push main, tag, and release**

Push `main` to `ssh://git@github.com/sovovs/byCLI.git`, create annotated tag `v2.1.44`, push the tag, wait for the release workflow to complete, and verify npm exposes `2.1.44`.

### Task 6: Install and perform live validation

**Files:**
- No repository changes expected.

- [ ] **Step 1: Install and verify the released CLI**

Install `@sovovs/bycli@2.1.44`, then verify `bycli --version`, `bycli doctor`, and `bycli daemon status`. Expected: CLI and daemon report `2.1.44`; Browser Bridge is connected.

- [ ] **Step 2: Run three named Weixin downloads together**

Use three unique batch-scoped Adapter sessions, three distinct output directories, and the existing login-gate runner. Confirm the commands receive starts near 0, 5, and 10 seconds.

- [ ] **Step 3: Validate the fourth-request boundary**

Submit a fourth named request while three are active. Verify it starts only after a running lease releases and the next five-second start window opens. If any active request returns `AUTH_REQUIRED` or `RATE_LIMITED`, verify the fourth remains unstarted and stop under the login gate.

- [ ] **Step 4: Report evidence**

Report the installed version, observed timing gaps, per-worker outcomes, whether the fourth request started, and whether remote Weixin verification still occurred. Do not claim that pacing guarantees avoidance of external risk control.
