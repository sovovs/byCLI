# 11 · Roadmap And Acceptance

## Status (as of 2026-06-25)

**M0–M9 landed; M10 (MVP acceptance) verified 2026-06-25.** Implementation status (detail + per-milestone log in `../../architecture-relationship.md` and the impl memory):

- **M0–M6 ✅** — schemas + TDD governance; M1 navigation/URL-policy spike (real-link live no-hit PASS); M2 Local Service shell + same-origin UI; M3 page lease + daemon `/command`; M4 core engine (`packages/recorder-core`); M5a/b/c analyze/init/verify (be→daemon `/v1/*`); M6a/b/c verify runner (real child process, browser adapter connect-back, concurrency queue) + init atomic write/crash recovery.
- **M7 ✅ (a/b/c/d), Codex three independent audit rounds clean** — M7a session-keyed HMAC (`SessionKeyRegistry`); M7b temp-store TTL (age-floored reap, never kills a live run); M7c redaction (`fieldCount` not key names, execute-stage message/hint/code withheld, fd-3 protocol isolation, load-stage redaction); M7d gate audit + UI CSP (`script-src 'self' 'nonce'` + `frame-ancestors 'none'`), constant-time compare hardening. **Electron XSS = N/A** (no Electron shell; the recorder UI is a localhost web app — see `04`). Same-uid local-process vectors are documented out-of-scope per the `04` threat model.
- **M8 ✅** — config + observability (all four sub-parts). **M8a** config consolidation (recorder-core `resolveScoringProfile` / `resolveFeatureFlags`, pure env-injected fail-fast resolvers; be wires them, `/recorder/rank` reads the externalized profile gated by `FEATURE_PREVIEW_SCORING_PROFILE`). **M8b ✅** structured logging (be `logger.ts`: allowed-fields-only `LogFields` so forbidden fields are impossible by construction; level-filtered + runtime `LOG_LEVEL` via SIGUSR2; request-completion + verify-lifecycle logs carry `requestId`/`operation`/`status`/`durationMs`). **M8c ✅** metrics hooks (be `metrics.ts`: counters + histograms keyed by non-sensitive labels; wired at the request choke point — `recorder_requests_total{operation,status,errorCode}`, request-duration histogram, idempotency-conflict; SIGUSR1 dumps the snapshot). **M8d ✅** `ConfigPort.reload()` hot-reload (be `config-port.ts`: versioned snapshot; reload swaps only hot fields while **pinning security/restart fields** — token/origins/ports/registry/restart-flags — from startup; `LOG_LEVEL` applies immediately/globally; failed reload keeps the old snapshot; SIGHUP-triggered).
- **M9 ✅ (a/b/c)** — optional standalone High-Level HTTP wrapper (`src/recorder/http/`, opt-in via `bycli internal highlevel-http`, default off, bind `127.0.0.1:19827`). **M9a** shell + gate (`X-byCLI` + startup random `X-byCLI-Token` + Origin allowlist, no CSRF) + own request registry + `POST /v1/adapters/init` (sync→202+poll) + `GET /v1/requests/{id}` (ownership + TTL→404) + `GET /health`; the drift-shared crypto/ErrorCode were lifted into `recorder-core` (Q2 hybrid, Codex-reviewed). **M9b** `POST /v1/adapters/verify` delegates `verifyAdapter`+`defaultRunnerPort` (browser-verify connects back to the daemon for a Page), status proxies the runner's `getRunStatus`, raw `executionSeedArgs` never reach the registry/202/log. **M9c** `POST /v1/browser/analyze` runs a daemon-backed `Page` (M6b connect-back) in the background → `analyze_timeout`/`daemon_unavailable`. Plus gated `/metrics` (operational; M8 follow-up). **Two distinct `/v1/*` families never conflated** (wrapper `high-level.v1` vs daemon `daemon-high-level.v1`, ADR-0007). Lifecycle: verify finalizes in the background on runner-settle (not only on poll), terminal records are swept on a periodic timer. **M10 ✅ — MVP acceptance verified 2026-06-25**: full suites green (recorder-core 84 / dashboard-be 73 / main-repo 4834 + 1 skipped); the 13-row acceptance table below maps every row to passing tests/evidence; schema gate validated locally (3 OpenAPI 3.1.0/nullable-free, bundle `$defs`, refs→bundle). Coverage ≥80% and the real-daemon E2E (`BYCLI_RECORDER_E2E`, ubuntu-only) remain CI-enforced.

