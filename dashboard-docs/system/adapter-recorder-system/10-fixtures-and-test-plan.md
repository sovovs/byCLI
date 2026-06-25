# 10 · Fixtures And Test Plan

## Coverage Gate

Core domain/service modules target >= 80% unit test coverage. This applies to URL policy, canonical mapper, ranker, request registry, config parser, JSONL parser and seedArgs HMAC logic.

## Ranker Fixture Corpus

Each fixture includes A/B samples, seedArg placeholders, raw entries, canonical entries and expected result.

Fixture expected results must not assert on `evidenceSeedArgs.hmac` values (they are per-session and not comparable across runs); use a matcher like `anySessionHmac` or compare only placeholder/type/length/arg name.

| Fixture | Expected |
| --- | --- |
| `search-get-json-list` | low band (score 45) under default profile, GET endpoint, query arg mapping |
| `search-post-json-read` | manual review POST read-like endpoint |
| `signed-timestamp-endpoint` | timestamp/nonce excluded, unexplained sign risk |
| `cursor-pagination` | search args separated from cursor |
| `auth-redirect` | no endpoint, auth/login risk |
| `mutation-post` | hard reject mutation |
| `analytics-noise` | tracking rejected |
| `missing-request-body` | no body args inferred, max medium |
| `pairing-failed-single-sample` | low confidence single-sample candidate |
| `insufficient-samples` | `/recorder/rank` returns HTTP 400, `ApiResponse.ok=false`, `error.code=insufficient_samples`, no `RankCandidate[]` produced |

Assertions:

- candidate id (present, stable, unique within result, usable as `InitRequest.selectedCandidateId`)
- candidate endpoint
- args mapping
- excluded params
- score band
- reviewRequired
- rejected reasons
- scoreExplanation signal keys

Schema validation:

- Each candidate in a success fixture's `RankCandidate[]` result must validate against `adapter-recorder.bundle.json#/$defs/RankCandidate`, including the nested `endpoint` (`$defs/EndpointDescriptor`), `args` (`$defs/ArgMapping[]`) and `responseShape` (`$defs/ResponseShape`) — a bare/free-form endpoint or args object fails validation.
- Each error fixture's `ApiResponse.error` must validate against `#/$defs/Error`, with `error.code` in `#/$defs/ErrorCode`.

## Navigation URL Matrix

| Case | Example | Expected |
| --- | --- | --- |
| localhost trailing dot | `http://localhost.:3000` | `navigation_url_forbidden` |
| IPv4 decimal | `http://2130706433/` | forbidden |
| IPv4 octal/hex/mixed | `http://0177.0.0.1/`, `http://0x7f.0.0.1/`, `http://127.1/` | forbidden |
| IPv4-mapped IPv6 | `http://[::ffff:127.0.0.1]/` | forbidden |
| private/link-local | `10.0.0.1`, `192.168.1.1`, `169.254.1.1` | forbidden |
| cloud metadata | `169.254.169.254`, `[fd00:ec2::254]` | forbidden |
| IDN/punycode | Unicode hostname | canonical host checked |
| DNS resolves private | public hostname -> private A/AAAA | forbidden |
| CNAME to private | CNAME chain -> private A/AAAA | forbidden |
| redirect to private/metadata | public URL -> 302 private/metadata | blocked before request |
| redirect observation only | final URL only after navigation | fails MVP |

## Contract Tests

Recorder contract:

- health success and daemon unavailable
- session bind invalid context
- session bind auth modes (`bind_existing_page` / `create_page_await_user_login` / `bind_existing_context`) and `authCheck` signal
- navigate forbidden URL
- capture invalid state
- capture sample protocol: A/B trigger required, B seed must differ, single-sample fallback `reviewRequired`
- idempotency: same key+payload returns original requestId; same key, different payload returns `idempotency_conflict`
- `session/bind` retried with same key returns the original session, not a duplicate session/page lease
- `capture/read` retried with same key returns the already-frozen result, not `invalid_state` or a re-closed window
- `session/confirm-auth` retried with same key returns the already-confirmed result, not `invalid_state` after the session advanced past `awaiting_user_login`
- `init` rejects a request missing `selectedCandidateId` (schema-required; the `ranked -> draft_created` transition must name a candidate)
- same-session concurrent transition: two state-mutating calls on one `sessionId` (e.g. `navigate` + `capture/start`, double `capture/start`, `rank` + `cancel`) linearize — exactly one advances `stateVersion`, the loser gets `invalid_state`/`queue_full`, never a double-advance; a different idempotency key does not bypass serialization
- request status ownership
- terminal status TTL/`expiresAt`/`pollAfterMs`; expired returns `request_not_found`
- crash recovery: status not queryable after restart; orphan runner/temp reaped on startup
- init write-transaction recovery: report-only (no marker) → rolled_back; report+adapter+matching hashes (no marker) → roll-forward writes marker; adapter-only (report missing) → quarantined, not deleted; marker hash/path mismatch → quarantined; user-authored non-provenanced files are never touched
- cancel idempotency
- error schema examples validate against `adapter-recorder.bundle.json#/$defs/Error` (and `#/$defs/ErrorCode`)

