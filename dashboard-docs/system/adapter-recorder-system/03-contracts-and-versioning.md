# 03 · Contracts And Versioning

## Contract-First Rule

The first implementation PR must add machine-readable contracts for `/recorder/*`, `/v1/*`, error codes and request status. HTTP and Electron IPC use the same request/response types.

## Schema Versioning

| Contract | Version id |
| --- | --- |
| Recorder Local Service | `recorder.v1` |
| High-Level Service (optional standalone wrapper) | `high-level.v1` |
| Daemon High-Level Endpoints (`/v1/init`, `/v1/verify`) | `daemon-high-level.v1` |
| Shared schema bundle (error / domain / runner JSONL) | `adapter-recorder.bundle.v1` |

Compatibility policy:

| Change | Rule |
| --- | --- |
| Add optional field | Allowed in minor version with default behavior and contract test. |
| Add required field | Breaking unless compatibility fallback exists. |
| Delete field/change type/change meaning | Forbidden within same major. |
| Add error code | Allowed with caller action mapping. |
| Delete/reuse error code | Forbidden within same major. |
| HTTP/IPC divergence | Forbidden; both transports share schema source. |

## Recorder Local Service Contract

| Interface | Purpose | Side effect |
| --- | --- | --- |
| `GET /recorder/health` | Local Service, daemon, extension, high-level module health | none |
| `POST /recorder/session/bind` | Bind session/context/page or create new page | creates recorder session |
| `POST /recorder/session/confirm-auth` | Confirm user login; advance `awaiting_user_login` → `auth_confirmed` | updates session auth binding |
| `POST /recorder/navigate` | Validate URL and navigate real browser page | changes browser page |
| `POST /recorder/capture/start` | Start sample capture window | changes capture state |
| `POST /recorder/capture/read` | Read and close sample capture window | freezes entries |
| `POST /recorder/rank` | Normalize/rank/diff A/B samples into candidates | creates rank report |
| `POST /recorder/analyze` | Start high-level analyze | creates request |
| `POST /recorder/init` | Generate adapter draft | writes files |
| `POST /recorder/verify` | Start verify | creates runner request |
| `GET /recorder/requests/{requestId}` | Query request status/result | none |
| `POST /recorder/cancel` | Cancel request/capture | terminates work and cleans temp data |

Uniform response:

```json
{
  "ok": true,
  "schemaVersion": "recorder.v1",
  "requestId": "req_...",
  "data": {},
  "error": null
}
```

## High-Level Contract

There are **two distinct `/v1/*` families** (ADR-0007); do not conflate them:

1. **Optional standalone wrapper** (`high-level.openapi.yaml`, 07 · multi-client reuse) — the table below.
2. **Daemon high-level endpoints** (`daemon-high-level.openapi.yaml`, `POST /v1/init`, `POST /v1/verify`) — what `dashboard-be` actually forwards FS/subprocess capabilities to. `analyze` is browser-IO and goes over daemon `POST /command`, not a `/v1/*` route.

Optional standalone wrapper routes:

| Interface | Purpose |
| --- | --- |
| `POST /v1/browser/analyze` | collect browser signals and return `AnalyzeReport` |
| `POST /v1/adapters/init` | create adapter draft and recorder report |
| `POST /v1/adapters/verify` | start structured verify |
| `GET /v1/requests/{requestId}` | query analyze/init/verify status |

`verify` input uses `executionSeedArgs` for raw execution values. Reports/status may only expose `evidenceSeedArgs` or omit seed args.

Init inputs differ by transport on purpose: High-Level `InitInput` requires `domain`/`strategy` (the raw draft inputs); Recorder `InitRequest` is **select-only** — it requires `sessionId`/`writePolicy`/`selectedCandidateId` and **does not accept** `domain`/`strategy`/`endpoint`/`columns` (`additionalProperties:false`). The server derives those from the selected `RankCandidate` + recorder session before calling the High-Level module, so a client cannot contradict the chosen candidate (H-002 · preserves the `rank -> selectedCandidateId -> init` invariant).