## Milestones

1. **M0 · TDD governance and schemas**
   - TDD checklist in review template.
   - `/recorder/*`, `/v1/*`, error schema and request status schema.
   - schema versioning and compatibility policy.
   - dependency boundary rules and ADR list.

2. **M1 · Navigation and URL policy spike**
   - request interception verified.
   - URL matrix tests passing.
   - unknown redirect blocked when interception unavailable.
   - **interception armed before navigation**: target main-frame request is never sent until `Fetch` is enabled and the handler is registered (blank-page-first, then single navigation). "Navigate then check final URL" is not accepted (ADR-0002).
   - **live no-hit acceptance**: a public URL that 302-redirects to `127.0.0.1` / cloud metadata / a private range is exercised end-to-end, and the forbidden target server records **0 received requests**. Observing the redirect after the fact does not pass.
   - connection-IP enforcement tier classified per ADR 0006 and **recorded per capture form** (direct CDP = `ip-observed-only`; extension-via-debugger = `ip-observed-only`; missing Fetch / attach failure ⇒ returns `navigation_redirect_requires_interception`, never silent bare navigation). MVP defaults to `ip-observed-only` (static, human-maintained, strong-trust allowlist domains only — not a rebinding boundary, per ADR 0006); arbitrary navigation requires `strict-ip-enforced` via the controlled local proxy.

3. **M2 · Recorder Local Service shell**
   - Electron IPC default path.
   - optional localhost HTTP guard.
   - health/session/request registry/cancel.

4. **M3 · Strict page lease and daemon client**
   - page ownership.
   - stale page fail-fast.
   - capture start/read via daemon.

5. **M4 · Canonical capture and core engine**
   - mapper with `sourceCompleteness`.
   - Normalize/Rank/Diff.
   - scoreExplanation.
   - fixture corpus 10/10.

6. **M5 · High-Level modules**
   - `analyzeBrowser`.
   - `createAdapterDraft`.
   - `verifyAdapter`.
   - hosting per ADR-0007: main-repo same-process integration is in-process; `dashboard-be` integrates across the daemon boundary (browser-IO via `/command`, FS/subprocess via daemon `/v1/init`+`/v1/verify`); pure pieces in `packages/recorder-core`.

7. **M6 · Verify runner**
   - JSONL internal command.
   - async registry.
   - timeout/cancel/stdout caps.
   - input.json security.

8. **M7 · Security and data policy**
   - CSRF/Origin/header/token gates.
   - Electron XSS defenses.
   - seedArgs HMAC.
   - temp store TTL.
   - redaction.

9. **M8 · Config and observability**
   - RecorderConfig, HighLevelConfig, ScoringProfile and Feature Flags schema.
   - `ConfigPort.reload()` hot-reload with atomic versioned snapshot; restart-only flags enforced.
   - structured logs with requestId; runtime `LOG_LEVEL` control.
   - metrics hooks.

10. **M9 · Optional High-Level HTTP wrapper** — ✅ implemented (a/b/c)
    - loopback wrapper (`src/recorder/http/`, opt-in `internal highlevel-http`, `127.0.0.1:19827`).
    - Origin/header/token gate (`X-byCLI` + startup random `X-byCLI-Token` + Origin allowlist).
    - `/health`, `/v1/adapters/init`, `/v1/adapters/verify`, `/v1/browser/analyze`, `/v1/requests/{requestId}`, gated `/metrics`.
    - own request registry; verify finalizes on runner-settle (not only on poll); periodic TTL sweep.

