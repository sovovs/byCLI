# 04 · Security Model

## Threat Model

| Attacker / entry | Risk | Defense |
| --- | --- | --- |
| Malicious web page | Cross-origin calls to local service | Origin allowlist, custom header gate, no CORS, CSRF token |
| Compromised renderer | Abuse IPC capability | contextIsolation, preload allowlist, sender URL validation, parameter validation |
| Local process (same user) | Forge local HTTP calls | startup random token for high-level wrapper and (when enabled) localhost UI, least file scope, no token logs — best-effort misuse/CSRF/local-probe mitigation, **not** strong isolation against a same-uid malicious process (out of scope, see Local Service CSRF/Origin) |
| XSS in UI | Trigger authorized actions | CSP, no remote code, no navigation/window.open, confirmation for high-risk actions |
| Malicious adapter JS | Read files/env, hang, output secrets | child process, timeout, env allowlist, temp HOME, stdio cap, redaction |
| Navigation URL | Leak local/internal/cloud metadata with logged-in browser | canonicalization, DNS all-record checks, request interception, forbidden ranges; connection-IP enforcement tier per ADR 0006 |
| Logs/reports | Persist token/cookie/raw sample | field allowlist, redaction, HMAC evidence, TTL temp storage |

## Local Service CSRF/Origin

Electron IPC shape:

- Local Service does not expose browser-reachable HTTP endpoints by default.
- Preload exposes only allowlisted methods.
- Main process validates sender URL and params.
- Renderer never receives daemon/high-level token.

Pure localhost HTTP shape:

