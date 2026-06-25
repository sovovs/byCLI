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