11. **M10 · MVP acceptance** — ✅ verified 2026-06-25
    - all acceptance items below pass (each row mapped to passing tests/evidence; coverage% + real-daemon E2E are CI-enforced).

## MVP Acceptance

| Category | Acceptance |
| --- | --- |
| schema | machine-readable contracts, schemaVersion, compatibility policy and contract tests |
| TDD gate | coverage >= 80% for core modules, dependency boundary checks, config schema tests, error mapping tests |
| security | cross-origin blocked, token hidden, Electron XSS defenses, no raw sensitive logs |
| navigation | URL matrix passes; redirects checked before request or blocked |
| recorder flow | health/bind/navigate/capture/analyze/init/verify/cancel work through Local Service |
| state | A/B capture order enforced; multiple sessions isolated; cancel cleans resources |
| page lease | stale page returns `page_lost`; no fallback to other tab |
| core engine | fixture corpus 10/10; scoreExplanation stable; pairing fallback and insufficient samples explicit |
| high-level | analyze/init/verify use modules, no CLI text parsing |
| runner | JSONL protocol, timeout/cancel, stdout/stderr caps, input.json safe create/cleanup |
| data | report contains only redacted shape/HMAC summaries |
| observability | requestId propagated; structured logs; metrics without sensitive fields |
| ADR | key decisions recorded |

## Changelog

