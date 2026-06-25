# ADR 0007 · Daemon High-Level Hosting And Capability-Boundary Split

## Status

Accepted (M5). Adopted as the "A'" verdict from the M5 hosting review and validated by the M5a/M5b/M5c implementations.

## Decision

High-level capabilities (`analyze`, `init`, `verify`) are hosted **main-repo side**, reached by the independent `dashboard-be` process across the daemon HTTP boundary — never by importing main-repo `src/`. Hosting splits by the **capability's IO kind**:

| Capability | IO kind | Hosting path |
| --- | --- | --- |
| `analyze` | browser (Page multi-step) | `dashboard-be` orchestrates over the existing daemon `POST /command` (navigate + exec probe + cookies + capture-read) and calls the pure `analyzeSite`. daemon stays a thin proxy. |
| `init` | filesystem (write transaction) | daemon high-level endpoint `POST /v1/init` → main-repo `createAdapterDraft`. be forwards only. |
| `verify` | child-process runner | daemon high-level endpoint `POST /v1/verify` → main-repo `verifyAdapter` → `RunnerPort` (M6 child process). be forwards only. |

Pure deterministic logic is extracted to the shared package `@sovovs/bycli-recorder-core` (imported by both main repo and `dashboard-be`); only IO-bearing orchestration stays main-repo side.

## Context

07's original "Recorder Local Service should import these modules in-process" assumed a same-process Local Service (CLI/daemon). `dashboard-be` is a separate ESM process whose hard rule is "do not import main-repo `src/`", so in-process import does not apply to it. The daemon already mediates browser IO via `POST /command`; it lives in the main repo and has FS + child-process access. Rather than start a second long-lived HTTP wrapper process (07's optional wrapper, which targets multi-client reuse), `init`/`verify` reuse the daemon by adding explicit high-level endpoints. `analyze` needs no new endpoint because its IO is browser-only and the `/command` chain already covers it.

## Consequences

- The daemon grows from a thin WebSocket→extension proxy into also hosting a small high-level async surface (`/v1/init`, `/v1/verify`), gated by the same `X-byCLI` header. Business logic stays in main-repo high-level modules; daemon handlers only own the HTTP boundary + request lifecycle, never inline domain/FS/subprocess logic.
- `dashboard-be` never writes main-repo adapter paths, never spawns the runner, never imports `src/` — preserving the three-layer coupling rule (coupling surface = daemon HTTP contract).
- Browser-IO vs FS/subprocess capabilities are deliberately hosted differently; this asymmetry is intended, not an inconsistency.
- A future genuine multi-client need can still add 07's standalone HTTP wrapper; it is distinct from these daemon `/v1/*` endpoints.
- `verify` real execution depends on the M6 runner; until then `/v1/verify` delegates to a stub `RunnerPort` returning `runner_protocol_error`.
