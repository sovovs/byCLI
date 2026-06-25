# 05 · Recorder Local Service

## 职责

Recorder Local Service 是 UI 的唯一能力入口。它持有 daemon/high-level token,管理 recorder session、page lease、request registry、capture window、queue 和 temp store。UI 不知道 daemon 或 high-level wrapper 地址。

## API

| Endpoint | Purpose | Guard |
| --- | --- | --- |
| `GET /recorder/health` | health of Local Service, daemon, extension, high-level modules | Origin check, no token returned |
| `POST /recorder/session/bind` | bind existing tab or create page | session/context validation |
| `POST /recorder/session/confirm-auth` | confirm user login, advance `awaiting_user_login` → `auth_confirmed` | valid state, optional authCheck |
| `POST /recorder/navigate` | validate URL and navigate | URL policy, CSRF/header |
| `POST /recorder/capture/start` | start A/B sample capture | valid state, sampleName |
| `POST /recorder/capture/read` | read and close active capture | valid state, redaction before return |
| `POST /recorder/rank` | normalize/rank/diff A/B samples into candidates | valid state, both samples present |
| `POST /recorder/analyze` | start high-level analyze | request registry, timeout |
| `POST /recorder/init` | create adapter draft | name/path validation, dry-run diff |
| `POST /recorder/verify` | start high-level verify | runner timeout/trace policy |
| `GET /recorder/requests/{requestId}` | status and redacted result | same UI session ownership |
| `POST /recorder/cancel` | cancel long task/capture | idempotent cleanup |

The table above is the **be-facing** `/recorder/*` surface (what the UI calls). FS/subprocess-class capabilities (`init`, `verify`) are not executed in `dashboard-be` — they forward to **daemon high-level endpoints** added in M5 (see `07` hosting table + ADR-0007):

| daemon endpoint | Backs | Hosting |
| --- | --- | --- |
| `POST /v1/init` | `POST /recorder/init` | daemon imports main-repo `createAdapterDraft` (FS write transaction main-repo side); synchronous |
| `POST /v1/verify` | `POST /recorder/verify` | daemon imports main-repo `verifyAdapter` → `RunnerPort` (M6 child process) |

`analyze` does **not** use a `/v1/*` endpoint: it is browser-IO, so `dashboard-be` orchestrates it over the existing `POST /command` chain and calls the pure `analyzeSite`. These daemon `/v1/*` endpoints are gated by the same `X-byCLI` header as `/command`.

## State Machine

```
idle
  -> health_checked
  -> session_bound
  -> awaiting_user_login   (only for create_page_await_user_login)
  -> auth_confirmed
  -> page_ready
  -> capture_a
  -> capture_b
  -> ranked                (normalize is an internal step of rank, not an externally driven state)
  -> draft_created
  -> verifying
  -> done | failed | cancelled
```

Each transition is driven by an explicit endpoint (no implicit auto-advance):

