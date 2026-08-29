# Adapter Isolated-Tab Start Interval Design

## Status

Approved for implementation on 2026-08-29.

## Problem

Commands that declare `adapterConcurrency.isolatedTabs: true` can receive up to three Adapter leases in the same scheduler pass. The browser tabs are isolated, but the commands can still share an authenticated profile, account, IP address, and remote service risk controls. A zero-delay burst therefore increases the chance that a site interprets otherwise valid parallel work as abnormal traffic.

The concurrency limit must remain three, but lease grants within the same profile-and-site pool need a minimum five-second start interval.

## Scope

The interval applies to every command whose manifest declares `adapterConcurrency.isolatedTabs: true`. It is enforced centrally by the daemon's `AdapterScheduler`, rather than by individual adapters or callers.

The pacing scope remains the existing Adapter pool key:

```text
contextId + surface(adapter) + site
```

Consequently:

- Commands in the same browser profile and site are paced together.
- Different browser profiles can start independently.
- Different sites can start independently.
- Unnamed legacy Adapter commands and commands without `isolatedTabs: true` keep their existing behavior.

## Required Semantics

1. The first eligible request in a newly active pool receives a lease immediately unless a retained five-second grant window for that pool is still active.
2. Every later lease grant in that pool must occur at least 5,000 milliseconds after the preceding grant.
3. The limit remains three simultaneously running leases. Pacing controls starts; it does not serialize command execution.
4. A queued request needs both an available concurrency slot and an open start window before it can receive a lease.
5. Releasing a lease before the next start window does not allow an early grant.
6. Releasing a lease after the next start window allows the next eligible queued request to start immediately.
7. The existing FIFO ordering and same-Adapter-session exclusion remain unchanged.
8. Queue timeout continues to run from enqueue time. Time spent waiting for the start window counts against `queueTimeoutMs`.
9. An `auth_gate` or `rate_limited` release closes the pool immediately, rejects queued requests, and cancels any pending pacing wake-up.
10. Pacing state is daemon-memory state. A daemon restart resets it.

## Architecture

### Scheduler configuration

Add `startIntervalMs` to `AdapterSchedulerOptions`, defaulting to `5_000`. Tests may set it to another non-negative value. Production daemon construction uses the default.

### Pool timing state

Each pool tracks:

- `nextGrantAt`: earliest timestamp at which another lease may be granted.
- `scheduleTimer`: at most one wake-up timer for that pool.

After a lease is granted at `grantedAt`, set:

```text
nextGrantAt = grantedAt + startIntervalMs
```

The scheduler grants at most one lease per scheduling pass. If capacity and an eligible queued request remain, it arms one wake-up for `nextGrantAt` instead of continuing the current `while` loop.

### Drained-pool boundary

The scheduler must preserve the last grant window until `nextGrantAt`, even if the pool temporarily has no running or queued requests. This prevents a fast command from draining the pool and allowing a new request to bypass the five-second interval by recreating the pool.

After the window expires, a pool with no running or queued work may be removed. Its timer must not keep the Node.js process alive.

### Scheduling flow

For a pool with queued work:

1. Return without granting if the pool is closed.
2. Return if the running count already equals `maxParallel`.
3. Select the first FIFO request whose Adapter session is not active.
4. If no request is eligible, return.
5. If `now < nextGrantAt`, arm or retain one timer for the remaining duration and return.
6. Grant exactly one lease, update `nextGrantAt`, then schedule the next wake-up if more eligible work and capacity remain.

Lease release calls the same scheduler flow. It cannot override the time check.

## API and Compatibility

No new CLI flag or manifest field is introduced. Existing structured help remains:

```yaml
adapterConcurrency:
  isolatedTabs: true
  maxParallel: 3
```

The behavior change is therefore a runtime safety policy shared by all isolated-tab commands. `--adapter-queue-timeout` retains its current meaning and default; callers that choose a very short timeout may now time out before a paced lease is granted.

No browser-extension change is required because lease scheduling is daemon-owned.

## Error Handling and Cleanup

- Pacing timer callbacks re-enter scheduler logic and do not directly grant stale requests.
- Queue expiration is checked before a paced grant.
- Pool closure clears its pacing timer before rejecting queued entries.
- Scheduler shutdown clears all pool pacing timers.
- Pool deletion is allowed only when no leases or requests remain and the pacing window has expired.
- Duplicate release and stale-lease behavior remain unchanged.

## Verification

### Deterministic unit tests

Extend `src/adapter-scheduler.test.ts` with a controllable clock/timer fixture and verify:

1. Three queued sessions receive grants near 0, 5,000, and 10,000 milliseconds.
2. A lease released at 2,000 milliseconds does not cause the next grant before 5,000 milliseconds.
3. A capacity slot released after the time window grants the next request immediately.
4. A fourth request waits for both capacity and the next start window.
5. Same-session requests remain serial.
6. Different `contextId` values receive immediate independent grants.
7. Different sites receive immediate independent grants.
8. `auth_gate` and `rate_limited` reject all paced queued requests and prevent timer-driven grants.
9. Queue timeout can expire while waiting for the start window.
10. A drained and quickly recreated logical pool cannot bypass the retained interval.
11. Scheduler shutdown clears pacing timers.

### Daemon integration tests

Extend `src/daemon.test.ts` to assert that the HTTP lease API exposes the same paced ordering, while preserving the existing fourth-request queue, pool-close, and release behavior.

### Regression suite

Run type checking, Adapter scheduler and daemon tests, the complete Adapter suite, the complete test suite, and the production build.

### Real browser validation

Using three unique named Adapter sessions under one connected profile:

1. Submit three `bycli weixin download` commands together.
2. Confirm their lease grant or browser-navigation starts are separated by approximately five seconds: 0, 5, and 10 seconds.
3. Keep a fourth request queued and verify it starts only after both a lease is released and its pacing window opens.
4. Confirm separate output directories and TABs remain isolated.
5. If any worker returns `AUTH_REQUIRED` or `RATE_LIMITED`, confirm the queued fourth request does not start.

This live check establishes that pacing is enforced. It cannot prove that a remote service will never trigger risk controls; those controls are external and may depend on account, IP, device, historical traffic, and article state.

## Non-goals

- Dynamically adapting the interval based on remote responses.
- Guaranteeing avoidance of Weixin or other site risk controls.
- Reducing `maxParallel` below the command's declared limit.
- Persisting pacing state across daemon restarts.
- Adding per-command or per-site interval configuration in this change.
