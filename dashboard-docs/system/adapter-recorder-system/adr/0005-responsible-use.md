# ADR 0005 · Responsible Use Boundary

## Status

Accepted for MVP.

## Decision

Adapter Recorder provides local automation of user-owned, logged-in sites, but enforces a responsible-use product boundary: user authorization confirmation, default rate limiting, and no bypass of access controls.

## Context

Recorder records a logged-in browser and generates scraping adapters. Without an explicit boundary, the same capability can be pointed at sites the user is not authorized to automate, or used for bulk/abusive scraping.

## Consequences

- Recorder runs only in a browser context the user actively logged into and authorized.
- It does not bypass authentication, paywalls, anti-bot or access controls.
- Generated adapters carry default rate-limit / backoff config placeholders.
- UI confirms authorization before `init`; reports record `responsibleUseAcknowledgedAt`.
- verify defaults to low concurrency; infinite loops and bulk scraping are disallowed.

## LLM synthesis (MVP) — external data egress + generated-code boundary

When `FEATURE_LLM_SYNTHESIS` is on, init sends the recording traces — **page screenshots and the captured real request/response bodies** (which may include data from authenticated internal sites) — to the Anthropic API to synthesize the adapter `func`/`columns`. This is a new external data egress beyond the local-automation boundary above, and a deliberate exception to init's otherwise strict "no raw user-code injection" invariant.

- **Egress consent (enforced, P0-2)**: synthesis only runs when the init request carries an explicit `llmEgressAcknowledgedAt` — i.e. the user clicked "用 AI 生成(发送痕迹)" **before** anything is sent. Without it, init renders the empty template and **no data leaves the host**. The be advertises availability via `llmSynthesisOffered` (a boolean, never the key). Off by default; requires both `FEATURE_LLM_SYNTHESIS=1` and `RECORDER_LLM_API_KEY`.
- **Generated-code review gate**: LLM-generated `funcBody` is inserted raw into the adapter. It must pass a human dry-run review (full source shown) before write, and only ever executes inside the isolated `verify-runner` child process (0600 input, timeout, byte caps).
- **Provenance**: LLM-generated adapters are stamped `// @generated-by adapter-recorder-llm` + `// @model <id>` so they are auditably distinguishable from template skeletons.
- The `RECORDER_LLM_API_KEY` is read via the validated config port and never logged (redaction covers `api_key`/`secret`).
