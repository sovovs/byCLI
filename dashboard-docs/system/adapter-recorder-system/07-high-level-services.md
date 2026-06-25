# 07 · High-Level Services

## Purpose

High-Level Services turn existing CLI logic into reusable service modules for `analyze`, `init` and `verify`.

**Hosting (M5 落地后明确).** "In-process import" applies to the **main-repo same-process Local Service form** (CLI / daemon, which can `import` these modules directly). `dashboard-be` is a **separate ESM process** bound by the rule "do not import main-repo `src/`", so it cannot use in-process import — it reaches high-level capability across the daemon HTTP boundary. The hosting then splits by capability boundary (see `02` + ADR-0007 `daemon-high-level-hosting`):

| Capability | IO kind | Hosting |
| --- | --- | --- |
| `analyze` | browser (Page multi-step) | `dashboard-be` orchestrates via the existing daemon `POST /command` (navigate + exec probe + cookies + capture-read) → calls the **pure** `analyzeSite` (in `packages/recorder-core`). daemon stays a thin proxy. |
| `init` | filesystem (write transaction) | daemon high-level endpoint `POST /v1/init` → main-repo `createAdapterDraft`. `dashboard-be` only forwards. |
| `verify` | child-process runner | daemon high-level endpoint `POST /v1/verify` → main-repo `verifyAdapter` → `RunnerPort` (M6 child process). `dashboard-be` only forwards. |

Pure deterministic sub-pieces (analyzeSite, init template/validation, verify seedArgs-HMAC / runner-event parsing) are extracted to the shared package `@sovovs/bycli-recorder-core`, imported by both main repo and `dashboard-be`. The optional HTTP wrapper (below) remains a multi-client-reuse option, distinct from the daemon `/v1/*` high-level endpoints.

## Ownership

| Capability | Owner |
| --- | --- |
| navigate / exec / network capture | daemon browser bridge |
| site pattern / anti-bot analyze | High-Level analyze module |
| adapter scaffold/draft | High-Level init module |
| adapter verify | High-Level verify module + runner |

## Module-First Design

High-Level service collection should reuse Page abstraction and service functions, not rebuild raw `/command` sequences. Analyze needs multi-step Page behavior: capture, goto, wait, read capture, probe JS, cookies and report assembly.

## `analyzeBrowser(input)`

Input:

```json
{
  "url": "https://example.com/search",
  "session": "adapter-recorder-demo",
  "contextId": "default",
  "settleMs": 2000
}
```

Output:

```json
{
  "pattern": { "pattern": "A", "json_responses": 8 },
  "anti_bot": { "detected": false },
  "recommended_next_step": "Use network capture and endpoint ranker."
}
```

This is site-level analysis, not endpoint ranking.

### Analyze Execution Model

`analyze` is an in-process async high-level request, not a runner child process.

- It runs inside the High-Level Application Service using the Page abstraction and daemon/browser ports.
- It never executes user adapter JS, so it does not require child-process isolation (unlike `verify`).
- Concurrency is bounded by `ANALYZE_MAX_CONCURRENCY`; per-request deadline is `ANALYZE_TIMEOUT_MS`, both managed by the High-Level Application Service.
- Timeout surfaces as `analyze_timeout` (long-running operation timeout), not a runner protocol error.
- `08-runner-and-isolation.md` covers only `verify`. If analyze ever needs a child process, that requires a new ADR (`Analyze Runner Isolation`) defining why, the JSONL contract reuse and how it differs from the verify runner.

## `createAdapterDraft(input)`

Input includes name, domain, strategy, browser flag, args, endpoint, columns, report and write policy.

Rules:

- `name` must be `site/command`.
- name parts match `[a-zA-Z0-9_-]+`.
- `writePolicy` is `dry-run | write` (hyphen wire literal — H-002 enum resolution, see `03`); default `dry-run`.
- write path must be allowlisted workspace/user adapter path.
- packaged adapter shadow/overwrite check is mandatory.
- output uses template functions, not raw user code injection.
- write is atomic and may provide dry-run diff.

