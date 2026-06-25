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
