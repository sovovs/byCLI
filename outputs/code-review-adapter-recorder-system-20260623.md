# Code Review Report

**File**: `dashboard-docs/system/adapter-recorder-system/`
**Language/Framework**: Markdown system design, OpenAPI 3.1, JSON Schema 2020-12
**Review Date**: 2026-06-23
**Reviewed Dimensions**: Security · Architecture · Maintainability · Error Handling · Performance · Readability · Testing · Observability · Concurrency

---

## Executive Summary

The design is generally strong: it has explicit layered boundaries, security threat modeling, schema-first contracts, request lifecycle semantics, redaction rules, fixture gates, and ADRs for the risky choices. The remaining unreasonable parts are mostly design drift introduced after M5/ADR-0007: the high-level hosting path and `/v1/*` route vocabulary are no longer consistently reflected in README/overview/roadmap/OpenAPI. Two schema issues are also worth fixing before treating the docs as implementation-ready: Recorder `InitRequest` still exposes free-form fields that can diverge from `RankCandidate`, and request result payloads remain too generic for generated clients to enforce.

---

## Issue Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 |
| Moderate | 3 |
| Low | 1 |
| **Total** | **6** |

---

## Critical Issues

None found.

---

## High Issues

### [H-001] · Daemon high-level endpoints are accepted in prose but absent from the machine contract

**Lines**: `05-recorder-local-service.md` L24-L31, `07-high-level-services.md` L7-L15, `adr/0007-daemon-high-level-hosting.md` L9-L16, `schemas/high-level.openapi.yaml` L5-L51, `03-contracts-and-versioning.md` L55-L63
**Dimension**: Architecture / Contract
**Summary**: The design says `dashboard-be` forwards init/verify to daemon endpoints `POST /v1/init` and `POST /v1/verify`, but the high-level OpenAPI still only defines `POST /v1/adapters/init` and `POST /v1/adapters/verify`.

**Impact**:
Contract-first implementation can generate or test the wrong routes. A developer following `05`/ADR-0007 will implement daemon `/v1/init` and `/v1/verify`; a developer following `03` or `schemas/high-level.openapi.yaml` will call `/v1/adapters/init` and `/v1/adapters/verify`. Because both use `/v1/*`, this is not a harmless naming difference; it creates two competing internal APIs with unclear ownership.

**Proposed Fix**:
Pick one of these and make it explicit everywhere:

1. Add a separate `daemon-high-level.openapi.yaml` for daemon-hosted `/v1/init` and `/v1/verify`, and state that `high-level.openapi.yaml` is only the optional standalone wrapper contract.
2. Or rename daemon endpoints to match the existing high-level contract (`/v1/adapters/init`, `/v1/adapters/verify`) if they are intended to be the same wire API.
3. Or move daemon routes out of the generic `/v1/*` namespace to avoid collision, e.g. `/daemon/high-level/init`.

Whichever option wins, update `03`, `05`, `07`, ADR-0007, and CI contract tests together.

---

### [H-002] · Recorder `InitRequest` still permits free-form endpoint/column data despite selected-candidate flow

**Lines**: `03-contracts-and-versioning.md` L66, `06-recorder-core-engine.md` L75-L77 and L135-L137, `10-fixtures-and-test-plan.md` L84-L85, `schemas/recorder.openapi.yaml` L447-L487, `schemas/high-level.openapi.yaml` L118-L159
**Dimension**: Contract / Maintainability
**Summary**: Prose says Recorder init selects a prior `RankCandidate` by `selectedCandidateId` and derives domain/strategy/endpoint from session state, but Recorder OpenAPI still exposes optional `domain`, `strategy`, free-form `endpoint: object`, and `columns: string[]`.

**Impact**:
The UI-facing `/recorder/init` contract can drift from the rank output. A client could send an `endpoint` shape that does not validate against `EndpointDescriptor`, or `columns` that do not match `ColumnDescriptor`, while tests only require `High-Level InitInput.endpoint` to share the rank schema. This weakens the whole `rank -> selectedCandidateId -> init` invariant.

**Proposed Fix**:
If `/recorder/init` must only select a candidate, remove `domain`, `strategy`, `endpoint`, and `columns` from Recorder `InitRequest` and derive them server-side. If UI overrides are intentionally supported, make that explicit and bind:

- `endpoint` to `adapter-recorder.bundle.json#/$defs/EndpointDescriptor`
- `columns` to `ColumnDescriptor[]`
- override semantics to a named field such as `candidateOverrides`
- contract tests proving overrides cannot contradict `selectedCandidateId` without a validation error

---

## Moderate Issues

### [M-001] · ADR-0007 changes the hosting decision, but overview/roadmap/ADR index still read like the old default is authoritative

**Lines**: `01-system-overview.md` L38-L42, `02-architecture-boundaries.md` L33 and L69, `11-roadmap-and-acceptance.md` L35-L40, `adr/0004-high-level-module-first.md` L17-L20, `adr/0007-daemon-high-level-hosting.md` L19-L28
**Dimension**: Architecture / Readability
**Summary**: ADR-0007 correctly narrows "in-process import" to main-repo same-process forms, but entry-point docs still say Local Service imports High-Level modules in-process and M5 acceptance still says "in-process Local Service integration."

**Impact**:
New implementers will see contradictory instructions before reaching ADR-0007. This is especially risky because `dashboard-be` has a hard rule not to import main-repo `src/`; following the stale overview would recreate the exact coupling ADR-0007 was written to prevent.