Output:

```json
{
  "adapterPath": "~/.bycli/clis/demo/search.js",
  "reportPath": "~/.bycli/sites/demo/recorder/search-report.json",
  "warnings": ["sign field marked dynamic; verify required"],
  "responsibleUseAcknowledgedAt": 0,
  "releaseChannel": "stable",
  "localExperimentProfile": "off",
  "configSnapshotVersion": 1
}
```

`responsibleUseAcknowledgedAt` is required when `writePolicy=write` (see ADR 0005). Site-level `analyzeBrowser` reports do not carry it; it belongs to the write-time recorder report. `releaseChannel`, `localExperimentProfile` and `configSnapshotVersion` are always present: they are injected from the active config snapshot (see `09`) so every `RecorderReport` records which profile/channel and config version produced it. They are required by the `RecorderReport` schema.

### Write transaction and crash recovery

`createAdapterDraft` produces two persistent artifacts (adapter file + recorder report). With no DB and possibly cross-directory paths, a plain "atomic write" of each file is not enough: a crash between the two renames can leave an adapter with no provenance. The write is therefore a mini-transaction:

1. Generate a `txnId`; write a transaction manifest under recorder temp/state with `txnId/requestId/idempotencyKey/adapterPath/reportPath/adapterSha256/reportSha256/state=preparing/createdAt`.
2. Render adapter content with a minimal non-sensitive provenance header embedded: `generatedBy=adapter-recorder`, `txnId`, `reportPath`, `reportSha256`.
3. Write report to temp, fsync file, rename to final `reportPath`, fsync report parent dir.
4. Write adapter to temp, fsync file, rename to final `adapterPath`, fsync adapter parent dir. (Report is committed **before** adapter so a visible adapter always has provenance.)
5. Write a commit marker to temp (`txnId`, both paths, both hashes, `committedAt`), fsync, rename to final marker, fsync marker parent dir.
6. Mark the manifest `committed` (retained as audit/reap index).

Startup recovery (extends the reap in `05`) acts only on manifest-referenced paths or files carrying the recorder provenance header; unknown user-authored files are never silently deleted:

| Observed state | Action |
| --- | --- |
| report exists, adapter missing, no marker | drop/retain orphan report; transaction `rolled_back` |
| report + adapter exist, hashes match, no marker | roll-forward: write the marker (provenance already complete) |
| adapter exists, report missing | quarantine the adapter (high-risk; never leave an unprovenanced adapter live) |
| marker exists but hash/path mismatch | quarantine, return a stable diagnostic |
| no report, no adapter, manifest `preparing` | clean up; transaction `rolled_back` |
| marker exists, both hashes match, manifest still `preparing` | mark manifest `committed` (commit succeeded before the manifest update) |

The embedded adapter provenance header lets recovery identify a recorder-generated adapter even if its report dir was deleted, so it can be safely quarantined rather than treated as an unknown file.

## `verifyAdapter(input)`

Input:

```json
{
  "name": "demo/search",
  "executionSeedArgs": { "keyword": "张三" },
  "fixture": "ignore",
  "trace": "retain-on-failure"
}
```

Rules:

- Raw `executionSeedArgs` exists only in memory and private input.json.
- `fixture` policy is `ignore | match | update` (H-002 enum resolution, see `03`); default `ignore`. `trace` is `off | retain-on-failure | always`; default `retain-on-failure`.
- `evidenceSeedArgs` is derived immediately with a session-keyed HMAC. The session key is a per-session random salt held only in daemon process memory (M7a `SessionKeyRegistry`) — never on the wire, rotated on daemon restart, TTL-evicted; the Local Service forwards only the non-secret `sessionId`.
- verify adapter execution happens in child process, never API main process.
- result is structured + redacted (status-facing `VerifySummary`): `rows`, `fieldCount` (count only, never key names — M7c), `fixture`, `trace.retained`, redacted error classification.

## Request Status

