# byCLI 2.1.55 Release and Weixin Reference Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring ByClaw's Weixin executor reference into exact alignment with the current 21-command byCLI Weixin surface, release the rename and documentation updates as `@sovovs/bycli` 2.1.55, and verify both GitHub Release and npm publication.

**Architecture:** Treat OpenCLI as the command and release source of truth and ByClaw as a downstream consumer. Lock the downstream documentation contract with a focused test before expanding the reference, keep remote mutations distinct from local artifact writes, then bump only the root OpenCLI package version. Publish by pushing `main` first and an annotated `v2.1.55` tag only after main CI succeeds; the existing tag workflow owns GitHub Release and npm publication.

**Tech Stack:** Markdown, Python `unittest`, Node.js 22, npm, Vitest, TypeScript, VitePress, Git, GitHub Actions, GitHub CLI.

---

## File structure

- Modify `/Users/lijiahui/Desktop/whaleBI/byclaw-all/middleware/openclaw/tests/test_knowledge_collection_skill.py`: assert the reference version, exact canonical command inventory, aliases, renamed command, and parent routing rule.
- Modify `/Users/lijiahui/Desktop/whaleBI/byclaw-all/middleware/openclaw/skills/bycli/references/weixin.md`: document all 21 commands and update execution, authentication, output, and write-safety guidance for byCLI 2.1.55.
- Modify `/Users/lijiahui/Desktop/whaleBI/byclaw-all/middleware/openclaw/skills/bycli/SKILL.md`: replace the stale `accounts` command in the mandatory Weixin-reference loading rule and update the verified version marker.
- Modify `/Users/lijiahui/Desktop/OpenCLI/package.json`: bump the root package version from 2.1.54 to 2.1.55.
- Modify `/Users/lijiahui/Desktop/OpenCLI/package-lock.json`: keep the root package and root lock entry at 2.1.55 without changing workspace package versions.

### Task 1: Lock the downstream Weixin reference contract with failing tests

**Files:**
- Modify: `/Users/lijiahui/Desktop/whaleBI/byclaw-all/middleware/openclaw/tests/test_knowledge_collection_skill.py:566-765`

- [ ] **Step 1: Add the exact canonical command inventory near the existing test constants**

Add this immutable set after `CHILD_SKILLS`:

```python
WEIXIN_COMMANDS = {
    "article-fetch",
    "articles",
    "collection-detail",
    "collections",
    "create-draft",
    "create-newspic",
    "download",
    "download-publish-data",
    "drafts",
    "freepublish-get",
    "freepublish-list",
    "get-public-account-info",
    "home-overview",
    "open-platform-authorizer-info",
    "published",
    "published-articles",
    "save-articles",
    "sougousearch",
    "user-attributes",
    "user-growth",
    "user-info",
}
```

- [ ] **Step 2: Add a focused command-surface test**

Place the new test after `test_bycli_uses_flat_weixin_executor_reference`:

```python
def test_weixin_reference_tracks_the_2_1_55_command_surface(self):
    bycli = (SKILLS_ROOT / "bycli" / "SKILL.md").read_text(encoding="utf-8")
    weixin = (SKILLS_ROOT / "bycli" / "references" / "weixin.md").read_text(encoding="utf-8")
    commands = markdown_section(weixin, "Command selection")

    documented = set(
        re.findall(r"^\| `([a-z0-9-]+)(?: [^`]*)?` \|", commands, re.MULTILINE)
    )
    self.assertEqual(WEIXIN_COMMANDS, documented)
    self.assertIn("`@sovovs/bycli` 2.1.55", weixin)
    self.assertIn("Aliases: `overview`, `dashboard`, `fans`", commands)
    self.assertIn("Alias: `userInfo`", commands)
    self.assertIn("including `get-public-account-info/articles", bycli)
    self.assertNotRegex(weixin, r"`(?:bycli weixin )?accounts(?:\s|`)")
    self.assertNotIn("including `accounts/", bycli)
```

- [ ] **Step 3: Update existing version and rename assertions to the new contract**

In `test_weixin_login_gate_uses_persistent_logical_operation_state` and `test_weixin_reference_closes_executor_terminal_states`:

- replace all `2.1.44` expectations with `2.1.55`;
- replace the remaining expected `accounts` command phrases with `get-public-account-info`;
- retain all terminal-state, login-gate, artifact, retry-budget, and security assertions unchanged.

- [ ] **Step 4: Run the focused test and verify it fails for the intended gaps**

Run from `/Users/lijiahui/Desktop/whaleBI/byclaw-all`:

```bash
rtk python -m unittest middleware/openclaw/tests/test_knowledge_collection_skill.py
```

Expected: FAIL because `weixin.md` still declares 2.1.44 and documents only 11 of the 21 canonical commands; `SKILL.md` also still names `accounts` in its mandatory reference-loading rule. Do not proceed if the failure is a Python/import error rather than a contract assertion.

### Task 2: Expand and correct the ByClaw Weixin executor reference

**Files:**
- Modify: `/Users/lijiahui/Desktop/whaleBI/byclaw-all/middleware/openclaw/skills/bycli/references/weixin.md`
- Modify: `/Users/lijiahui/Desktop/whaleBI/byclaw-all/middleware/openclaw/skills/bycli/SKILL.md:85`

- [ ] **Step 1: Update the tracked byCLI version and complete the command table**

Change both compatibility markers to 2.1.55. Keep the existing detailed rows and add the ten missing canonical commands so the `Command selection` table contains exactly these 21 commands:

```text
article-fetch, articles, collection-detail, collections, create-draft,
create-newspic, download, download-publish-data, drafts, freepublish-get,
freepublish-list, get-public-account-info, home-overview,
open-platform-authorizer-info, published, published-articles, save-articles,
sougousearch, user-attributes, user-growth, user-info
```

Document the aliases in their canonical rows:

```markdown
Aliases: `overview`, `dashboard`, `fans`.
Alias: `userInfo`.
```

Use the manifest's access values exactly. In particular, keep `save-articles`, `download-publish-data`, `create-draft`, `create-newspic`, and `user-growth` marked `write`; explain later that some of these write local artifacts rather than mutating the public account.

- [ ] **Step 2: Add routing guidance for the newly documented read surfaces**

Extend command-selection prose with these boundaries:

- `home-overview` is account-level dashboard data; use `published` for per-article browser metrics.
- `published-articles` is the unified official-API/browser listing surface; `freepublish-list` and `freepublish-get` are explicit official API surfaces.
- `article-fetch` retrieves one published article by article ID or URL with optional fallback; `download` remains the browser-backed Markdown path for a trusted public article URL.
- `user-info`, `user-growth`, and `user-attributes` cover account settings, growth trends/export, and audience dimensions respectively.
- `open-platform-authorizer-info` is only for third-party-platform authorization context, not the current browser account.

Do not weaken the existing identity-proof rule: only `get-public-account-info` establishes the nickname-to-`fakeid` binding used by `articles` and `save-articles`.

- [ ] **Step 3: Separate remote mutations from local artifact writes**

Expand `Direct command safeguards` with a compact classification:

- Remote account mutations requiring explicit user intent and approved final inputs: `create-draft` and `create-newspic`.
- Read operations that may create local files: `article-fetch`, `freepublish-list`, `freepublish-get`, `published-articles`, and `download` when their content/output options request files.
- Manifest `write` commands whose main side effect is a local artifact: `save-articles`, `download-publish-data`, and `user-growth --output`; never describe these as publishing or changing the official account.

For `create-newspic`, require explicit creation intent, final title/image list approval, AppID/AppSecret handling consistent with the existing secret rules, and no claim that the operation publicly publishes content.

- [ ] **Step 4: Correct authentication and browser routing**

Update `Browser session` and `Environment authentication` so they distinguish:

- browser-backed commands, which always run through `scripts/weixin-login-gate.mjs`;
- conditional commands, which follow structured help and only use the gate when the chosen path is browser-backed;
- API-only commands, which must not run browser preflight or the login gate.

Retain `--auth-source env` only for `get-public-account-info`, `articles`, and `save-articles`. Document AppID/AppSecret or access-token inputs for the official API family without displaying, logging, persisting, or requesting literal credential values in chat.

Replace stale wording that implies an unauthenticated command waits internally for 180 seconds. State that an immediate typed `AUTH_REQUIRED` enters the human verification gate; a gate-level timeout is owned by the login-gate runner, while `create-draft --timeout` remains a command-specific editor timeout.

- [ ] **Step 5: Complete returned-record and artifact guidance**

Add concise output handling for the new command families:

- preserve article IDs, titles, URLs, publication metadata, source, fallback path, and content/file status for `published-articles`, `freepublish-*`, and `article-fetch`;
- validate every returned local path as a readable non-empty regular file before claiming delivery;
- preserve overview totals and zero-valued metrics;
- preserve user-growth date range/source plus any exported XLS path;
- preserve all dimensions requested from `user-attributes` and all tab/source metadata from `user-info`;
- preserve authorization identity fields from `open-platform-authorizer-info` without exposing credentials.

- [ ] **Step 6: Update the parent ByClaw skill routing marker**

In `middleware/openclaw/skills/bycli/SKILL.md`, replace:

```markdown
including `accounts/articles/sougousearch/save-articles/download`
```

with:

```markdown
including `get-public-account-info/articles/sougousearch/save-articles/download`
```

Also change its verified runner version marker from `byCLI 2.1.44` to `byCLI 2.1.55`; do not change unrelated executor policy.

- [ ] **Step 7: Run the downstream contract test**

Run:

```bash
rtk python -m unittest middleware/openclaw/tests/test_knowledge_collection_skill.py
```

Expected: all tests PASS.

- [ ] **Step 8: Review the downstream diff for scope and secrets**

Run:

```bash
rtk git diff --check
rtk git diff -- middleware/openclaw/skills/bycli/SKILL.md middleware/openclaw/skills/bycli/references/weixin.md middleware/openclaw/tests/test_knowledge_collection_skill.py
rtk rg -n 'bycli weixin accounts|`accounts`|2\.1\.44' middleware/openclaw/skills/bycli middleware/openclaw/tests/test_knowledge_collection_skill.py
```

Expected: `git diff --check` exits 0; the scoped diff contains only the approved reference/test work; the final search returns no stale command/version matches. Preserve the unrelated untracked `middleware/openclaw/skills/knowledge-collection/references/performance-validation.md` file untouched.

- [ ] **Step 9: Commit only the approved ByClaw paths**

Run:

```bash
rtk git add middleware/openclaw/skills/bycli/SKILL.md middleware/openclaw/skills/bycli/references/weixin.md middleware/openclaw/tests/test_knowledge_collection_skill.py
rtk git commit -m "docs(bycli): sync weixin 2.1.55 reference"
```

Expected: one commit on the current ByClaw `develop` branch. Do not push the ByClaw repository because the user requested push/release only for OpenCLI.

### Task 3: Bump the OpenCLI root package to 2.1.55

**Files:**
- Modify: `/Users/lijiahui/Desktop/OpenCLI/package.json:3`
- Modify: `/Users/lijiahui/Desktop/OpenCLI/package-lock.json:3,9`

- [ ] **Step 1: Confirm the release target is still free and the worktree contains only the approved history**

Run from `/Users/lijiahui/Desktop/OpenCLI`:

```bash
rtk git fetch origin --tags
rtk git status --short --branch
rtk git tag --list v2.1.55
rtk git ls-remote --tags origin refs/tags/v2.1.55
rtk npm view @sovovs/bycli@2.1.55 version
```

Expected: local and remote tag checks are empty and npm reports that 2.1.55 is not published. If any target already exists, stop instead of replacing a tag or republishing a version. Confirm the branch is `main`; do not create a release branch.

- [ ] **Step 2: Bump only the root package version**

Use `apply_patch` to change:

```json
"version": "2.1.54"
```

to:

```json
"version": "2.1.55"
```

in `package.json` and both root-version locations in `package-lock.json`. Do not change `extension/package.json` or workspace package versions; the extension source has no changes since its last versioned release.

- [ ] **Step 3: Verify version consistency before the full suite**

Run:

```bash
rtk node -e 'const p=require("./package.json"); const l=require("./package-lock.json"); if(p.version!=="2.1.55"||l.version!=="2.1.55"||l.packages[""].version!=="2.1.55") process.exit(1)'
rtk npm run build
rtk git diff --exit-code -- cli-manifest.json
rtk npx vitest run --project e2e tests/e2e/management.test.ts
```

Expected: the three root versions equal 2.1.55, the build succeeds, the manifest has no drift, and the CLI management E2E test passes.

- [ ] **Step 4: Run release-equivalent verification**

Run each command separately:

```bash
rtk npm run typecheck
rtk npm test
rtk npm run test:e2e
rtk npm run docs:build
rtk npm run check:package-install
rtk npm test --workspace @sovovs/bycli-recorder-core
```

Expected: all commands exit 0. If a failure is caused by the version bump or rename, fix it and rerun the focused failing test followed by this complete set. If a failure is environmental or unrelated, stop and report evidence rather than weakening tests.

- [ ] **Step 5: Review and commit the release bump**

Run:

```bash
rtk git diff --check
rtk git diff -- package.json package-lock.json
rtk git status --short
rtk git add package.json package-lock.json
rtk git commit -m "chore: release v2.1.55"
```

Expected: the release commit changes only the two root package files and the OpenCLI worktree is clean afterward.

### Task 4: Push OpenCLI main and require green CI

- [ ] **Step 1: Reconcile with the remote without force**

Run:

```bash
rtk git fetch origin
rtk git status --short --branch
rtk git rev-list --left-right --count origin/main...main
```

Expected: a clean `main` branch with zero commits on the remote-only side. If `origin/main` advanced, rebase the clean local commits onto it and rerun the release-equivalent verification; stop on any conflict. Never force-push.

- [ ] **Step 2: Push main**

Run:

```bash
rtk git push origin main
```

Expected: the push succeeds as a fast-forward.

- [ ] **Step 3: Wait for the pushed main checks**

Use GitHub CLI to identify the runs for the pushed release commit, then watch each required workflow to completion:

```bash
rtk gh run list --branch main --commit "$(git rev-parse HEAD)" --limit 20
rtk gh run watch <run-id> --exit-status
```

Expected: all required main-branch workflows for the release commit succeed. Do not create or push the release tag while any required run is pending or failed.

### Task 5: Create the immutable release tag and verify publication

- [ ] **Step 1: Recheck tag and package availability immediately before tagging**

Run:

```bash
rtk git tag --list v2.1.55
rtk git ls-remote --tags origin refs/tags/v2.1.55
rtk npm view @sovovs/bycli@2.1.55 version
```

Expected: all three targets remain absent. Stop if any now exists.

- [ ] **Step 2: Create and push the annotated tag**

Run:

```bash
rtk git tag -a v2.1.55 -m "chore: release v2.1.55"
rtk git push origin v2.1.55
```

Expected: the annotated tag points at the verified `chore: release v2.1.55` commit and the push succeeds. Never replace, delete, or force-update the tag.

- [ ] **Step 3: Wait for the tag-triggered Release workflow**

Run:

```bash
rtk gh run list --workflow Release --branch v2.1.55 --limit 10
rtk gh run watch <release-run-id> --exit-status
```

Expected: the Release workflow completes successfully, including build, typecheck, manifest drift check, installable-tarball check, extension packaging, GitHub Release creation, and npm publication. If it fails, preserve the tag and report the failing job; do not publish directly with npm and do not retry by moving the tag.

- [ ] **Step 4: Verify the public release artifacts**

Run:

```bash
rtk gh release view v2.1.55 --json tagName,isDraft,isPrerelease,url,assets
rtk npm view @sovovs/bycli@2.1.55 version dist-tags --json
rtk git status --short --branch
```

Expected: GitHub reports a non-draft, non-prerelease `v2.1.55` release with the extension ZIP asset; npm reports version 2.1.55; local `main` is clean and synchronized with `origin/main`.

- [ ] **Step 5: Report the final handoff**

Provide:

- the ByClaw commit hash, noting it remains local unless separately requested for push;
- the OpenCLI release commit hash;
- the `v2.1.55` GitHub Release URL;
- confirmation that `@sovovs/bycli@2.1.55` is visible on npm;
- the exact verification results and any intentionally untouched unrelated file.
