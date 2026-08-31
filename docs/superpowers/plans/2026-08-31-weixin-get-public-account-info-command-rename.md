# Weixin Get Public Account Info Command Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely rename `bycli weixin accounts` to `bycli weixin get-public-account-info` without an alias while preserving its behavior and updating every active consumer and reference.

**Architecture:** Keep the existing Weixin search helpers and command behavior intact, but rename the command facade, registry key, tests, generated manifest entry, help text, and documentation. Treat the ByClaw Weixin executor reference as a separate downstream consumer and update its identity-proof workflow semantically, not with an indiscriminate replacement of the English word “accounts.”

**Tech Stack:** Node.js 20+, ESM JavaScript/TypeScript, Vitest, byCLI registry and manifest builder, VitePress Markdown.

---

## File structure

- Rename `clis/weixin/accounts.js` to `clis/weixin/get-public-account-info.js`: register the new command name and retain the existing search implementation.
- Rename `clis/weixin/accounts.test.js` to `clis/weixin/get-public-account-info.test.js`: prove the new registry contract and absence of the old key.
- Modify `tests/e2e/weixin-history.test.ts`: load and exercise the renamed command facade.
- Modify `clis/weixin/articles.js` and `clis/weixin/save-articles.js`: point `fakeid` help to the new discovery command.
- Modify `docs/adapters/browser/weixin.md`: update the active adapter guide and runnable examples.
- Modify `docs/2026-07-14-bycli-plugin-wechat-design.md`: update published runnable guidance and file naming for the removed command.
- Modify `cli-manifest.json`: regenerate the tracked manifest from source.
- Modify `/Users/lijiahui/Desktop/whaleBI/byclaw-all/middleware/openclaw/skills/bycli/references/weixin.md`: migrate the downstream executor rules and examples.

### Task 1: Rename the focused command contract test and implementation

**Files:**
- Rename: `clis/weixin/accounts.test.js` → `clis/weixin/get-public-account-info.test.js`
- Rename: `clis/weixin/accounts.js` → `clis/weixin/get-public-account-info.js`

- [ ] **Step 1: Rename the test file and make it assert the new registry contract**

Use `apply_patch` to create `clis/weixin/get-public-account-info.test.js` from the existing test and delete `clis/weixin/accounts.test.js`. Keep the behavior tests unchanged, but use these registration assertions:

```js
await import('./get-public-account-info.js');

describe('weixin get-public-account-info command', () => {
  const command = getRegistry().get('weixin/get-public-account-info');
  beforeEach(() => vi.resetAllMocks());

  it('registers only the renamed metadata and conditional browser predicate', () => {
    expect(command).toMatchObject({
      site: 'weixin',
      name: 'get-public-account-info',
      access: 'read',
      strategy: 'intercept',
      domain: 'mp.weixin.qq.com',
      browser: 'conditional',
      columns: ['nickname', 'fakeid', 'alias'],
    });
    expect(getRegistry().has('weixin/accounts')).toBe(false);
    expect(command.requiresBrowser({ 'auth-source': 'browser' })).toBe(true);
    expect(command.requiresBrowser({ 'auth-source': 'env' })).toBe(false);
    expect(() => command.requiresBrowser({ 'auth-source': 'invalid' })).toThrowError(
      expect.objectContaining({ code: 'ARGUMENT' }),
    );
  });
```

Retain the existing argument assertions and both behavior tests for browser credentials, environment credentials, result projection, and empty-result handling.

- [ ] **Step 2: Run the focused test and verify the new facade is missing**

Run:

```bash
rtk npx vitest run --project adapter clis/weixin/get-public-account-info.test.js
```

Expected: FAIL because `./get-public-account-info.js` does not exist.

- [ ] **Step 3: Rename the implementation and register the new command**

Use `apply_patch` to create `clis/weixin/get-public-account-info.js` and delete `clis/weixin/accounts.js`. Preserve the existing imports and function body, changing only the exported identifier, registered name, and empty-result operation label:

