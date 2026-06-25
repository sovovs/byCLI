# ADR 0006 · DNS Rebinding And Connection-IP Enforcement

## Status

Accepted. Capability tier is selected by the M1 navigation spike (see ADR 0002).

## Decision

DNS all-record precheck plus redirect-before-send interception (ADR 0002) does not by itself close DNS rebinding: a host can pass URL/DNS policy and then resolve to a forbidden IP at actual connect time. Closing the gap requires comparing the **actual connection IP** against the vetted set, which most browser-embedded capture forms cannot enforce before the request is sent. We therefore define a capability matrix and bind MVP behaviour to the tier the spike proves.

| Tier | Requirement | Allowed navigation scope |
| --- | --- | --- |
| `strict-ip-enforced` | A controlled local policy proxy (or equivalent pre-connect IP enforcement) resolves DNS itself, validates every A/AAAA/CNAME, and rejects private/link-local/metadata per connection. | Any domain that passes URL policy. |
| `ip-observed-only` | Connection IP is visible only at response/redirect stage (CDP `Network.Response.remoteIPAddress`, webRequest/Electron post-connect `ip`). Observation is logged but is **not** a security boundary. | Static, human-maintained, strong-trust allowlist domains only (see allowlist constraint below). |
| `no-ip-observation` | Only URL/redirect policy, no connection-IP signal. | Does not meet MVP arbitrary navigation; allowlist only. |

## Context

- CDP exposes `remoteIPAddress` on the response object, not on `requestWillBeSent`/Fetch request interception; the request is already in flight.
- Chrome `webRequest` `details.ip` appears on onBeforeRedirect/onCompleted/onErrorOccurred (post-connect), not on blocking onBeforeRequest/onBeforeSendHeaders.
- Electron `webRequest.onBeforeSendHeaders` may run after the TCP connection is established; `ip` is not a reliable pre-connect gate.
- Static IP pinning breaks legitimate CDN/multi-IP rotation. If IP enforcement is done, it must be per-navigation fresh-resolve with a TTL bound, not a long-lived static pin.

## Consequences

- The M1 spike must classify the achievable tier per capture form (Electron / CDP / extension) and record it as a hard acceptance result.
- MVP defaults to `ip-observed-only` semantics: arbitrary navigation is **not** opened on post-connect observation alone; only explicit allowlisted domains are navigable unless `strict-ip-enforced` is achieved.
- **Allowlist constraint (`ip-observed-only`).** The allowlist is a strong-trust *product* boundary, not a *network* boundary — it does **not** close DNS rebinding: an allowlisted domain can still rebind to a forbidden internal IP between vetting and connect. It is therefore restricted to entries that are **static, human-maintained, and individually vetted**. It must **not** admit user-supplied domains, wildcards, tenant/customer subdomains, short-link/redirector hosts, or any domain whose target IP is operator-configurable (e.g. customer-controlled CNAME). Anything outside that set requires `strict-ip-enforced`.
- **DNS precheck is not enforcement.** The URL-policy all-record A/AAAA precheck filters the records visible *at check time* only. It cannot prove the IP the browser actually connects to (separate resolver, OS/browser DNS cache, proxy, Happy Eyeballs, connection reuse, TTL-window rebind). This TOCTOU window is **not removable** at the URL-policy layer. Implementation and tests must **never** treat "DNS precheck passed" as equivalent to `strict-ip-enforced`; closing it requires the controlled local policy proxy below.
- The controlled local policy proxy is the implementation path to `strict-ip-enforced`: it resolves DNS, validates all records, rejects forbidden ranges per connection, uses CONNECT for HTTPS (TLS/cookies stay end-to-end). It also requires constraining bypass channels (QUIC/HTTP3, direct sockets, system-proxy bypass) — deferred until arbitrary navigation is a product requirement.
- "Navigate then observe final IP" is never accepted as a security boundary (consistent with ADR 0002).
