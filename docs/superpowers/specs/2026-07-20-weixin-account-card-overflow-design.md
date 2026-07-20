# Weixin Account-Card Overflow Design

## Goal

Make `weixin accounts` reliably open the WeChat official-account picker when
the `账号名片` entry is inside the editor's `#editor_showmore` overflow menu.

## Design

`captureSearchBizFingerprint` will first try a narrowly scoped WeChat-specific
route. It will locate a visible `#editor_showmore`, click that unique trigger,
then locate the unique visible `#js_editor_insertProfile` only within that
trigger's `.editor_showmore_dropdown_menu` menu. It will not use this route if
the trigger, menu, or profile entry is ambiguous.

The existing generic menu, direct-entry, and insert-toolbar heuristics remain
unchanged as fallbacks. The dialog search and `searchbiz` fingerprint capture
flow also remain unchanged.

## Safety and Failure Behavior

The concrete route is limited to the supplied WeChat editor IDs and to the
corresponding overflow menu, so it cannot select an account-card item from an
unrelated menu. If the menu is not yet visible after the trigger click, later
poll iterations retry the scoped selection. Existing manual-open and timeout
behavior remains the final fallback.

## Testing

Extend `fingerprint.test.js` with a fixture representing
`#editor_showmore > .editor_showmore_dropdown_menu > #js_editor_insertProfile`.
The test must prove that the implementation clicks the overflow trigger once,
clicks the profile entry once, obtains the fingerprint, and does not click the
formatting overflow or the dialog's insert button.