- Enabled only when `FEATURE_LOCALHOST_HTTP_UI=true`; the Electron IPC default has no HTTP listener.
- Listen on `127.0.0.1` only.
- Accept only own UI origin.
- Require custom header such as `X-Recorder: 1`.
- Do not return `Access-Control-Allow-Headers` on preflight.
- Side-effect endpoints are POST-only.
- CSRF token uses SameSite=Strict cookie plus header/form token.
- Require a startup random token (aligned with the high-level wrapper's `X-byCLI-Token`). Inject it into the UI at launch via a one-time bootstrap (loopback handshake / IPC / single-use bootstrap URL) so it lives in memory/sessionStorage; if a file must be used, place it in a random `0700` dir as a short-TTL `0600` file, never logged, cleaned on exit.

This token gate is a best-effort mitigation against misuse, CSRF and low-effort local probing. It is **not** strong isolation against a same-uid malicious process: a same-user process can already read user files, drive the browser and call the CLI, so same-uid forgery is out of scope. Strong isolation would require an OS sandbox, a separate user, native-app IPC peer credentials, or not exposing a browser-reachable HTTP UI at all.

### M7d audit status (2026-06-25)

Independent gate audit (Codex). Against the threat model above, the **in-scope** threat (malicious web page) is mitigated: every `POST /recorder/*` passes `checkGates` (X-Recorder header → Origin allowlist → X-byCLI-Token → CSRF double-submit) before body parse/dispatch; read-only GETs (`/recorder/health`, `/recorder/requests/{id}`) require header+Origin+token; a missing `Origin` is not a bypass (still needs the un-forgeable custom header + token); no CORS is returned; the same-origin static UI injects the token only into its own HTML (unreadable cross-origin by SOP). Token rotates per process start by default (`config.ts`: `TOKEN ?? randomToken()`); a fixed `RECORDER_TOKEN` is an explicit operator opt-out. Constant-time compares now digest both inputs to fixed length (no length-leak).

**Accepted residuals — all are same-uid local-process vectors, explicitly out of scope above** (a same-uid process can already drive the browser / read files / call the CLI):
- daemon privileged HTTP (`/v1/init`, `/v1/verify`, `/command`, `/shutdown`) and the extension WebSocket gate on **X-byCLI header presence** + `chrome-extension://` Origin, not a secret — blocks web pages (preflight/Origin), not a same-uid process. Future hardening: a daemon bearer token (be/CLI-injected) aligned with `X-byCLI-Token`, and pinning the expected extension ID on the WS.
- the same-origin static serve injects the token into any GET of the entry HTML (a same-uid process can read it), making `/__bootstrap`'s single-use nonce redundant in this hosting mode — acceptable under 127.0.0.1 + same-uid-out-of-scope; the web-page threat stays blocked by SOP.
- `GET /recorder/requests/{id}` reconciles a verify request's terminal state (token-gated, idempotent) — not CSRF-able (custom header + token required), so the POST-only rule is satisfied in spirit; a fully observational GET + background reconciliation is a possible future refactor.

## Electron XSS

**Status: N/A / deferred (no Electron shell).** byCLI has no `electron` dependency and no main/preload — it *drives* external Electron apps via CDP but the recorder UI is a localhost **web app** served over HTTP by dashboard-be. The Electron-specific items below (`contextIsolation`/`nodeIntegration`/`will-navigate`/`setWindowOpenHandler`/preload allowlist) apply only when/if an Electron shell is added. The "XSS in UI" threat for the current web-UI shape is mitigated by the **M7d CSP** (`dashboard-be/src/static.ts`): `script-src 'self' 'nonce-<per-response>'` (the lone inline bootstrap script is nonce'd; the bundle's only `new Function` is a CSP-tolerant short-circuited globalThis polyfill), no remote/CDN scripts, `style-src 'self' 'unsafe-inline'` (antd CSS-in-JS), `object-src/base-uri/form-action` locked, `frame-ancestors 'none'` + `X-Frame-Options: DENY` (anti-clickjacking of authorized actions). *(End-to-end browser render under this CSP is a follow-up verification — server-side header/nonce wiring is unit-tested.)*

Electron-shell requirements (apply only if a shell is added):

- `contextIsolation: true`
- `nodeIntegration: false`
- CSP with `script-src 'self'`, no `unsafe-inline`, no `unsafe-eval`
- no remote `http://` or third-party CDN script/style
- `will-navigate` allowlist
- `setWindowOpenHandler(() => ({ action: 'deny' }))`
- permission request handler default-deny

## Navigation URL Policy

Allowed protocols: `http:` and `https:` only.

Reject:

| Category | Examples |
| --- | --- |
| local files/internal browser | `file://`, `chrome://`, `chrome-extension://`, `about:` |
| loopback | `localhost`, `localhost.`, `127.0.0.0/8`, `::1`, IPv4-mapped IPv6 |
| unspecified | `0.0.0.0`, `::` |
| private/link-local | `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `fc00::/7`, `fe80::/10` |
| cloud metadata | `169.254.169.254`, `fd00:ec2::254` |
| IPv4 alternative encodings | decimal, octal, hex, mixed shorthand |
| userinfo | username/password URL forms |

Validation flow:

1. Parse with URL parser.
2. Normalize hostname: lowercase, trailing dot removed, IDN punycode, IPv6 canonical form.
3. Reject forbidden protocol, userinfo, literal host/IP forms.
4. Resolve all A/AAAA records for domain host.
5. Reject if any resolved IP is forbidden.
6. Start main-frame request interception.
7. Re-run full policy before each redirected/secondary main-frame request is sent.

If request interception cannot block before request is sent, unknown redirect is not MVP-safe and must return `navigation_redirect_requires_interception`.

### Connection-IP capability gate (ADR-0006)

Parse / canonicalize / DNS all-record precheck / redirect-before-send interception (above) do **not** by themselves make arbitrary navigation safe: DNS rebinding is a TOCTOU gap — a host can pass URL/DNS policy and then resolve to a forbidden IP at actual connect time. Closing it requires enforcing the **actual connection IP**, which the capture-form tier determines:

- **`strict-ip-enforced`**: a controlled local policy proxy resolves DNS itself, validates every A/AAAA/CNAME, and rejects forbidden ranges per connection. Only this tier may navigate **any** domain that passes URL policy.
- **`ip-observed-only`** / **`no-ip-observation`** (MVP default; CDP/extension forms): connection IP is at best observed post-connect (logged, **not** a security boundary). Navigation is restricted to a **static, human-maintained, strong-trust allowlist**.

User-supplied domains, wildcards, tenant/customer subdomains, short-link/redirector hosts, and operator-configurable CNAMEs are **never** allowlist-eligible — they require `strict-ip-enforced`. "Navigate then observe final IP" is never accepted (consistent with ADR-0002). See ADR-0006 for the tier matrix and the controlled-local-proxy path.

## Token Lifecycle

| Stage | Rule |
| --- | --- |
| generation | parent process generates high-entropy random token at startup |
| storage | daemon/high-level token is memory-only; the localhost HTTP UI bootstrap token prefers memory/sessionStorage and may use a short-TTL `0600` file fallback only under the Pure localhost HTTP shape rules above |
| ownership | UI/renderer never holds daemon/high-level token |
| injection | Local Service injects `X-byCLI` and optional `X-byCLI-Token` |
| logging | no token/cookie/Authorization/raw body |
| rotation | restart rotates; optional admin-only rotate invalidates old token |

## Seed Args

`executionSeedArgs`:

- raw values required only to execute adapter
- allowed in current request memory and 0600 private `input.json`
- deleted on done/cancel/timeout
- never appears in report, fixture, request status, logs or error details

`evidenceSeedArgs`:

- placeholder, type, length, session-keyed HMAC(SHA-256)
- safe for report/fixture/evidence
- salt is per recorder session and memory-only
- cross-session HMAC cannot be correlated
- `hmac` is `display_only` / same-session debug only; `comparableAcrossRuns=false`
- cross-run fixture matching must not compare HMAC values, only placeholder/type/length/arg name or schema shape

## Responsible Use And Site Policy

Recorder turns logged-in sites into local CLIs. That capability must stay within a responsible-use boundary.

- Recorder runs only in a browser context the user actively logged into and authorized.
- It does not bypass authentication, paywalls, anti-bot or access controls.
- Generated adapters carry default rate-limit / backoff config placeholders.
- UI prompts the user to confirm they are authorized to automate the target site before `init`.
- verify defaults to low concurrency; infinite loops and bulk scraping are disallowed.
- Reports record `responsibleUseAcknowledgedAt`, never sensitive identity data.

Local FeatureFlags exist (see `09` Feature Flags And Hot Reload); cloud-style gray-release / A-B testing is N/A for this single-user tool. High-risk capabilities still require config + explicit confirmation + security gates; flags default fail-closed and never bypass security/redaction/responsible-use boundaries.

## User-Owned Login Boundary

Recorder operates on a user-owned, already logged-in browser. It binds to an existing login session; it does not own credentials.

- Does not collect, store or log passwords or 2FA codes.
- Does not bypass login, paywalls, anti-bot or access controls.
- Does not export cookies; auth state stays in the user's browser profile/context.
- Only a redacted `authSignal` (cookie presence, login redirect status, DOM probe boolean) is persisted.

## Input JSON And FS Boundary

`input.json` rules:

- parent directory is random, private, `0700`
- parent owner/mode/realpath checked after creation
- file opened with exclusive create, `0600`
- path is not predictable or shared
- cleanup on done/cancel/timeout
- cleanup failure logs only redacted warning

Path allowlist is not an OS sandbox. Adapter JS still has same-user permissions. Strong FS/syscall isolation requires separate user, OS sandbox, container or VM.