High-Level modules expose `getRequestStatus(requestId)` and optional HTTP `GET /v1/requests/{requestId}`.

Status values:

```
queued -> running -> succeeded | failed | timeout | cancelled
```

Result is summary-only. It never returns raw execution seed args, raw stdout/stderr, raw trace, tokens or cookies.

## Optional HTTP Wrapper

**Implemented (M9a/b/c) — `src/recorder/http/`.** Opt-in via `bycli internal highlevel-http` (a `main.ts` fast-path that skips adapter discovery and binds the server instead of running the CLI); default off. Lives main-repo side (it calls the high-level modules in-process; `dashboard-be` cannot be imported and conversely). It is a **separate process and a separate `/v1/*` route family** from the daemon high-level endpoints (`daemon-high-level.openapi.yaml`, `daemon-high-level.v1`) — ADR-0007; the two are never conflated.

If enabled:

- listen on `127.0.0.1` (host pinned; non-loopback override rejected fail-closed)
- require `X-byCLI: 1`
- require startup random `X-byCLI-Token` (the secret tier above the daemon's presence-only `X-byCLI`)
- Origin allowlist
- no CORS
- body limit
- structured errors (finish-logger + metrics carry only `operation/status/errorCode/durationMs`, never token/body/seed)
- `/health` (gated)
- `/v1/browser/analyze`
- `/v1/adapters/init`
- `/v1/adapters/verify`
- `/v1/requests/{requestId}`
- `/metrics` (gated; operational snapshot, M8 follow-up — beyond the OpenAPI contract)

Recorder UI still does not call this wrapper directly.

**As-built lifecycle / async model.** All three POSTs are uniform **202 + canonical `requestId`** into the wrapper's own in-memory request registry (the daemon runner registry is verify-only with no `type`/timestamps, and analyze/init have no daemon registry, so the wrapper owns `RequestStatus`):

- **init** is synchronous (`createAdapterDraft`), finalized inline (still 202; result queryable on first poll).
- **verify** delegates `verifyAdapter` → `defaultRunnerPort` (child-process runner; browser adapters connect back to the daemon for a Page via `BYCLI_DAEMON_PORT`). The session HMAC key comes from `defaultSessionKeyRegistry().keyFor(sessionId)`. The record is finalized **in the background on runner-settle** (`whenSettled`), independent of polling, so an abandoned verify never sticks at `running` or leaks; `GET status` also projects the runner's live `getRunStatus` and finalizes summary-only on terminal. Raw `executionSeedArgs` stay in the runner's `input.json` only — never in the registry/202/log.
- **analyze** returns 202 immediately, then a background daemon-backed `Page` (M6b connect-back, not via `BrowserBridge`) runs `analyzeBrowserWithTimeout` → finalize report / `analyze_timeout` (504, status `timeout`) / `daemon_unavailable` (503); the tab lease is released in `finally`.
- Terminal records carry a TTL (expired → 404 `request_not_found`) and are reclaimed by a periodic sweep in addition to delete-on-access.
- `queue_full` from the runner is surfaced as 202-then-failed (uniform async shape), not a synchronous 429 (that is the daemon `/v1/verify` contract).

**Reuse / drift (Q2, Codex-reviewed).** `safeEqual`/`randomToken` (pure crypto) and the `ErrorCode` union/`RecorderError` (contract mirror) live in `recorder-core`; `dashboard-be` and the wrapper both consume that single source. The `ErrorCode → HTTP status` map stays per-transport (be `envelope.ts` + wrapper `wrapper-envelope.ts`), and the gate chain (HTTP-typed, `IncomingMessage`) is copy-ported into `wrapper-gates.ts` (CSRF dropped — no browser UI calls the wrapper).

## Contract Tests

Required:

- analyze happy path and daemon unavailable
- init path/name validation and overwrite/shadow check
- verify auth_required, timeout, adapter_runtime_error, shape_mismatch, runner_protocol_error
- request status ownership and TTL expiry
- executionSeedArgs never appears in status/report/log fixtures