**Proposed Fix**:
Mark ADR-0004 as "Accepted, amended by ADR-0007 for dashboard-be/daemon hosting." Update `01` current defaults and `11` M5 acceptance to distinguish:

- same-process main-repo Local Service: may import high-level modules
- independent `dashboard-be`: may only use shared pure package + daemon boundary
- optional standalone wrapper: separate multi-client reuse path

Also add ADR-0007 to `02`'s ADR Required list.

---

### [M-002] · Security model's URL policy section does not restate the ADR-0006 allowlist gate

**Lines**: `04-security-model.md` L49-L75, `adr/0006-dns-rebinding-ip-enforcement.md` L24-L31, `11-roadmap-and-acceptance.md` L11-L18
**Dimension**: Security
**Summary**: The central Security Model lists parse/canonicalize/DNS/interception steps, but the strongest ADR-0006 rule is only in ADR/roadmap: without `strict-ip-enforced`, arbitrary navigation is not safe and must be limited to a static strong-trust allowlist.

**Impact**:
An implementer reading only `04` could reasonably believe DNS all-record precheck plus redirect-before-send interception is sufficient for arbitrary navigation. ADR-0006 says it is not, because DNS rebinding remains a TOCTOU gap unless actual connection IP is enforced.

**Proposed Fix**:
Add a short "Connection-IP capability gate" subsection directly after `04` L75:

- if tier is `strict-ip-enforced`, arbitrary domains passing URL policy are allowed
- if tier is `ip-observed-only` or `no-ip-observation`, only static, human-maintained, strong-trust allowlist entries are allowed
- user-supplied domains, wildcards, customer-controlled CNAMEs and redirector hosts require `strict-ip-enforced`

---

### [M-003] · Request result payload schemas are described in prose but not enforceable from OpenAPI

**Lines**: `03-contracts-and-versioning.md` L83-L90, `schemas/recorder.openapi.yaml` L290-L339, `schemas/high-level.openapi.yaml` L160-L190
**Dimension**: Contract / Testability
**Summary**: Prose binds `RequestStatus.result` by `type`, but both OpenAPI files leave `result` as a generic `object | null`; `ApiResponse.data` is also generic.

**Impact**:
Contract tests can catch some drift, but generated clients and schema validators cannot know that `rank` result is `RankCandidate[]`, `analyze` result is `AnalyzeReport`, `init` result is `RecorderReport`, and `verify` result is a runner summary. This weakens the "machine-readable contracts first" rule and pushes important compatibility behavior into prose.

**Proposed Fix**:
Add typed response components, for example `RankStatus`, `AnalyzeStatus`, `InitStatus`, `VerifyStatus`, and use `oneOf` with `type` const values. Do the same for endpoint-specific `ApiResponse.data` where possible (`/recorder/rank`, `/recorder/analyze`, `/recorder/init`, `/recorder/verify` acceptance envelopes). Keep prose as explanation, not the only binding.

---

## Low Issues

### [L-001] · Neighbor progress doc has stale status rows that contradict its own later updates

**Lines**: `dashboard-docs/architecture-relationship.md` L76-L80, L108-L116, L138-L143, L157-L163
**Dimension**: Maintainability / Documentation
**Summary**: The relationship doc says `dashboard-be` navigation is `feature_disabled` and M5 is not started in some tables, while later sections and the header say M3/M4/M5a/M5b/M5c have landed.

**Impact**:
This is outside the target design directory, but it is a nearby entry point and can mislead planning around the system docs.

**Proposed Fix**:
Normalize the status table and milestone table to the latest header state, or mark old blocks as historical.

---

## What's Working Well

- The design has a strong security baseline: Electron IPC default, optional localhost HTTP gates, XSS constraints, raw seed arg boundaries, input file permissions, and explicit same-uid threat framing.
- The state machine and strict page lease rules are unusually clear, especially the no fallback to other tabs and per-session linearized transition requirement.
- Schema hygiene is better than average: OpenAPI is 3.1.0, `nullable` has been removed, shared errors are centralized in `adapter-recorder.bundle.json`, and runner events use a unified error vocabulary.
- The fixture/test plan is practical and targets real failure modes: URL matrix, A/B sample rules, idempotency, crash recovery, redaction, config reload, and runner protocol violations.

---

## Systemic Observations

The main systemic issue is "decision drift after implementation feedback." Earlier docs establish module-first/in-process high-level design; later ADR-0007 and M5 implementation feedback introduce daemon-hosted init/verify and pure shared package extraction. The newer decision is reasonable, but not all entry points and schemas have been updated to make it the canonical path.

The second pattern is "prose is stronger than schema" in a few places. The docs repeatedly say contract-first and machine-readable, but `RequestStatus.result`, `ApiResponse.data`, and Recorder `InitRequest` still leave important behavioral constraints outside the schema.

---

## Assumptions and Context Gaps

I reviewed the design package and nearby relationship docs, not the full implementation. If the implementation has already standardized on one `/v1/*` route family and generated tests enforce it elsewhere, H-001 severity drops, but the docs still need synchronization because the current design package remains internally contradictory.

I treated `dashboard-be` as an intended production path for the optional localhost HTTP UI because the surrounding docs state that positioning. If it is now only a temporary implementation artifact, the architecture docs should say so explicitly and move daemon-hosting details out of the MVP contract path.
