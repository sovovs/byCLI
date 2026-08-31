# Weixin Get Public Account Info Command Rename Design

## Goal

Rename the existing `bycli weixin accounts <query>` command to
`bycli weixin get-public-account-info <query>` across the implementation,
tests, generated command metadata, user documentation, and the ByClaw Weixin
executor reference. The old `accounts` command will not remain as an alias.

This is a command-surface rename only. Search behavior, authentication,
arguments, output columns, errors, and browser interaction remain unchanged.

## Command contract

The sole public command name becomes:

```bash
bycli weixin get-public-account-info <query>
```

It retains the current options:

- `--limit`, defaulting to 10;
- `--auth-source browser|env`, defaulting to `browser`;
- the repository-wide output-format options supplied by byCLI.

It continues to search WeChat official accounts and return `nickname`,
`fakeid`, and `alias`. Existing typed argument, authentication, empty-result,
and execution errors keep their current semantics, except that user-facing
operation labels identify `weixin get-public-account-info` instead of
`weixin accounts` where applicable.

## Rename boundaries

The implementation file and exported command identifier will be renamed to
match the new public command. Focused and end-to-end tests will import and look
up `get-public-account-info`; no test will expect `weixin/accounts` to remain
registered.

References in the active Weixin adapter documentation, command examples, and
the `articles` and `save-articles` argument help will name the new command as
the source of a `fakeid`. Generated manifests and command documentation will be
updated through the repository's existing generation process rather than by
hand-editing generated output.

The external executor reference at
`/Users/lijiahui/Desktop/whaleBI/byclaw-all/middleware/openclaw/skills/bycli/references/weixin.md`
will receive a semantic rename throughout. Its command table, identity
selection flow, exact-match and fallback rules, environment credential matrix,
login-gate examples, and explanatory prose will all use
`get-public-account-info`. The underlying identity-proof rules do not change.

Historical design material that is still published as executable guidance will
be updated when it contains runnable examples of the removed name. Generated
site output is not edited directly.

## Compatibility

There is deliberately no `accounts` alias or deprecation period. After the
change, `bycli weixin accounts` is an unknown command. Repository search found
no executable automation invoking the old command; known in-repository callers
are tests, help text, and documentation. External consumers must migrate to the
new name.

The command's positional and optional arguments and result shape are unchanged,
so migrating a caller requires replacing only the command token.

## Verification

Verification will cover:

- focused command registration and behavior tests;
- the Weixin history end-to-end test using the new registry key;
- confirmation that the old registry key is absent;
- generated command manifest and documentation checks;
- searches across the implementation, active documentation, tests, and the
  ByClaw executor reference for stale executable uses of
  `bycli weixin accounts` or standalone command references to `accounts`;
- the repository's relevant type and test checks.

No live WeChat write action is involved in this rename.