High-Level contract:

- analyze happy path
- init happy path validates the result against `RecorderReport`, including required `releaseChannel`/`localExperimentProfile`/`configSnapshotVersion`
- enum drift guard (H-002): `writePolicy:'dry-run'` and `fixture:'match'` are accepted; the stale literals `writePolicy:'dry_run'`, `fixture:'use'`, `fixture:'write'` are rejected with `validation_failed` across recorder + high-level schemas
- `InitInput.endpoint` validates against the same `adapter-recorder.bundle.json#/$defs/EndpointDescriptor` as `RankCandidate.endpoint` (no divergent endpoint shape between rank output and init input)
- init invalid adapter name
- init overwrite/shadow check
- verify auth_required
- verify timeout
- verify runner_protocol_error
- request status TTL expiry
- executionSeedArgs not returned

## Security Tests

- malicious cross-origin page rejected
- OPTIONS preflight does not enable custom headers
- renderer cannot access daemon/high-level token
- CSP blocks inline/eval/remote script
- window.open denied
- permission requests denied
- input.json parent/file permissions checked
- Windows ACL / reparse-point file permission policy (per-platform)
- temp store pressure: over high watermark evicts expired then LRU trace; over capacity returns `temp_store_full`; per-request trace cap truncates
- auth binding does not collect/log credentials; only redacted `authSignal` persisted
- responsible-use: `init` requires authorization confirmation; report records `responsibleUseAcknowledgedAt`
- logs do not contain token/cookie/Authorization/raw executionSeedArgs

## Dependency Tests

Use dependency boundary tooling to assert:

- UI does not import daemon client or high-level token providers.
- Domain engine does not import HTTP/Electron/filesystem/daemon runner.
- HTTP wrapper does not contain business logic.
- No circular dependency across adapter/application/domain/infra.

Dependency hygiene (matches `00` dependency-hygiene gate):

- A committed lockfile pins exact dependency versions.
- Core shared dependencies use a single unified version (no duplicate/conflicting copies).
- CI flags redundant or conflicting transitive dependencies.

## Config Tests

For `RecorderConfig`, `HighLevelConfig`, `ScoringProfile` and `FeatureFlags`:

- default values
- env overrides
- invalid type
- out-of-range value
- unknown key policy
- `config_invalid` error mapping
- `LOG_LEVEL` parses the `error/warn/info/debug` enum, defaults to `info`, and rejects invalid values with `config_invalid`
- `ScoringProfile`: default values, invalid delta type, band order violation (`HIGH_MIN > MEDIUM_MIN > LOW_MIN`) rejected with `config_invalid`
- fixture corpus passes under the default `ScoringProfile`

## Feature Flags And Hot Reload Tests

- feature flag parser: enum/default values, invalid value rejected with `config_invalid`
- unknown feature flag key is rejected (`config_invalid`), never silently ignored
- a missing feature flag falls back to its fail-closed default (`false`/`off`), not enabled
- disabled feature fails closed (stable `feature_disabled` rejection, no implicit fallback)
- reload parse failure keeps the old snapshot and leaves the capability disabled (never enables on a bad reload)
- a flag that would expose a new local endpoint requires restart, not hot reload
- hot reload: valid config swaps snapshot atomically; invalid config keeps old snapshot and logs `config_invalid`
- `ScoringProfile` reload applies only to new `/recorder/rank` requests, not in-flight ones
- hot reload cannot widen the redaction allowlist or security boundaries
- local rollout: `RELEASE_CHANNEL`/`LOCAL_EXPERIMENT_PROFILE` parse; candidate profile is recorded in log/report metadata; no telemetry cohorting

## Runner Tests

JSONL events validate against `adapter-recorder.bundle.json#/$defs/RunnerEvent` (and `RunnerStartedEvent`/`RunnerProgressEvent`/`RunnerResultEvent`); `error.code` must be in `#/$defs/ErrorCode`.

- valid JSONL result
- malformed line
- oversize line
- wrong requestId
- unknown event type
- duplicate result
- stdout/stderr cap
- timeout graceful kill then force kill
- cancel cleanup
- input.json cleanup failure warning does not overwrite original result

## CI Commands

The exact commands depend on implementation tooling, but CI must include:

- typecheck
- lint
- unit tests with coverage gate
- contract tests
- dependency boundary checks
- dependency hygiene checks (lockfile pinned, unified core versions, no redundant/conflicting transitive deps)
- security/redaction tests
- fixture corpus tests