```js
import { ArgumentError, EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { readEnvironmentCredentials, resolveBrowserCredentials } from './_wechat/auth-session.js';
import { captureSearchBizFingerprint } from './_wechat/fingerprint.js';
import { executeSearchBiz } from './_wechat/search-biz.js';
import { readAuthSource } from './_wechat/args.js';

const DOMAIN = 'mp.weixin.qq.com';
const browserRequired = args => readAuthSource(args) === 'browser';

export const getPublicAccountInfoCommand = cli({
  site: 'weixin', name: 'get-public-account-info', access: 'read', domain: DOMAIN,
  description: 'Search WeChat official accounts and return their fakeids',
  strategy: Strategy.INTERCEPT, browser: browserRequired,
  args: [
    { name: 'query', positional: true, required: true, help: 'Official-account name to search for' },
    { name: 'limit', type: 'int', default: 10, help: 'Maximum number of matching accounts to return' },
    { name: 'auth-source', default: 'browser', choices: ['browser', 'env'], help: 'Credential source: browser session or environment variables' },
  ],
  columns: ['nickname', 'fakeid', 'alias'],
  func: async (page, args) => {
    const query = String(args.query ?? '').trim();
    if (!query) throw new ArgumentError('query is required');
    const limit = args.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new ArgumentError('limit must be a positive safe integer');
    const authSource = readAuthSource(args);
    let credentials;
    if (authSource === 'env') {
      credentials = readEnvironmentCredentials(true);
    } else {
      credentials = await resolveBrowserCredentials(page);
      credentials = { ...credentials, fingerprint: await captureSearchBizFingerprint(page, query) };
    }
    const rows = await executeSearchBiz({ page, source: authSource, credentials, query, limit });
    if (rows.length === 0) {
      throw new EmptyResultError(
        'weixin get-public-account-info',
        `No official accounts matched "${query}".`,
      );
    }
    return rows.map(row => ({ nickname: row.nickname, fakeid: row.fakeid, alias: row.alias || null }));
  },
});
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
rtk npx vitest run --project adapter clis/weixin/get-public-account-info.test.js
```

Expected: all tests in the file PASS and the old registry key assertion passes.

- [ ] **Step 5: Commit the command rename**

```bash
rtk git add clis/weixin/accounts.js clis/weixin/accounts.test.js clis/weixin/get-public-account-info.js clis/weixin/get-public-account-info.test.js
rtk git commit -m "refactor(weixin): rename public account lookup command"
```

### Task 2: Update the Weixin integration workflow

**Files:**
- Modify: `tests/e2e/weixin-history.test.ts:36`
- Modify: `tests/e2e/weixin-history.test.ts:111-132`

- [ ] **Step 1: Update the integration import and lookup**

Apply these exact semantic changes while preserving the existing browser fixture and assertions:

```ts
beforeAll(async () => {
  await Promise.all([
    import('../../clis/weixin/get-public-account-info.js'),
    import('../../clis/weixin/articles.js'),
    import('../../clis/weixin/save-articles.js'),
  ]);
});
```

```ts
it('runs the registered browser get-public-account-info command and preserves two similar candidates', async () => {
  const registered = command('get-public-account-info');
  expect(registered).toMatchObject({
    browser: 'conditional',
    strategy: 'intercept',
    columns: ['nickname', 'fakeid', 'alias'],
  });
  expect(getRegistry().get('weixin/accounts')).toBeUndefined();
});
```

Only the test title, registry lookup, and new no-alias assertion change inside the existing test; retain its complete page fixture, execution, row, preflight, and secret-redaction assertions verbatim.

- [ ] **Step 2: Run the focused integration test**

Run:

```bash
rtk npx vitest run --project e2e tests/e2e/weixin-history.test.ts
```

Expected: PASS, including browser and environment Weixin history cases.

- [ ] **Step 3: Commit the integration migration**

