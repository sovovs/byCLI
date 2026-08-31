# byCLI 2.1.55 Release and Weixin Reference Sync Design

## Goal

Release `@sovovs/bycli` 2.1.55 with the completed
`get-public-account-info` rename, and bring the downstream ByClaw Weixin
executor reference into contract-level alignment with the complete Weixin
command surface shipped by that release.

## OpenCLI release contract

The root package version will advance from `2.1.54` to `2.1.55` in
`package.json` and both root-version fields in `package-lock.json`. No other
workspace version changes are required. In particular, the browser extension
remains at 2.1.21 because there are no extension changes between
`ext-v2.1.21` and the release candidate.

The release commit will use the existing convention:

```text
chore: release v2.1.55
```

After local verification, `main` will be synchronized with `origin/main` and
pushed. The release will use an annotated `v2.1.55` tag with the same release
message. Pushing that tag invokes the repository's release workflow, which
builds and verifies the package, creates the GitHub Release and extension ZIP,
and publishes the root npm package when the version is not already present.
The release workflow must be observed to a terminal result; a failed workflow
is reported rather than treated as a completed release.

## ByClaw reference coverage

The downstream file
`middleware/openclaw/skills/bycli/references/weixin.md` will identify 2.1.55 as
its tracked byCLI version and cover all 21 canonical Weixin commands in the
generated OpenCLI manifest:

- `article-fetch`
- `articles`
- `collection-detail`
- `collections`
- `create-draft`
- `create-newspic`
- `download`
- `download-publish-data`
- `drafts`
- `freepublish-get`
- `freepublish-list`
- `get-public-account-info`
- `home-overview`
- `open-platform-authorizer-info`
- `published`
- `published-articles`
- `save-articles`
- `sougousearch`
- `user-attributes`
- `user-growth`
- `user-info`

The `userInfo` alias and the `home-overview` discovery aliases `overview`,
`dashboard`, and `fans` will be documented without presenting them as separate
canonical commands.

The command-selection table will become the concise inventory and routing
entry point. Detailed guidance will remain grouped by workflow rather than
duplicating every structured-help field:

- official-account identity, history, Sogou discovery, and local article
  saving;
- account overview, settings, follower growth, and audience attributes;
- official published-article API reads and controlled browser fallback;
- third-party-platform authorizer information;
- browser/API draft creation and API-only image-post draft creation;
- collections, published analytics, downloads, authentication gates, and
  terminal-state handling.

## Safety and authentication corrections

The reference will distinguish remote writes from local artifact writes.
`create-draft` and `create-newspic` mutate Weixin; `save-articles`,
`download-publish-data`, and optionally `user-growth --output` write local
files. Read commands must not be described as writes merely because they use an
authenticated browser.

The login text will match the current authentication contract: an
unauthenticated Official Account browser session returns `AUTH_REQUIRED` and
enters the existing retained-tab human confirmation gate. It will not claim
that the command itself waits 180 seconds for QR login. A top-level login
`TIMEOUT`, when produced by the surrounding runner or browser execution budget,
continues to use the same gate and single-rerun policy.

Official API credential requirements will be explicit and separated:

- `freepublish-list`, `freepublish-get`, `published-articles`, and
  `article-fetch` use Official Account API credentials or an explicitly managed
  access token according to structured help;
- `open-platform-authorizer-info` uses component-app credentials, a current
  component verification ticket, and the target authorizer AppID;
- `create-draft` and `create-newspic` retain their distinct write and uncertain
  outcome rules;
- browser Cookie/token/fingerprint authentication is not mixed with either API
  credential family.

The parent ByClaw `middleware/openclaw/skills/bycli/SKILL.md` will replace its
stale `accounts` example with `get-public-account-info` so that the reference
loading rule matches the released command surface.

## Verification and drift prevention

ByClaw tests will assert that the reference:

- declares byCLI 2.1.55;
- includes every canonical Weixin command in its command-selection inventory;
- documents the expected aliases;
- contains no executable or routing reference to the removed `accounts`
  command;
- preserves the login gate, credential separation, local-file validation, and
  uncertain-write safeguards.

OpenCLI release verification will run the focused Weixin tests, the complete
unit/extension/adapter suite, type checking, package build with manifest drift
checking, VitePress documentation build, and installable-package validation.
Git status and tag/version consistency will be checked immediately before
push. After the tag push, the GitHub release workflow and the published npm
version will be verified before reporting the release complete.

No force push, tag replacement, direct npm publish, or unrelated ByClaw change
is authorized by this design.