| Transition | Driving endpoint |
| --- | --- |
| `idle -> health_checked` | `GET /recorder/health` (read-only precondition check, no session side effect) |
| `health_checked -> session_bound` / `awaiting_user_login` | `POST /recorder/session/bind` |
| `awaiting_user_login -> auth_confirmed` | `POST /recorder/session/confirm-auth` |
| `auth_confirmed -> page_ready` (or `session_bound -> page_ready` when no login wait) | bind/confirm completion |
| `page_ready` (re)navigation within lease | `POST /recorder/navigate` (changes browser page, stays in `page_ready`) |
| `page_ready -> capture_a`, `capture_a -> capture_b` | `POST /recorder/capture/start` + `POST /recorder/capture/read` per sample |
| `capture_b -> ranked` | `POST /recorder/rank` (reads the session's frozen A/B samples; normalize/rank/diff run inside) |
| `ranked -> draft_created` | `POST /recorder/init` (selects a candidate via `selectedCandidateId`) |
| `draft_created -> verifying` | `POST /recorder/verify` |
| `verifying -> done \| failed` | verify runner terminal result (success → `done`, error/timeout → `failed`) |
| any -> `cancelled` | `POST /recorder/cancel` |
| any active state -> `failed` (lease released) | abnormal lease loss: `page_lost`, browser/tab closed, daemon disconnect, or capture-window timeout. The session terminates to `failed`, the page/session lease and capture window are released, and the same cleanup as `done/failed/cancelled` runs. A new session must be bound to retry; the lost session is not silently resumed. |

`POST /recorder/analyze` is an optional, parallel site-level exploration (its own async request, see `07` Analyze Execution Model); it is not a step in this main capture→rank→init→verify chain and does not advance the session state. Its `RequestStatus` (`type=analyze`) lives in the request registry on its own lifecycle, independent of this session state machine.

Rules:

- A recorder session stores `sessionId`, `contextId`, `page targetId`, `requestIds`, `capture state`.
- One session has at most one active capture window.
- Multiple sessions may run in parallel but state, page, capture entries, temp files and request ids are isolated.
- All state-mutating endpoints are linearized per `sessionId`: a transition checks the expected current state and atomically advances a monotonic `stateVersion` (per-session mutex or `stateVersion` CAS). Concurrent attempts to advance the same session — e.g. `navigate` vs `capture/start`, two `capture/start`, or `rank` vs `init`/`cancel` — never double-advance; the losing caller gets a stable `invalid_state` (or `queue_full` if serialized behind an in-flight transition). Idempotency keys do not bypass this: a different key observing the same state still serializes.
- `cancel` is idempotent.
- Abnormal lease loss (page_lost, browser/tab close, daemon disconnect, capture-window timeout) deterministically drives the session to `failed` and releases the page/session lease and capture window; leases are never left dangling. Startup reap (see Crash Recovery) releases any lease whose owning session is gone.
- done/failed/cancelled cleans raw capture buffer, raw trace, raw `executionSeedArgs` and transient files.
- UI refresh may query session/request status, but never sees daemon/high-level token or raw samples.

## Strict Page Lease

Recorder must not use stale-page fallback behavior from generic Page wrappers.

| Scenario | Behavior |
| --- | --- |
| target page lost | fail `page_lost` |
| tab closed | fail `page_lost`, cleanup capture |
| stale page identity | fail fast, no retry to other tab |
| explicit rebind | create new recorder session or clear previous capture |
| same page double lease | reject second lease |

Strict wrapper requirements:

- `sessionId + contextId + page targetId` is lease identity.
- All page-scoped commands include targetId.
- `capture/start`, `capture/read`, `exec`, and pre-verify actions validate lease.
- Rebind cannot mix previous A/B samples with new page.

## Capture Sample Protocol

A/B samples only yield ranking signal if traffic is produced inside each window with controlled seed values.

1. `capture/start(A)` opens the window and records seed evidence.
2. UI prompts the user to perform the target action, or Local Service runs the declared `trigger`.
3. `capture/read(A)` closes the window and freezes entries.
4. The B sample repeats the same trigger family, but seed args should differ.
5. If A/B seeds are identical or B is missing, only single-sample fallback is allowed, with `reviewRequired=true`.

`trigger` is one of `user_manual`, `navigate`, `dom_action_replay`. `requireDifferentSeedFrom` marks that sample B must not reuse sample A's seed values.

## Authentication Session Binding

The whole flow assumes a logged-in browser. Recorder binds to an existing login; it never collects, stores or replays credentials.

| Mode | Behavior |
| --- | --- |
| `bind_existing_page` | user selects an already logged-in tab |
| `create_page_await_user_login` | create page, user logs in manually, Local Service waits for confirmation |
| `bind_existing_context` | reuse an existing browser context/profile |

Rules:

- Session records `authBinding`: `{ mode, profileId, contextId, targetId, confirmedAt, authSignal }`.
- `authSignal` stores only redacted summaries: cookie presence, login redirect status, DOM probe boolean. Never cookie values.
- An optional `authCheck` (`probeUrl`, `expectedSignal`) confirms the bound page/context is logged in before capture.
- verify runner receives only the minimal `browser session/profile/contextId` config, never raw cookies.

## Request Registry

Request status:

```json
{
  "requestId": "req_...",
  "type": "analyze|init|verify|capture|rank",
  "status": "queued|running|succeeded|failed|timeout|cancelled",
  "startedAt": 0,
  "updatedAt": 0,
  "progress": { "stage": "execute", "message": "adapter_started" },
  "result": null,
  "error": null
}
```

Rules:

- Query is scoped to current UI session.
- Terminal status has TTL.
- Result is redacted and summary-only.
- Cancellation updates status and triggers infra cleanup.

## Crash Recovery And Startup Reap

The request registry is volatile. A Local Service restart must not leak orphan child processes or sensitive temp data.

| Concern | Behavior |
| --- | --- |
| status after restart | old request status is not guaranteed queryable; returns `request_not_found` |
| orphan runner child | killed during startup reap after pid/requestId verification |
| stale input.json / temp / trace | swept on startup, redacted warning only |
| incomplete init artifacts | resolved per the `07` write-transaction recovery table (rolled_back / roll-forward / quarantine) using the txn manifest + commit marker; only recorder-provenanced files are touched |

Rules:

- Each runner/temp request writes a minimal cleanup manifest: `requestId`, `localServiceRunId`, `pid`, `startedAt`, `tempRoot`, `operation`. The manifest never contains seed args or tokens.
- On startup the Local Service scans its own temp root, validates each directory owner/mode/realpath, and for entries carrying a runner marker verifies cmdline/requestId before graceful kill then force kill.
- Stale input/temp/trace files are deleted; cleanup failure logs a redacted warning only.
- When a manifest is expired or corrupt, temp data is deleted for safety, but a pid that cannot be verified is not killed.

## Daemon Commands

Local Service sends daemon HTTP requests with `X-byCLI: 1`.

Required actions:

| action | Use |
| --- | --- |
| `navigate` | open target URL, return page targetId |
| `network-capture-start` | start capture with pattern |
| `network-capture-read` | read entries |
| `exec` | DOM wait, probe, optional fallback interceptor |
| `tabs` / `bind` | list/select/bind tab |
| `cookies` | auth signal only; values redacted |
| `screenshot` | user confirmation |

## Concurrency Defaults

| Config | Default |
| --- | --- |
| `RECORDER_MAX_ACTIVE_SESSIONS` | 2 |
| `RECORDER_MAX_ACTIVE_PAGE_PER_PROFILE` | 1 |
| `RECORDER_MAX_CAPTURE_PER_SESSION` | 1 |
| `RECORDER_MAX_RANK_JOBS` | 2 |
| `RECORDER_QUEUE_LIMIT` | 10 |
| `RECORDER_TEMP_TTL_MS` | 3600000 |

Over limit returns 429 with `queue_full` or `profile_busy`.

## Concurrency Model

`MAX_ACTIVE_SESSIONS=2` and `MAX_ACTIVE_PAGE_PER_PROFILE=1` are not contradictory: the page limit is bucketed per `profileId`.

- Session concurrency is bounded globally by `RECORDER_MAX_ACTIVE_SESSIONS`.
- Page lease concurrency is bucketed per `profileId`; each profile allows one active page by default.
- Two sessions bound to different `profileId` can run in parallel.
- A second session on the same `profileId` over the limit returns `429` `profile_busy`, unless it explicitly enters the queue.
- The request registry records `profileId/contextId/targetId` for isolation and logging, and `queueReason` (`profile_busy`/`queue_full`) when queued.
