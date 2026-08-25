# ima Reader Browser Bridge Capability Design

## Problem

The CLI can dispatch four private ima reader actions through the Browser Bridge:

- `ima-auth-start`
- `ima-auth-read`
- `ima-reader-request`
- `ima-auth-release`

The extension source implements these actions, but the extension handshake only advertises `focus-window-v1`. A daemon therefore cannot distinguish an extension build that supports private ima reading from an older or stale build that reports the same extension version. The resulting failure is either `Unknown action: ima-auth-start` or a command timeout before navigation begins.

## Goals

- Reject private ima commands immediately when the connected extension cannot prove support.
- Preserve all existing Browser Bridge commands and compatibility behavior.
- Ensure extension-side command failures always produce a response instead of leaving the daemon pending until timeout.
- Publish a uniquely versioned extension artifact containing the capability declaration.
- Prevent future release artifacts from changing without an extension version change.

## Considered Approaches

### Exact CLI/extension version matching

Require the extension and CLI to have identical versions. This is simple to explain but couples two independently released artifacts and forces extension releases for CLI-only changes. It is rejected.

### Minimum extension version checks

Treat a specific extension version as the first ima-compatible release. This works for immutable published artifacts but cannot distinguish stale or locally built artifacts that reuse the same manifest version. It is retained only as user-facing diagnostic context, not as the compatibility contract.

### Capability negotiation

Extend the existing handshake capability list with `ima-reader-v1`. Each ima action declares that capability as a prerequisite. This directly describes behavior, remains compatible with independent versioning, and follows the existing `focus-window-v1` pattern. This is the selected approach.

## Architecture

### Shared daemon capability policy

`src/browser/extension-capabilities.ts` defines `IMA_READER_CAPABILITY` and maps all four ima actions to it. `missingRequiredExtensionCapability` remains the single daemon-side gate. If the connected profile does not advertise the capability, `/command` returns HTTP 412 with `extension_capability_missing` before dispatching anything to Chrome.

The user-facing hint identifies the missing private ima reader capability and instructs the user to update and reload the Browser Bridge extension.

### Extension handshake

`extension/src/background.ts` advertises both `focus-window-v1` and `ima-reader-v1` in its hello payload. The capability means that all four ima actions are implemented as one coherent lifecycle; partial advertisement is not supported.

### Extension error response guarantee

The WebSocket message handler parses the command, retains its command ID, and always sends a structured failure response if command handling throws. Malformed messages without an ID remain log-only because the daemon cannot correlate a response. Valid command failures must never be reduced to a console log followed by a daemon timeout.

### Extension release identity

The extension version advances from 2.1.20 to 2.1.21 in `manifest.json`, `package.json`, and `package-lock.json`. CLI and extension versions remain independent.

The extension release workflow verifies that the three version sources match. It also rejects a release when extension runtime/package inputs changed since the previous extension release without a version increment. The packaged ZIP name continues to use the extension version.

## Error Flow

For an old extension:

1. Extension hello omits `ima-reader-v1`.
2. CLI sends `ima-auth-start` through the daemon.
3. Daemon rejects before WebSocket dispatch.
4. CLI receives `extension_capability_missing` with an update/reload hint.

For a current extension whose handler throws:

1. Extension receives a command with an ID.
2. The handler throws.
3. The extension sends `{ id, ok: false, error }`.
4. The daemon resolves the pending request immediately and forwards the structured error.

## Testing

- Unit-test capability mapping for all four ima actions and unaffected commands.
- Unit-test the daemon's HTTP 412 response for an ima action when the capability is absent.
- Unit-test that the extension hello advertises `ima-reader-v1`.
- Unit-test that an unexpected extension command failure sends a correlated error response.
- Add a release/version regression test covering manifest and package version agreement.
- Run focused unit tests, extension tests, type checking, CLI build, and extension build/package verification.

## Non-goals

- Changing ima API request behavior or authentication capture internals.
- Requiring CLI and extension versions to match exactly.
- Automatically installing or updating Chrome extensions.
- Changing existing profile selection behavior.
