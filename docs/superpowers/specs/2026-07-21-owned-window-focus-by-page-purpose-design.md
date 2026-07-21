# Owned-window focus by page purpose

## Goal

Keep a newly created or restored `about:blank` placeholder in the `byCLI Browser`
container from bringing Chrome to the foreground, while retaining foreground
behavior for `byCLI Adapter` work and for interactive Browser navigation to a
real page.

## Behaviour

| Surface and page purpose | Window/TAB activation |
| --- | --- |
| `byCLI Adapter`, including its blank placeholder | Foreground and active |
| `byCLI Browser` blank placeholder creation or release | Background and inactive |
| `byCLI Browser` navigation to an HTTP(S) page | Foreground and active |

## Design

The extension will derive an effective window mode from both the lease surface
and the requested page purpose instead of using one fixed mode for the entire
lease. A Browser lease remains interactive for real-page navigation, but its
placeholder create/reset paths explicitly use background mode. Adapter leases
remain foreground for every path.

The change will cover the owned-window creation/reuse call and the tab create
or reset options. Existing explicit `focus-window` behavior remains unchanged.

## Tests

Extension tests will first assert the desired calls: Browser blank creation and
release use `focused: false`/`active: false`; Adapter blank creation and
release use `focused: true`/`active: true`; Browser HTTP(S) navigation remains
foreground. The focused extension test file and the full test suite will run
after implementation.

## Scope

No change to user-bound tabs, no change to explicit focus commands, and no
change to the visible tab-group names.
