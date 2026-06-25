# ADR 0001 · Default UI Channel

## Status

Accepted for MVP.

## Decision

Default UI channel is Electron renderer -> preload allowlist -> main process / Recorder Local Service. Pure localhost web UI remains optional.

## Context

Recorder operations can navigate a logged-in browser, capture network data, generate files and execute verify. A browser-reachable localhost HTTP API must defend against cross-origin pages. Electron IPC avoids normal browser CSRF if preload and main process are restricted.

## Consequences

- Renderer never receives daemon/high-level token.
- Preload exposes only typed allowlisted methods.
- Main process validates sender URL and params.
- Electron XSS defenses are mandatory.
- If localhost HTTP UI is enabled (`FEATURE_LOCALHOST_HTTP_UI`), it must implement Origin/header/CSRF gates plus a startup random token (see `04` Pure localhost HTTP shape).
