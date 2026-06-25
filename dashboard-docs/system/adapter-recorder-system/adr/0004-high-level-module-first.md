# ADR 0004 · High-Level Module First

## Status

Accepted for MVP. **Amended by ADR-0007** for the `dashboard-be` / daemon hosting split: "imports in-process" applies only to the main-repo same-process Local Service (CLI/daemon); the independent `dashboard-be` process reaches high-level capability across the daemon boundary (browser-IO via `/command`, FS/subprocess via daemon `/v1/*`) and via the shared pure package, never by importing main-repo `src/`.

## Decision

High-Level capabilities are extracted as service modules first. Optional HTTP wrapper is implemented only when multi-client reuse is needed.

## Context

Adapter Recorder is the primary consumer. A second localhost HTTP service increases token forwarding, port management, cross-process error mapping and local attack surface.

## Consequences

- Recorder Local Service imports High-Level modules in-process **when it is the main-repo same-process form (CLI/daemon)**; the independent `dashboard-be` process does not import them (see ADR-0007 — it forwards over the daemon boundary).
- `/v1/*` remains a stable internal or optional HTTP contract.
- Optional wrapper must implement Origin/header/token gates.
- CLI actions and Local Service share service modules.