```bash
rtk git add tests/e2e/weixin-history.test.ts
rtk git commit -m "test(weixin): use renamed public account lookup"
```

### Task 3: Update in-package help and Weixin documentation

**Files:**
- Modify: `clis/weixin/articles.js:22`
- Modify: `clis/weixin/save-articles.js:167`
- Modify: `docs/adapters/browser/weixin.md`
- Modify: `docs/2026-07-14-bycli-plugin-wechat-design.md`

- [ ] **Step 1: Update `fakeid` argument help**

Use the same help text in both downstream commands:

```js
{
  name: 'fakeid',
  positional: true,
  required: true,
  help: 'Official-account fakeid returned by weixin get-public-account-info',
}
```

- [ ] **Step 2: Update the active adapter guide semantically**

In `docs/adapters/browser/weixin.md`, replace command references, headings, the command table, option table, authentication notes, output-column notes, and runnable examples with `get-public-account-info`. Preserve ordinary English descriptions such as “official accounts” and preserve all behavior and security rules.

The primary example must become:

```bash
bycli weixin get-public-account-info "前端之神" --limit 10 --auth-source browser -f json
```

The environment-authentication example must likewise use `get-public-account-info`, and prose must state that this command requires `WECHAT_TOKEN`, `WECHAT_COOKIE`, and `WECHAT_FINGERPRINT` in environment mode.

- [ ] **Step 3: Update published historical guidance that contains runnable old commands**

In `docs/2026-07-14-bycli-plugin-wechat-design.md`, update:

- `accounts.js` to `get-public-account-info.js` in its file tree;
- every command heading and invocation to `get-public-account-info`;
- registry and credential labels that refer to the command;
- prose describing the command's listener, selection behavior, and registration.

Do not rewrite ordinary Chinese or English words meaning multiple WeChat accounts.

- [ ] **Step 4: Verify the package sources and active docs contain no stale command reference**

Run:

```bash
rtk rg -n "bycli weixin accounts|weixin/accounts|name: 'accounts'|command\('accounts'\)|accounts\.js|returned by weixin accounts" clis tests docs --glob '!docs/.vitepress/dist/**' --glob '!docs/superpowers/specs/2026-08-31-weixin-get-public-account-info-command-design.md'
```

Expected: no matches. The approved rename design may retain the old name when describing migration history.

- [ ] **Step 5: Build the documentation**

Run:

```bash
rtk npm run docs:build
```

Expected: VitePress build exits 0 with no broken-link or Markdown errors.

- [ ] **Step 6: Commit help and documentation changes**

```bash
rtk git add clis/weixin/articles.js clis/weixin/save-articles.js docs/adapters/browser/weixin.md docs/2026-07-14-bycli-plugin-wechat-design.md
rtk git commit -m "docs(weixin): migrate public account lookup name"
```

### Task 4: Migrate the ByClaw Weixin executor reference

**Files:**
- Modify: `/Users/lijiahui/Desktop/whaleBI/byclaw-all/middleware/openclaw/skills/bycli/references/weixin.md`

- [ ] **Step 1: Replace command identity references without altering generic account prose**

Update all command-specific uses of `accounts` to `get-public-account-info`, including:

```markdown
| `get-public-account-info <query>` | read | Search official accounts; returns `nickname`, `fakeid`, and `alias`. Default `--limit` is 10. |
```

```markdown
Use IDs from the corresponding list command: `get-public-account-info` supplies the `fakeid` for `articles` and `save-articles`; `collections` supplies the `collectionId` for `collection-detail`.
```

```markdown
1. **Explicit account identity or account-history intent starts with `get-public-account-info`.** This includes a supplied nickname, account name, alias, original ID, or a request for one account's historical posts. Derive `searchQuery` from that identity and run `get-public-account-info '<searchQuery>' --limit 10`.
```

