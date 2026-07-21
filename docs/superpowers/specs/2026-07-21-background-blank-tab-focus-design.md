# Background blank-tab focus design

## Goal

Do not activate a newly created or released `about:blank` placeholder for a
background adapter session. Preserve foreground behavior for interactive browser
sessions and explicit foreground requests, including human login flows.

## Scope

Update the two fallback paths in the Browser Bridge extension that currently
activate a blank placeholder unconditionally:

- `resolveTabUnlocked()` when no debuggable tab can be reused.
- `releaseLeaseUnlocked()` when the final owned lease is reset to a reusable
  placeholder.

Both paths will set `active` from `getWindowMode(leaseKey) === 'foreground'`.

## Behavior

| Session mode | New/released blank tab |
| --- | --- |
| `background` (the default for adapters) | Created or reset without activation. |
| `foreground` (interactive browser or explicit request) | Remains activated. |

The change does not alter window creation, navigation, login focus, lease
lifetime, or cleanup.

## Verification

Add focused extension tests for both paths in background and foreground modes.
Run the relevant extension test file and the extension typecheck/build command
defined by the package scripts.
