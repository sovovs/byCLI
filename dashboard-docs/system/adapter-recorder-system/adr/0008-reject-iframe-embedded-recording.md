# ADR 0008 · Reject Iframe-Embedded Recording In The Dashboard

## Status

Accepted. The recorded page stays a real, extension-owned top-level browser tab driven over CDP (consistent with ADR 0002). The dashboard does **not** embed the third-party target site in an `<iframe>`.

## Decision

A recurring UX proposal is to reuse the current byCLI surface and open the recording target **inside the dashboard page via an iframe**, instead of the extension opening a separate byCLI browser tab. We reject this. Recording continues to happen in a real top-level tab that the extension owns (`chrome.tabs.create` / `chrome.windows.create`) and drives with the CDP debugger; the dashboard remains the control UI only.

## Context

Three independent hard blockers — any one alone is fatal:

1. **The recording mechanism is incompatible with an iframe (root cause).** Capture is not content-script injection; it is the extension attaching the CDP debugger to a real top-level tab and reading the Network domain: `chrome.debugger.attach({ tabId }, '1.3')` + `Network.enable`, listening to `Network.requestWillBeSent` / `responseReceived` / `loadingFinished` (`extension/src/cdp.ts:108,655-666,819-888`). An iframe is **not** a `tabId`; the extension cannot obtain a debuggee handle for it, so the entire Network capture has nothing to attach to. The dashboard-be page lease, state machine, and `page_lost` fail-fast are all built around the lifecycle of one real tab (`dashboard-be/src/server.ts:250-264`, `dashboard-be/src/session/stateMachine.ts:63-69`). The extension also ships **no** `content_scripts` / `scripting` permission (`extension/manifest.json:6-18`), so there is no fallback to an injected in-page fetch/XHR hook either.
2. **Target sites refuse to be embedded (third-party controlled, unbypassable).** Most real sites send `X-Frame-Options: DENY` or CSP `frame-ancestors`. The login pages most often needed for recording are the ones most likely to forbid framing.
3. **Cross-origin isolation + the dashboard's own CSP.** The dashboard (`127.0.0.1:19826`, or `:8000` in dev) and any third-party target are fully cross-origin; the parent page cannot read the iframe's DOM, cookies, or network. The dashboard's own response CSP is `default-src 'self'` (`dashboard-be/src/static.ts:19-32`); a non-same-origin iframe `src` is rejected by the **parent** page's CSP before the target's own frame-busting even applies.

## Consequences

- The capture step keeps using a real extension-owned tab. Any UX improvement to reduce the "new tab" context switch must work **within** that constraint — e.g. window raise/focus, split-screen hints, refocusing the dashboard after capture completes — not by embedding the site.
- **CDP screencast is the only viable path to true in-page embedded operation, and is not implemented.** `Page.startScreencast` would stream the controlled tab's frames into a dashboard `<canvas>`, with `Input.dispatchMouseEvent` / `dispatchKeyEvent` forwarding user input back to the real tab. The recorded tab stays a real extension-owned tab, so the capture chain is unchanged. The cost is frame transport + input forwarding (a `FEATURE_DIRECT_CDP_CAPTURE` flag is reserved for this) — deferred until the in-page operation experience is a product requirement.
- An Electron `webview`/`BrowserView` (the production renderer channel envisioned in ADR 0001) is the other theoretical embed path, but no Electron shell exists in this repo.
- Related ADRs: `0001-ui-channel.md` (renderer holds no daemon token; dashboard is control UI), `0002-request-interception.md` and `0006-dns-rebinding-ip-enforcement.md` (the "real tab + CDP" capability premise this decision depends on).

## Revision (2026-06-29) · Hybrid recording modes — narrowed, not overturned

The original rejection targeted iframe embedding **as the universal recording mechanism**. Two later developments narrow it without overturning the core "real tab + CDP" premise:

- **Blocker 1 (iframe can't attach CDP) is dissolved when we attach the *dashboard's own* top-level tab.** The dashboard tab *is* a `tabId`; a cross-origin target embedded in it becomes an OOPIF that flat `Target.setAutoAttach` surfaces as a child CDP session (per-`sessionId`), and its Network/UI events carry `frameSessionId`/`frameUrl`. Real-machine verified (juejin). So capture *can* attach — the recorded surface is still a real top-level tab (the dashboard's), consistent with ADR 0002.
- **Blocker 3 (dashboard CSP) is solvable** by adding `frame-src` to `buildCsp` (`dashboard-be/src/static.ts`), gated behind `FEATURE_EMBEDDED_IFRAME_RECORDING` (default off). B+A scheme: flag off → no `frame-src` (current behavior); flag on → `frame-src https:` (or a configured `RECORDER_IFRAME_FRAME_SRC` origin allowlist). `script-src 'self'+nonce` (the real XSS-in-UI defense) is untouched; this is classified a privileged/local recording mode.
- **Blocker 2 (target sites refuse framing) remains fatal and unbypassable** — which is exactly why iframe mode serves **only non-framebusting public sites**, and login/framebusting sites stay on **tab projection** (screencast-style: target in an extension-owned tab, pixels projected into the dashboard, Input forwarded back — not an iframe, so X-Frame-Options never applies).

**Net decision**: two coexisting modes, user-selected at bind time. `tab_projection` (default, universal) keeps the original real-tab model. `embedded_iframe` (flag-gated, public sites) embeds the target in the dashboard tab + filters top-level dashboard noise by `frameSessionId` (+descendants); on framebust it falls back with a "switch to projection" prompt. The debugger infobar landing on the dashboard's own tab is an accepted product tradeoff. Full plan + Codex adjudication: `dashboard-inline-recording-screencast` memory + module 12.
