# ADR 0003 · Seed Args Boundary

## Status

Accepted for MVP.

## Decision

Split seed args into `executionSeedArgs` and `evidenceSeedArgs`.

## Context

Verify needs raw input values to execute user adapters. Reports, fixtures, logs and request status must not persist raw user input because many seed args are low entropy and sensitive.

## Consequences

- `executionSeedArgs` may exist only in memory and private 0600 input.json.
- `evidenceSeedArgs` uses placeholder, type, length and session-keyed HMAC.
- The HMAC is `display_only` and `comparableAcrossRuns=false`; cross-run fixture matching must not compare HMAC values.
- Request status and reports return evidence or omit seed args.
- input.json cleanup is mandatory on done/cancel/timeout.

## Revision (2026-06-29) · dashboard seed input as an evidence producer

The dashboard recording flow gained a per-sample "search keyword" input so scoring can detect the seed→param mapping (otherwise `seed_arg_maps_to_param`/`response_echoes_seed` never fire and candidates cap at ~15/low). This is a new **producer** of `evidenceSeedArgs` and stays strictly inside this ADR's boundary:

- The raw keyword reaches `dashboard-be` on `POST /recorder/capture/read` (`seed` field) and is used **only in memory, for that request**, to resolve which captured query param carried it (`resolveSeedParams` in recorder-core: exact trim+lowercase match against `queryParams` values, never substring).
- It is immediately converted via `deriveEvidenceSeedArgs(...)` to HMAC-only `evidenceSeedArgs` stored on the session sample; the raw keyword is **never** persisted to the sample/draft/adapter/runner input/log (Codex 2026-06-29 ruled option A: do NOT carry it into verify as a default arg — that would widen the `executionSeedArgs` surface to the runner and is a separate boundary change).
- Note: captured `entries` legitimately contain the keyword in their request query (it is real traffic the user already sees); redaction applies to `evidenceSeedArgs` and to cross-process/artifact spread, not to the captured traffic itself.