| Date | Change |
| --- | --- |
| 2026-06-19 | Created modular system spec. |
| 2026-06-19 | Fixed error-code drift (added `auth_required`/`network_error`/`insufficient_samples`/`idempotency_conflict`/`temp_store_full`, runner error namespace); aligned high-level RequestStatus enum (`analyze/init/verify`); clarified analyze in-process execution model; added request bodies + idempotency to OpenAPI; added `domain.schema.json` and `runner-jsonl.schema.json`; added crash recovery/startup reap; auth session binding + responsible-use boundary (ADR 0005); A/B capture sample protocol; HMAC display-only/non-comparable semantics; terminal-status TTL/poll, temp-store pressure, per-profile concurrency model, Windows file-permission policy. |
| 2026-06-19 | Second review pass: stabilized cross-schema `$ref` (absolute `$id`); fixed `responsibleUseAcknowledgedAt` (required in AnalyzeReport, added to init inputs); expanded test plan + ADR Required list; aligned high-level RequestStatus (`expiresAt`/`pollAfterMs`/`queueReason`) and added `waitMs` + response/error schema bindings to both OpenAPIs; added `awaiting_user_login`/`auth_confirmed` states; completed Error Mapping enum coverage; added `clientRequestId` + `409` to side-effect POSTs; added runner result `ok`/`data`/`error` conditional constraints; metrics + CI gate now cover new error codes and all 5 schemas. |
| 2026-06-19 | Third review pass: `/recorder/init` `409` added; all recorder POST responses bound to `ApiResponse`; high-level `202` bound to new `AcceptedResponse`; high-level idempotency boundary documented (recorder-side only); shared `Error` schema added and bound to both `RequestStatus.error`; `responsibleUseAcknowledgedAt` made machine-readable conditional-required (allOf/if-then) on both init inputs; `shape_mismatch`/`fixture_mismatch` mapped to `200 result or 500`; `CaptureStartRequest.seedArgsEvidence` bound to `EvidenceSeedArg`; `02` ADR list relaxed to "ADR or module decision record" with locations; RequestStatus superset/subset and Init field derivation documented; runner result `data`/`error` forbidden null; split `AnalyzeReport` (site) from new `RecorderReport` (write-time). |
| 2026-06-19 | Fourth review pass: upgraded both OpenAPI files to 3.1.0 so `if/then/const` conditional-required is valid; converted all `nullable: true` to union types (`type: [..., "null"]`); bound recorder `ApiResponse.error` and `RequestStatus.error` to shared error schema via `$ref` (`adapter-recorder.error.v1`), making both transports' error truly same-source. |
| 2026-06-20 | Fifth review pass: eliminated unresolvable bare `$id` cross-file `$ref`s. Merged `errors`/`domain`/`runner-jsonl` schemas into a single `adapter-recorder.bundle.json` (`$defs`, no per-def `$id`); deleted the three standalone files; repointed all OpenAPI cross-file refs to `adapter-recorder.bundle.json#/$defs/*` (Error, ErrorCode, EvidenceSeedArg). Updated 03/06/08/09 references and the schema-version table; CI gate (00) now pins a 3.1 / JSON Schema 2020-12-aware validator, forbids `nullable`, and forbids bare-`$id` refs. |
| 2026-06-20 | Sixth review pass (bundle cleanup confirm): removed the bundle's non-URI top-level `$id` (now zero `$id` anywhere) so relative-path `$ref` resolution can't be affected by a base-URI; bound test plan (10) error-schema and Runner JSONL tests to `adapter-recorder.bundle.json#/$defs/*` (Error/ErrorCode/RunnerEvent). |
| 2026-06-20 | Final readiness review: cleared 3 implementation-blocking P1s — added `POST /recorder/rank` contract (+`RankRequest`, `RankCandidate.id`, `InitRequest.selectedCandidateId`, result→`RankCandidate[]`) so ranking is callable and no longer orphaned; added `POST /recorder/session/confirm-auth` (+`ConfirmAuthRequest`) to drive `awaiting_user_login`→`auth_confirmed`; made `responsibleUseAcknowledgedAt` non-null integer when `writePolicy=write` (both OpenAPIs + bundle `RecorderReport`). P2: fixed `seedArgs`→`seedArgsEvidence` (06) and `traceRetained`→`data.trace.retained` (08), removed duplicate `EvidenceSeedArg` in high-level, bound `/recorder/health` to `ApiResponse`, documented per-`type` result→schema mapping (03). |
| 2026-06-20 | P1-fix verification pass: confirmed the 3 P1 fixes hold and format is clean; closed the one drift they introduced — `/recorder/rank` was in schema/result-map but missing from the idempotency side-effect POST list (03) and from `RequestStatus.type` enums. Added `rank` to recorder `type` enum (OpenAPI + 03/05 prose) and to the idempotency list; high-level `type` stays the intentional `[analyze, init, verify]` subset. |
| 2026-06-20 | State-machine ↔ endpoint mapping pass: made `/recorder/rank` the explicit gate `capture_b → ranked` (rank reads the session's frozen A/B samples; normalize is now an internal rank step, removed from the top-level state list); added a state→driving-endpoint table to 05 (no implicit auto-advance); documented `/recorder/analyze` as an optional parallel site-level exploration outside the main capture→rank→init→verify chain. |
| 2026-06-20 | Mapping/fixture consistency pass (no P1 found, ready for implementation): merged 01 end-to-end Normalize/Rank into one rank-driven step; fixed 05 state table (health = read-only precondition, added navigate transition, added `verifying → done|failed` driver); added `analyze` independent-lifecycle note; added `06` Normalize "rank-internal phase" note; added `RankCandidate.id` to fixture assertions (06/10); pinned `insufficient-samples` fixture to `/recorder/rank` HTTP 400 + `error.code=insufficient_samples`; narrowed `03` mapping accordingly; required fixtures to validate against bundle `RankCandidate`/`Error`/`ErrorCode`. |
| 2026-06-20 | **[superseded by the next entry]** TDD.md compliance pass: closed 6.3 (00 dependency-hygiene CI gate), 10.1 (extended lint/typecheck gate with ESLint Blocker-zero ≈ Sonar/P3C), and 8.1 (09 Data Persistence Boundary — explicit no-DB N/A with registry/TTL/atomic-write/reap equivalents). Partially addressed 9.1 (09 Log Level Control + `LOG_LEVEL` config key; admin-toggle security + tests still to define) and 7.2 (06 documents score constants as source-of-truth, movable to config). 7.3 is NOT closed — recorded as a deliberate MVP deferral (04: feature-flag/gray-release out of MVP scope), to revisit if it becomes an MVP compliance target. |
| 2026-06-20 | 7.2/7.3 strict-compliance pass: externalized all ranker scores into `ScoringProfile` (09 config block + 06 default-profile note + 10 tests; hard rejects stay non-configurable invariants) → 7.2 fully met. Added 09 Feature Flags And Hot Reload (local fail-closed flags + ConfigPort.reload snapshot-swap hot-reload-vs-restart policy) and rewrote 04 (local FeatureFlags exist; cloud gray-release/A-B is N/A for a single-user tool, with `RELEASE_CHANNEL`/`LOCAL_EXPERIMENT_PROFILE` as the local equivalent); 10 adds feature-flag/hot-reload tests → 7.3 feature-toggle + hot-reload fully met, gray-release/A-B context-equivalent (N/A with local substitute). |
| 2026-06-20 | 7.2/7.3 adversarial-review fixes (contract-first closure): added `ConfigPort.reload`/`snapshot` + semantics to 02; declared config schemas as `ConfigPort`-owned machine-readable validators in code (09 Config Principles) — deliberately not in the wire bundle, CI-gated via 10 config tests; expanded 09 Feature Flags table to Type/Range/Default/Error/Reload; added `feature_disabled` to bundle ErrorCode + 03 mapping (403) and split `config_invalid` into startup-vs-reload caller action; bounded ScoringProfile bands to `0..1000` with boundary validation; added `releaseChannel`/`localExperimentProfile`/`configSnapshotVersion` to RecorderReport schema; marked `LOG_LEVEL` as the explicit immediate-global hot-reload exception; synced M8 acceptance; flagged the prior compliance row as superseded; disambiguated 06 weak-HTML-signal vs confirmed-static hard reject. |
| 2026-06-20 | Deep defect scan + triangle review fixes (6×P1): init `selectedCandidateId` required; `session/bind`+`capture/read`+`confirm-auth` idempotency (Idempotency-Key + clientRequestId + 409 + retry semantics); `CancelRequest` scope-conditional required with non-null `requestId`/`sessionId`; High-Level Error unified to bundle `Error` + `details` redaction-allowlist constraint; session state machine abnormal-lease-release transitions + per-session linearized transitions (mutex/stateVersion CAS); ADR-0006 DNS-rebinding connection-IP capability matrix (MVP `ip-observed-only`, strict via controlled local proxy) + M1 acceptance tier; localhost HTTP UI startup token + bootstrap injection + same-uid out-of-scope framing; init write mini-transaction (txn manifest + report-before-adapter rename + provenance header + commit marker + crash-recovery table). All 6 P1 closed per Codex re-review; remaining items are implementation-phase (M1 navigation spike) and minor doc P2. |
| 2026-06-25 | **M10 · MVP acceptance verified.** Closed the four documented tails (all already in the working tree): #5 flag wiring (`FEATURE_LOCALHOST_HTTP_UI` + `FEATURE_ADMIN_LOG_LEVEL_TOGGLE` wired, `FEATURE_DIRECT_CDP_CAPTURE` reserved no-consumer); #1a–d daemon/runner observability (structured logger + metrics lifted into `recorder-core`, daemon `GET /metrics` + finish-logger choke, runner counters via `setDefaultRunnerObservability`); #2 wrapper nearest-adapter via `loadAdapterRegistry()`; #4 fd3 `writeSync(3)` forge stays post-MVP (out-of-process attestation). Verified: recorder-core 84 / dashboard-be 73 / main-repo 4834 (+1 skipped) tests green; schema gate local-validated; 13-row acceptance table mapped to evidence. Stale header (`M0–M7 landed`) fixed; `M10 ⬜ → ✅`. |
