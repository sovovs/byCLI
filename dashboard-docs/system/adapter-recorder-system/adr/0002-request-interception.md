# ADR 0002 · Navigation Request Interception

## Status

Required spike before MVP navigation support.

## Decision

Navigation URL policy is not complete unless redirected main-frame requests are checked before the browser sends them. If request interception cannot block before send, unknown redirects are disallowed for MVP.

## Context

Local Service DNS precheck and final URL observation do not stop DNS rebinding or forbidden redirects. A real browser may send cookies/session credentials before final navigation events are visible.

## Consequences

- Spike must validate Fetch domain, webRequest blocking or equivalent.
- URL matrix includes redirect to private and metadata targets.
- "Navigate then check final URL" is not accepted as a security boundary.
- No request interception means `navigation_redirect_requires_interception`.
