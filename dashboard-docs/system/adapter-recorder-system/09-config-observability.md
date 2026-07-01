# 09 · Config And Observability

## Config Principles

- All runtime config is loaded through config schema objects.
- Business code does not read `process.env` directly.
- Invalid config fails fast with `config_invalid`.
- Defaults, ranges and env overrides are tested.
- New config keys must be added to schema and tests before use.

Config schemas (`RecorderConfig`, `HighLevelConfig`, `ScoringProfile`, Feature Flags) are machine-readable objects owned by `ConfigPort` and declared in code as the single source of truth (e.g. zod/JSON-Schema validators co-located with the config loader, exported as `schemas/config/*` at build). They are intentionally **not** part of `adapter-recorder.bundle.json`: the bundle is the cross-process wire contract (request/response/event payloads), while config is process-local startup state never sent over the wire. The config-schema tests in `10` are the CI gate that prevents key/default/range drift between this chapter's tables and the validators.

## Data Persistence Boundary

This system has no persistent database (TDD 8.1 DB schema conventions are N/A). State integrity is instead provided by: in-memory request registry with TTL, 0600 temp store with TTL + capacity watermark, atomic writes, and startup reap of orphan runners / stale temp. There are no `id/create_time/update_time/version` rows because request registry and temp execution state are not persisted as DB rows; the registry is volatile and terminal request status expires to `request_not_found`. Redacted reports written to disk (e.g. recorder report / adapter draft paths in `01`/`07`) are intentional file artifacts under the existing redaction policy, not a transactional datastore.

## RecorderConfig

| Config | Type / range | Default | Error |
| --- | --- | --- | --- |
| `LOG_LEVEL` | enum `error/warn/info/debug` | `info` | `config_invalid` |
| `RECORDER_MAX_ACTIVE_SESSIONS` | int, 1-10 | 2 | `config_invalid` |
| `RECORDER_MAX_ACTIVE_PAGE_PER_PROFILE` | int, 1-5 | 1 | `config_invalid` |
| `RECORDER_MAX_CAPTURE_PER_SESSION` | int, 1 | 1 | `config_invalid` |
| `RECORDER_MAX_RANK_JOBS` | int, 1-CPU count | 2 | `config_invalid` |
| `RECORDER_QUEUE_LIMIT` | int, 0-1000 | 10 | `config_invalid` |
| `RECORDER_TEMP_TTL_MS` | int, 60000-86400000 | 3600000 | `config_invalid` |
| `RECORDER_STARTUP_REAP_MAX_AGE_MS` | int, 60000-86400000 | 86400000 | `config_invalid` |
| `RECORDER_ORPHAN_KILL_GRACE_MS` | int, 100-30000 | 1500 | `config_invalid` |
| `REQUEST_TERMINAL_STATUS_TTL_MS` | int, 60000-86400000 | 1800000 | `config_invalid` |
| `REQUEST_POLL_AFTER_MS` | int, 250-10000 | 1000 | `config_invalid` |
| `REQUEST_LONG_POLL_MAX_MS` | int, 0-30000 | 15000 | `config_invalid` |
| `RECORDER_TEMP_MAX_BYTES` | int, 10485760-10737418240 | 536870912 | `config_invalid` |
| `RECORDER_TRACE_MAX_BYTES_PER_REQUEST` | int, 1048576-1073741824 | 52428800 | `config_invalid` |
| `RECORDER_TEMP_HIGH_WATERMARK_RATIO` | number, 0.5-0.95 | 0.8 | `config_invalid` |
| `RECORDER_TEMP_LOW_WATERMARK_RATIO` | number, 0.1-0.9 | 0.6 | `config_invalid` |

## ScoringProfile

The ranker reads all score values from a validated `ScoringProfile`, never from inline code constants. The defaults below match the table in `06`.

| Config | Default | Range |
| --- | --- | --- |
| `RANK_SCORE_STABLE_JSON_SHAPE_DELTA` | 25 | int -1000..1000 |
| `RANK_SCORE_SEED_ARG_PARAM_DELTA` | 20 | int -1000..1000 |
| `RANK_SCORE_RESPONSE_ECHO_DELTA` | 10 | int -1000..1000 |
| `RANK_SCORE_REQUIRES_SESSION_DELTA` | 5 | int -1000..1000 |
| `RANK_SCORE_DYNAMIC_FIELD_DELTA` | -10 | int -1000..1000 |
| `RANK_SCORE_HTML_STATIC_ANALYTICS_DELTA` | -25 | int -1000..1000 |
| `RANK_SCORE_SUSPECTED_MUTATION_DELTA` | -100 | int -1000..1000 |
| `RANK_SCORE_HIGH_MIN` | 70 | int 0..1000 |
| `RANK_SCORE_MEDIUM_MIN` | 45 | int 0..1000 |
| `RANK_SCORE_LOW_MIN` | 20 | int 0..1000 |

Validation: deltas are integers in `-1000..1000`; bands are integers in `0..1000` and must satisfy `HIGH_MIN > MEDIUM_MIN > LOW_MIN`; any out-of-range value or band-order violation is `config_invalid`. Hard rejects (mutation, unparseable URL, missing method, static resource, …) override ScoringProfile and are NOT configurable — they are security/domain invariants.