**H-002 enum resolution (wire literals).** All transports MUST use one spelling, aligned to the landed implementation (`src/recorder/highlevel/{init,verify}.ts`) — there is no per-transport translation:

- `writePolicy` input: `dry-run | write` (hyphen, never `dry_run`).
- `verify` `fixture` input policy: `ignore | match | update` (the earlier `use`/`write` values were never given semantics in `07`/`08` and are rejected).
- `trace` input policy: `off | retain-on-failure | always`.
- The runner `fixture` *result* status stays `matched | updated | ignored` (08) — this is an output state, distinct from the input policy above.

## Request Status

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

- Query is scoped to current UI/session/token ownership.
- Result contains only redacted summaries: paths, counts, shape, fixture status, trace retained flag, error code/hint.
- Result shape is keyed by request `type` and validated by contract tests against the matching bundle `$defs`: `rank` → `RankCandidate[]`; `analyze` → `AnalyzeReport`; `init` → `RecorderReport` (returned **synchronously**, HTTP **200** not 202 — init is a short atomic FS write, not a long operation, so it has no request record / poll; verify+analyze stay 202+poll); `verify` → `VerifySummary`. `VerifySummary` is now a bundle `$def` (`adapter-recorder.bundle.json#/$defs/VerifySummary`) — the redacted, status-facing shape (`ok`, `stage?`, `rows?`, `fieldCount?` 〔field **count** only, never key names — M7c〕, `fixture?`, `trace.retained`, redacted `error`), distinct from the internal `RunnerResultEvent.data`; `normalizeRunnerResult` (recorder-core) produces it and applies the execute-stage redaction (message/hint withheld, code allow-listed). The generic `result: object|null` in OpenAPI is the envelope; the per-type schema is the binding contract.
- **Capture wire shape (Gap 2 fix):** `CaptureSample.entries` are **raw** `CaptureRawEntry` (a bundle `$def` mirroring the capture layer's `extension/src/cdp.ts` output), NOT the normalized `RecorderNetworkEntry` — normalization (+ `sourceCompleteness`) happens inside rank (`recorder-core/canonical.ts`). A recorder-core contract test pins `canonical.ts CANONICAL_SCORING_RAW_FIELDS ⊆ CaptureRawEntry.properties` so a capture-format rename fails loudly instead of silently degrading scoring.
- **TODO (M-003 · partially done).** The layer split is **done** (`VerifySummary` `$def` separate from `RunnerResultEvent`; verify runs the real M6 runner). Remaining: promote `RequestStatus.result` from the prose-bound generic `object` to a machine-enforceable per-type `oneOf` (`RankStatus`/`AnalyzeStatus`/`InitStatus`/`VerifyStatus`, each `type` const + typed `result`), and extract `$defs/RankResult` for the candidate array to avoid duplicating it across `recorder.openapi.yaml` and `high-level.openapi.yaml`. Do **not** type `ApiResponse.data` in the same pass (separate envelope-typing effort). Anchors: `#/$defs/{VerifySummary,RankResult}` + both OpenAPI `#/components/schemas/RequestStatus/properties/result`.
- No token, cookie, Authorization, raw `executionSeedArgs`, raw stdout/stderr, raw trace or full response body.
- Terminal status has short TTL; expired status returns `request_not_found`. Default terminal TTL is 30 minutes (`REQUEST_TERMINAL_STATUS_TTL_MS`); status carries `expiresAt` and a suggested `pollAfterMs` (default 1s). An optional `GET /requests/{id}?waitMs=...` long-poll is bounded by `REQUEST_LONG_POLL_MAX_MS`.

## Error Mapping

All errors — Recorder and High-Level alike — use the single shared `adapter-recorder.bundle.json#/$defs/Error` schema; High-Level does not define its own Error type. `error.details` is redacted diagnostic context only and is bound by the same redaction allowlist as status/report results (no token, cookie, raw seed args, raw stdout/stderr, body or full trace). This is a contract requirement enforced by redaction tests, not by JSON Schema alone.

| Domain/Runner error | HTTP status | `error.code` | Caller action |
| --- | --- | --- | --- |
| invalid input/state | 400 | `validation_failed` / `invalid_state` | show fixable prompt |
| auth/origin/csrf failed | 403 | `auth_failed` / `csrf_failed` | block and reopen trusted UI |
| target login/session required | 200 result or 500 | `auth_required` | prompt user to bind/login and recapture |
| responsible-use ack required (write) | 400 | `responsible_use_required` | prompt user to confirm responsible-use, then retry write |
| adapter/runner network failure | 500 or 503 | `network_error` | retry or check connectivity |
| insufficient A/B samples (`/recorder/rank`) | 400 | `insufficient_samples` | recapture sample |
| queue/concurrency exceeded | 429 | `queue_full` / `profile_busy` | queue or retry later |
| daemon/extension unavailable | 503 | `daemon_unavailable` / `extension_disconnected` | guide startup/reconnect |
| navigation forbidden | 400 | `navigation_url_forbidden` | reject URL |
| no redirect interception | 400 | `navigation_redirect_requires_interception` | block unknown redirect |
| verify runner timeout | 500 or 504 | `verify_timeout` | terminate child and show retry |
| analyze operation timeout | 500 or 504 | `analyze_timeout` | terminate in-process job and show retry |
| runner protocol violation | 500 | `runner_protocol_error` | show requestId and diagnostic |
| adapter failure | 500 | `adapter_runtime_error` | show adapter repair hint |
| page lease lost | 400 | `page_lost` | rebind page, no auto tab switch |
| DNS resolution failed | 400 | `dns_resolution_failed` | reject URL |
| request unknown/expired | 404 | `request_not_found` | restart request; status TTL expired |
| duplicate key, different payload | 409 | `idempotency_conflict` | reuse original requestId or change key |
| temp store full | 507 | `temp_store_full` | retry after cleanup or raise capacity |
| output shape/fixture mismatch | 200 result or 500 | `shape_mismatch` / `fixture_mismatch` | review adapter output vs expected |
| output truncated | 500 | `output_truncated` | raise stdout cap or reduce output |
| invalid config | 500 | `config_invalid` | startup: fix config and restart; hot reload: invalid reload is rejected and the previous snapshot stays active (see `09` Hot Reload) |
| disabled capability | 403 | `feature_disabled` | enable the feature flag and (for restart-only flags) restart; no implicit fallback |

## Idempotency

Side-effect POSTs (`/recorder/session/bind`, `/recorder/session/confirm-auth`, `/recorder/analyze`, `/recorder/init`, `/recorder/verify`, `/recorder/navigate`, `/recorder/capture/start`, `/recorder/capture/read`, `/recorder/rank`) accept an `Idempotency-Key` header or body `clientRequestId`.

- scope: `uiSessionId + endpoint + idempotencyKey`.
- same key, same payload hash: return the original `requestId`/result.
- same key, different payload hash: `409` `idempotency_conflict`.
- terminal idempotency records share or exceed the request status TTL.
- `session/bind` retried with the same key returns the original session rather than creating a duplicate session/page lease.
- `capture/read` retried with the same key returns the already-frozen capture result rather than re-closing the window or raising `invalid_state`.
- `session/confirm-auth` retried with the same key returns the already-confirmed result rather than raising `invalid_state` when the session has already advanced past `awaiting_user_login`.

`cancel` stays idempotent without a key.

Idempotency is enforced at the Recorder Local Service boundary. The High-Level `/v1/*` contract does not define its own idempotency keys; deduplication is the responsibility of the Recorder Local Service caller.

The two `RequestStatus` shapes are intentionally related as superset/subset: the Recorder (`recorder.v1`) status adds `profileId` and includes `capture` in `type` because capture is a `/recorder/*`-only concern; the High-Level (`high-level.v1`) status omits `profileId` and limits `type` to `analyze/init/verify`. Shared fields (`status`, `expiresAt`, `pollAfterMs`, `queueReason`, `error`) must stay identical.

## Schema Files

Schema drafts live under `schemas/`. Prose and schema must be updated together; contract tests must fail on drift.