Also update exact-match proof, Sogou fallback, direct-`fakeid` validation, supported-option lists, environment credential tables, fingerprint collection instructions, and output-preservation rules. Do not change the algorithm, authentication precedence, or fallback safety gates.

- [ ] **Step 2: Update the login-gate example**

Use this executable shape:

```bash
node scripts/weixin-login-gate.mjs --state-dir '<absolute-state-dir>' -- bycli weixin get-public-account-info "<account name>" --auth-source browser --site-session persistent --keep-tab true -f json
```

- [ ] **Step 3: Verify no old command-specific reference remains**

Run:

```bash
rtk rg -n 'bycli weixin accounts|`accounts`|accounts supplies|starts with `accounts`|validate it with `accounts`|For `accounts`|Only `accounts`|unique `accounts` result' /Users/lijiahui/Desktop/whaleBI/byclaw-all/middleware/openclaw/skills/bycli/references/weixin.md
```

Expected: no matches. Generic phrases such as “official accounts” may remain.

- [ ] **Step 4: Review the downstream diff for accidental broad replacement**

Run:

```bash
rtk git -C /Users/lijiahui/Desktop/whaleBI/byclaw-all diff -- middleware/openclaw/skills/bycli/references/weixin.md
```

Expected: every changed occurrence identifies the command; no generic English prose is malformed.

- [ ] **Step 5: Commit the downstream reference migration**

```bash
rtk git -C /Users/lijiahui/Desktop/whaleBI/byclaw-all add middleware/openclaw/skills/bycli/references/weixin.md
rtk git -C /Users/lijiahui/Desktop/whaleBI/byclaw-all commit -m "docs(bycli): rename weixin public account lookup"
```

### Task 5: Regenerate metadata and perform final verification

**Files:**
- Modify: `cli-manifest.json`

- [ ] **Step 1: Regenerate the tracked CLI manifest**

Run:

```bash
rtk npm run build-manifest
```

Expected: command succeeds and `cli-manifest.json` contains a Weixin entry whose `name` is `get-public-account-info` and whose source resolves to `clis/weixin/get-public-account-info.js`.

- [ ] **Step 2: Verify the manifest has the new command and no old command**

Run:

```bash
rtk rg -n '"name": "get-public-account-info"|"name": "accounts"|clis/weixin/(get-public-account-info|accounts)\.js' cli-manifest.json
```

Expected: matches only for `get-public-account-info`; no `"name": "accounts"` or `clis/weixin/accounts.js` match.

- [ ] **Step 3: Run focused and full test suites**

Run:

```bash
rtk npx vitest run --project adapter clis/weixin/get-public-account-info.test.js
rtk npx vitest run --project e2e tests/e2e/weixin-history.test.ts
rtk npm test
```

Expected: every command exits 0 with all tests passing.

- [ ] **Step 4: Run type checking and final hygiene checks**

Run:

```bash
rtk npm run typecheck
rtk git diff --check
rtk rg -n "bycli weixin accounts|weixin/accounts|clis/weixin/accounts\.js|returned by weixin accounts" . --glob '!docs/.vitepress/dist/**' --glob '!docs/superpowers/specs/2026-08-31-weixin-get-public-account-info-command-design.md' --glob '!docs/superpowers/plans/2026-08-31-weixin-get-public-account-info-command-rename.md'
```

Expected: type checking and diff checks exit 0; the stale-reference search returns no matches.

- [ ] **Step 5: Commit regenerated metadata**

```bash
rtk git add cli-manifest.json
rtk git commit -m "build: refresh cli manifest for weixin rename"
```

- [ ] **Step 6: Review final repository state**

Run:

```bash
rtk git status --short
rtk git log -6 --oneline
rtk git -C /Users/lijiahui/Desktop/whaleBI/byclaw-all status --short
rtk git -C /Users/lijiahui/Desktop/whaleBI/byclaw-all log -3 --oneline
```

Expected: both repositories are clean and their recent history contains the scoped rename commits.