`RANK_SCORE_HTML_STATIC_ANALYTICS_DELTA` applies only to the *weak/suspected* HTML/static-like signal (see `06`); a **confirmed** static resource or third-party analytics endpoint is a hard reject and never routes through this configurable delta.

**Default-profile band ceiling (v1, non-stacking).** Each positive signal contributes its delta **at most once per candidate** (boolean, not per-occurrence — the dashboard-be LLM scorer additionally deduplicates repeated signal names before summing). The default positive deltas sum to at most `25+20+10+5 = 60`, which is above the default `RANK_SCORE_MEDIUM_MIN = 45` but below the default `RANK_SCORE_HIGH_MIN = 70`. So under the **default** ScoringProfile, the pure-core rank track alone caps a strong read endpoint at `medium`. `high` is reachable in the dashboard-be **dual-track** path (deterministic rule score + a capped semantic bonus, max +25, from the LLM's semanticSignals — see 06/13), or via a custom/operator-tuned ScoringProfile (lower `HIGH_MIN` / higher deltas). Pure-core fixtures must not assume default-profile `high`.

## HighLevelConfig

| Config | Type / range | Default | Error |
| --- | --- | --- | --- |
| `VERIFY_RUNNER_MAX_CONCURRENCY` | int, 1-CPU count | 2 | `config_invalid` |
| `ANALYZE_MAX_CONCURRENCY` | int, 1-CPU count | 2 | `config_invalid` |
| `ANALYZE_TIMEOUT_MS` | int, 1000-600000 | 30000 | `config_invalid` |
| `HIGH_LEVEL_QUEUE_LIMIT` | int, 0-1000 | 10 | `config_invalid` |
| `VERIFY_RUNNER_STDOUT_LIMIT_BYTES` | int, 1024-16777216 | 1048576 | `config_invalid` |
| `VERIFY_RUNNER_STDERR_LIMIT_BYTES` | int, 1024-1048576 | 65536 | `config_invalid` |
| `VERIFY_RUNNER_JSONL_LINE_LIMIT` | int, 1024-1048576 | 65536 | `config_invalid` |
| `VERIFY_RUNNER_TIMEOUT_MS` | int, 1000-600000 | 30000 | `config_invalid` |
| `VERIFY_RUNNER_KILL_GRACE_MS` | int, 100-30000 | 1500 | `config_invalid` |

## RequestId Propagation

`requestId` must be created at Local Service boundary and propagated through:

```
UI event
  -> Recorder Local Service request registry
  -> daemon client command id mapping
  -> high-level service call
  -> verify runner process args
  -> JSONL events
  -> logs and redacted report
```

Daemon command ids can be separate, but logs must include both when mapping exists.

## Structured Logging

Allowed log fields:

| Field | Example |
| --- | --- |
| `requestId` | `req_abc` |
| `sessionId` | `rec_abc` |
| `contextId` | `default` |
| `operation` | `recorder.verify` |
| `stage` | `execute` |
| `status` | `failed` |
| `errorCode` | `verify_timeout` |
| `durationMs` | `30000` |
| `queueDepth` | `2` |

Forbidden log fields:

- token
- cookie
- Authorization
- raw request/response body
- raw `executionSeedArgs`
- raw stdout/stderr full content
- full trace path if it reveals private data

## Redaction

Redaction happens before report/cache/log writes.

| Data | Stored form |
| --- | --- |
| seed args | placeholder/type/length/HMAC |
| request headers | key/presence/sensitive class |
| request body | key/type/HMAC/length |
| response body | shape/item keys/count/redacted summary |
| stderr diagnostic | capped preview, redacted |
| trace | retain-on-failure by default, TTL cleanup |

## Metrics

Minimum counters/histograms:

- requests by type/status/errorCode (`errorCode` values are restricted to `adapter-recorder.bundle.json#/$defs/ErrorCode`)
- queue depth and queue rejected count
- verify duration
- runner timeout count
- capture entries count
- rank confidence distribution
- redaction dropped field count
- navigation forbidden count by reason
- idempotency conflict count
- temp store pressure events and `temp_store_full` count
- startup reap count (orphan runners killed, temp dirs swept)
- await-login duration

Metrics must not contain sensitive values.

**Wiring status (M10, 2026-06-25).** The counter/histogram registry is a single IO-free implementation in `recorder-core` (`createMetrics`/`createLogger`), re-exported by every transport so there is no copy drift. All three surfaces are wired at a single request-completion choke point (operation/status/errorCode + duration only — never headers/token/body): **dashboard-be** (`recorder_requests_total` + `recorder_request_duration_ms`), the optional **High-Level wrapper** (`highlevel_requests_total` + `highlevel_request_duration_ms`, gated `GET /metrics`), and the **daemon + verify runner** (`daemon_requests_total` + `daemon_verify_duration_ms`, `runner_verify_total`/`runner_timeout_total`/`runner_protocol_error_total`/`runner_queue_depth`/`runner_queue_rejected_total` + startup-reap/temp-sweep/session-key counters, exposed at the daemon's loopback `GET /metrics`). The daemon shares its `metrics`/`logger` singletons into the runner via `setDefaultRunnerObservability` so runner counters surface on the same scrape. Daemon `LOG_LEVEL` is read once at startup (no daemon-side `ConfigPort` hot reload yet — a separate follow-up).

## Log Level Control

Log level is runtime-adjustable without restart (TDD 9.1). The level comes from the `LOG_LEVEL` config key (default `info`, see RecorderConfig); an operator can change it at runtime via a signal (e.g. SIGUSR2) or a loopback-only admin toggle. The admin toggle, if exposed, is subject to the same Origin/header/token gates as other local endpoints (see `04`). Level changes are logged and never alter the redaction allowlist — sensitive fields stay filtered at every level.

## Feature Flags And Hot Reload

### Feature Flags

Local config flags (no remote flag service); schema-validated; default fail-closed. High-risk flags never bypass security/redaction/responsible-use gates; a disabled capability returns a stable rejection (`feature_disabled`, see `03` Error Mapping), with no implicit fallback.

| Config | Type / range | Default | Error | Reload |
| --- | --- | --- | --- | --- |
| `FEATURE_DIRECT_CDP_CAPTURE` | bool | false | `config_invalid` | restart (exposes new capture surface) |
| `FEATURE_LOCALHOST_HTTP_UI` | bool | false | `config_invalid` | restart (changes endpoint surface) |
| `FEATURE_ADMIN_LOG_LEVEL_TOGGLE` | bool | false | `config_invalid` | restart (exposes new local endpoint) |
| `FEATURE_PREVIEW_SCORING_PROFILE` | bool | false | `config_invalid` | hot (new `/recorder/rank` only) |
| `RELEASE_CHANNEL` | enum `stable\|preview` | stable | `config_invalid` | hot (new sessions/rank jobs only) |
| `LOCAL_EXPERIMENT_PROFILE` | enum `off\|control\|candidate` | off | `config_invalid` | hot (new sessions/rank jobs only) |

Flags that expose a new local endpoint or capability surface (`FEATURE_DIRECT_CDP_CAPTURE`, `FEATURE_LOCALHOST_HTTP_UI`, `FEATURE_ADMIN_LOG_LEVEL_TOGGLE`) are restart-only and can never be widened by hot reload — this is a security boundary, not a convenience choice.

**Wiring status (留尾 #5).** The restart-only pin above holds for all three regardless of consumer state:
- `FEATURE_LOCALHOST_HTTP_UI` — **wired**: master switch for dashboard-be same-origin UI hosting (`server.ts` `createApp` `staticServer`). `UI_DIST` alone no longer enables hosting; the flag gates it (off → no listener-served UI, falls to `request_not_found`).
- `FEATURE_ADMIN_LOG_LEVEL_TOGGLE` — **wired**: gates the loopback admin endpoint `POST /recorder/admin/log-level` (full Origin/header/token/CSRF gate chain; off → endpoint absent / `request_not_found`). Complements the SIGUSR2/SIGHUP runtime level paths.
- `FEATURE_DIRECT_CDP_CAPTURE` — **reserved, no consumer**: the direct-CDP capture surface it would gate does not exist (capture is hardwired through the daemon network-capture path + interceptor fallback). The flag stays schema-validated, restart-only pinned and fail-closed (default false → exposes nothing). Wire a consumer only when that capture surface is actually designed — that is a feature, not flag wiring.

`FEATURE_PREVIEW_SCORING_PROFILE` gates only whether a *candidate/preview* `ScoringProfile` may be applied; it does not control the always-on externalization of the default `ScoringProfile`. With the flag `false`, the ranker still reads every score from the default profile (never inline constants) — it simply cannot load a preview profile.

### Hot Reload Policy

`ConfigPort.reload()` reads full config, validates it, then atomically swaps a versioned snapshot. In-flight requests keep their old snapshot; new requests use the new one. `LOG_LEVEL` is the one explicit exception: it applies process-globally and immediately (including to in-flight requests' log output), since it controls only log verbosity and never the redaction allowlist. A failed reload keeps the old config and logs `config_invalid`. The redaction allowlist and security boundaries can never be widened by hot reload.

| Hot-reloadable | Restart required |
| --- | --- |
| `LOG_LEVEL` (applies immediately, process-global) | listener / bind address |
| `ScoringProfile` (new `/recorder/rank` only) | Electron vs localhost-HTTP UI mode |
| queue / concurrency limits (new requests) | token ownership / endpoint surface |
| analyze/verify timeout & stdout caps (new jobs) | startup reap policy |
| temp watermarks (next sweep) | filesystem temp root; flags that expose new local endpoints |

### Local Rollout / Experiment Policy

Cloud-style percentage rollout and population A/B testing are **N/A** for this single-user local tool (no multi-tenant traffic, no user cohorts, no server-side rollout %). The local equivalent is an explicit `RELEASE_CHANNEL` plus `LOCAL_EXPERIMENT_PROFILE`: no remote assignment, no telemetry cohorting, no silent bucketing. A candidate profile applies only to new sessions / rank jobs and must be visible in log and report metadata.
