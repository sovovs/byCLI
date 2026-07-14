# Weixin History Articles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the built-in `weixin` adapter with `accounts`, `articles`, and `save-articles`, while moving the useful crawler implementation in-process and removing the independent plugin/runtime CLI boundary.

**Architecture:** Commands remain thin `cli()` registrations under `clis/weixin`. Authentication, search, pagination, download, Markdown, arguments, and redaction live in focused modules under `clis/weixin/_wechat`. Browser mode reuses or obtains a logged-in WeChat session; explicit env mode uses injected credentials and never starts a browser.

**Tech Stack:** Node.js ESM, JavaScript + JSDoc, byCLI registry/browser/error APIs, Vitest, built-in `fetch`, `fs`, and `path`.

---

### Task 1: Migrate argument, authentication, and redaction foundations

**Files:**
- Create: `clis/weixin/_wechat/args.js`
- Create: `clis/weixin/_wechat/auth-session.js`
- Create: `clis/weixin/_wechat/redact.js`
- Create: `clis/weixin/_wechat/args.test.js`
- Create: `clis/weixin/_wechat/auth-session.test.js`
- Create: `clis/weixin/_wechat/redact.test.js`

- [ ] **Step 1: Add failing contract tests**

Port the approved synthetic tests from `/Users/lijiahui/Desktop/bycli-plugin-wechat/test/{args,auth-session,redact}.test.ts` to ESM JavaScript. Imports must target the new `_wechat/*.js` modules. Preserve these assertions:

```js
expect(readAuthSource({})).toBe('browser');
expect(readAuthSource({'auth-source': 'env'})).toBe('env');
expect(() => readPositiveInteger({limit: 0}, 'limit')).toThrow(ArgumentError);
expect(isLoggedInPreflight({
  url: 'https://mp.weixin.qq.com/cgi-bin/home?token=123',
  hasLoginUi: false,
})).toBe(true);
expect(isLoggedInPreflight({
  url: 'http://mp.weixin.qq.com/cgi-bin/home?token=123',
  hasLoginUi: false,
})).toBe(false);
```

Also preserve the approved tests for real evaluate callback execution, boundary login success, HttpOnly/expired/foreign cookies, encoded secret case, short-value contexts, linear slice work, array reconstruction, hostile prototypes, cycles, BigInt, and Symbol descriptions.

- [ ] **Step 2: Confirm RED**

Run:

```bash
rtk npx vitest run clis/weixin/_wechat/args.test.js clis/weixin/_wechat/auth-session.test.js clis/weixin/_wechat/redact.test.js
```

Expected: FAIL because the three implementation modules do not exist.

- [ ] **Step 3: Port the approved implementations**

Convert the current implementations from `/Users/lijiahui/Desktop/bycli-plugin-wechat/src/{args,auth-session,redact}.ts` to JavaScript + JSDoc without changing behavior. Keep these exports:

```js
export function readAuthSource(args) {}
export function readPositiveInteger(args, key, fallback) {}
export function readRequiredString(args, key) {}
export function readEnvironmentCredentials(needsFingerprint, env = process.env) {}
export function isLoggedInPreflight(state) {}
export async function resolveBrowserCredentials(page, options = {}) {}
export function buildSecretSet(credentials) {}
export function redactText(value, secrets) {}
export function redactValue(value, secrets) {}
```

Use byCLI errors directly. `resolveBrowserCredentials` must navigate to the type-10 editor URL before returning. Do not introduce plugin types, crawler envelopes, subprocesses, or TypeScript compilation.

- [ ] **Step 4: Verify and commit**

```bash
rtk npx vitest run clis/weixin/_wechat/args.test.js clis/weixin/_wechat/auth-session.test.js clis/weixin/_wechat/redact.test.js
rtk npm run typecheck
rtk git diff --check
rtk git add clis/weixin/_wechat
rtk git commit -m "feat(weixin): add secure session foundations"
```

Expected: all migrated tests PASS and no independent-plugin import remains.

### Task 2: Capture fingerprint and call `search_biz`

**Files:**
- Create: `clis/weixin/_wechat/fingerprint.js`
- Create: `clis/weixin/_wechat/search-biz.js`
- Create: `clis/weixin/_wechat/fingerprint.test.js`
- Create: `clis/weixin/_wechat/search-biz.test.js`
- Create: `clis/weixin/_wechat/fixtures/search-success.json`
- Create: `clis/weixin/_wechat/fixtures/search-auth-expired.json`

- [ ] **Step 1: Add sanitized fixtures and failing tests**

Use synthetic fixtures:

```json
{"base_resp":{"ret":0,"err_msg":"ok"},"list":[{"nickname":"Account A","fakeid":"MTAwMDAwMQ==","alias":"account_a"},{"nickname":"Account A Labs","fakeid":"MTAwMDAwMg=="}]}
```

```json
{"base_resp":{"ret":200013,"err_msg":"invalid credential"},"list":[]}
```

Tests must prove:

```js
expect(mapSearchBizPayload(success)).toEqual([
  {nickname: 'Account A', fakeid: 'MTAwMDAwMQ==', alias: 'account_a'},
  {nickname: 'Account A Labs', fakeid: 'MTAwMDAwMg==', alias: null},
]);
expect(() => mapSearchBizPayload(expired)).toThrow(AuthRequiredError);
expect(() => mapSearchBizPayload({base_resp:{ret:999999,err_msg:'new failure'}}))
  .toThrow(CommandExecutionError);
```

Browser and env transport tests must assert `action=search_biz`, count, encoded query, token, fingerprint, Referer, `X-Requested-With`, and Cookie only in Node/env mode. Fingerprint tests must prove the page observer stores only the parameter value, restores wrappers in `finally`, and times out with `TimeoutError`.

- [ ] **Step 2: Confirm RED**

```bash
rtk npx vitest run clis/weixin/_wechat/fingerprint.test.js clis/weixin/_wechat/search-biz.test.js
```

Expected: missing-module failure.

- [ ] **Step 3: Implement one-shot capture and search**

Export:

```js
export async function captureSearchBizFingerprint(page, query, timeoutMs = 30_000) {}
export function mapSearchBizPayload(payload) {}
export async function executeSearchBiz({page, source, credentials, query, limit, fetchImpl = fetch}) {}
```

Install temporary wrappers around page `fetch` and `XMLHttpRequest.open`, capture only `new URL(requestUrl, location.href).searchParams.get('fingerprint')`, trigger the visible search input/button, poll, then restore/delete in all paths. Use auth allowlist `{ret: 200013, message: 'invalid credential'}`; unknown failures stay `CommandExecutionError`. Redact transport/parse errors with Task 1 helpers.

- [ ] **Step 4: Verify and commit**

```bash
rtk npx vitest run clis/weixin/_wechat/fingerprint.test.js clis/weixin/_wechat/search-biz.test.js
rtk npm run typecheck
rtk git diff --check
rtk git add clis/weixin/_wechat
rtk git commit -m "feat(weixin): search official accounts"
```

### Task 3: Move the history-article API and pagination in-process

**Files:**
- Create: `clis/weixin/_wechat/wechat-api.js`
- Create: `clis/weixin/_wechat/article-service.js`
- Create: `clis/weixin/_wechat/wechat-api.test.js`
- Create: `clis/weixin/_wechat/article-service.test.js`
- Create: `clis/weixin/_wechat/fixtures/articles-page.json`
- Create: `clis/weixin/_wechat/fixtures/articles-auth-expired.json`

- [ ] **Step 1: Add failing parser/API tests**

Port the useful cases from `wechat-crawler/test/{wechat-api,article-service}.test.js`, replacing generic/`CliError` assertions with byCLI typed errors. Add explicit tests for duplicate URLs, `tempkey=`, deleted items, first-page auth failure, malformed nested JSON, `limit`, `maxPages`, and zero publish items.

Required public result shape:

```js
{
  title: 'Synthetic article',
  url: 'https://mp.weixin.qq.com/s/synthetic',
  publishedAt: '2026-01-01T00:00:00.000Z',
  digest: 'Synthetic digest',
  author: 'Synthetic author'
}
```

- [ ] **Step 2: Confirm RED**

```bash
rtk npx vitest run clis/weixin/_wechat/wechat-api.test.js clis/weixin/_wechat/article-service.test.js
```

- [ ] **Step 3: Implement typed API and bounded pagination**

Export:

```js
export function parsePublishData(data) {}
export function requestHeaders(cookie, token) {}
export function createWechatApi({token, cookie, timeoutMs = 30_000, fetchImpl = fetch}) {}
export function isUsableArticle(article) {}
export async function collectArticles({fakeid, fetchPage, limit, maxPages, pageSize = 10}) {}
```

Build `https://mp.weixin.qq.com/cgi-bin/appmsgpublish` using `URLSearchParams`. Validate HTTP and JSON. Known auth failures throw `AuthRequiredError`; unknown ret, malformed `publish_page`, and transport failures throw redacted `CommandExecutionError`. Deduplicate usable articles by canonical URL while preserving source order. Stop on limit, max pages, empty publish items, short page, or API total.

- [ ] **Step 4: Verify and commit**

```bash
rtk npx vitest run clis/weixin/_wechat/wechat-api.test.js clis/weixin/_wechat/article-service.test.js
rtk npm run typecheck
rtk git diff --check
rtk git add clis/weixin/_wechat
rtk git commit -m "feat(weixin): collect account article history"
```

### Task 4: Share article download and implement safe batch saving

**Files:**
- Modify: `clis/weixin/download.js`
- Create: `clis/weixin/_wechat/article-content.js`
- Create: `clis/weixin/_wechat/markdown.js`
- Create: `clis/weixin/_wechat/save-service.js`
- Create: `clis/weixin/_wechat/article-content.test.js`
- Create: `clis/weixin/_wechat/markdown.test.js`
- Create: `clis/weixin/_wechat/save-service.test.js`

- [ ] **Step 1: Characterize the existing downloader before refactoring**

Add tests for the current exported helpers and extract a pure content normalization contract:

```js
expect(normalizeWechatUrl('mp.weixin.qq.com/s/abc')).toMatch(/^https:/);
expect(extractWechatPublishTime('', 'create_time: 1767225600')).toBeTruthy();
expect(detectWechatAccessIssue('环境异常 完成验证后即可继续访问', '')).toBeTruthy();
```

Add failing Markdown/save tests for unsafe filenames, nested `#js_content`, scripts/styles, images, code blocks, duplicate titles, output traversal, write failure, and one failed article among successes.

- [ ] **Step 2: Confirm RED for new modules**

```bash
rtk npx vitest run clis/weixin/_wechat/article-content.test.js clis/weixin/_wechat/markdown.test.js clis/weixin/_wechat/save-service.test.js clis/weixin/download.test.js
```

- [ ] **Step 3: Extract shared content helpers and implement saving**

Move reusable pure helpers from `download.js` into `article-content.js`; re-import them so existing `weixin download` output remains unchanged. Port only needed Markdown behavior from crawler into `markdown.js`.

Export:

```js
export function cleanFilename(value) {}
export function buildMarkdown(article, accountName, html) {}
export async function saveArticles({articles, accountName, outputDir, fetchArticleHtml, fsImpl}) {}
```

Resolve the output root once. Every target path must remain inside it. Use deterministic `-2`, `-3` suffixes for duplicate cleaned titles. Directory/permission/write errors are command-level `CommandExecutionError`; fetch/parse failure for one article becomes a failed row and processing continues.

- [ ] **Step 4: Verify and commit**

```bash
rtk npx vitest run clis/weixin/download.test.js clis/weixin/_wechat/article-content.test.js clis/weixin/_wechat/markdown.test.js clis/weixin/_wechat/save-service.test.js
rtk npm run typecheck
rtk git diff --check
rtk git add clis/weixin
rtk git commit -m "feat(weixin): save article history as markdown"
```

### Task 5: Register `accounts`, `articles`, and `save-articles`

**Files:**
- Create: `clis/weixin/accounts.js`
- Create: `clis/weixin/articles.js`
- Create: `clis/weixin/save-articles.js`
- Create: `clis/weixin/accounts.test.js`
- Create: `clis/weixin/articles.test.js`
- Create: `clis/weixin/save-articles.test.js`

- [ ] **Step 1: Add failing registration and orchestration tests**

Mock `@sovovs/bycli/registry` and shared modules. Assert exact registrations:

```js
expect(config).toMatchObject({
  site: 'weixin',
  name: 'accounts',
  access: 'read',
  strategy: Strategy.INTERCEPT,
  domain: 'mp.weixin.qq.com',
  columns: ['nickname', 'fakeid', 'alias'],
});
expect(config.browser({'auth-source': 'env'})).toBe(false);
expect(config.browser({'auth-source': 'browser'})).toBe(true);
```

Likewise assert `articles` read/COOKIE/static columns and `save-articles` write/COOKIE/static columns. Test browser and env flows separately and verify env mode never consumes page methods.

- [ ] **Step 2: Confirm RED**

```bash
rtk npx vitest run clis/weixin/accounts.test.js clis/weixin/articles.test.js clis/weixin/save-articles.test.js
```

- [ ] **Step 3: Implement thin commands**

Use exact args from the approved design. Each command must:

1. Read and validate arguments.
2. Resolve credentials from exactly one source.
3. Call one shared service path.
4. Map optional fields to `null` so keys match static columns.
5. Throw `EmptyResultError` for no account/article rows.

`save-articles` returns saved and failed rows from `saveArticles` and never sets crawler-specific exit codes.

- [ ] **Step 4: Verify and commit**

```bash
rtk npx vitest run clis/weixin/accounts.test.js clis/weixin/articles.test.js clis/weixin/save-articles.test.js
rtk npm run typecheck
rtk git diff --check
rtk git add clis/weixin
rtk git commit -m "feat(weixin): register history article commands"
```

### Task 6: Remove stale plugin/crawler assumptions and document built-in usage

**Files:**
- Modify: `docs/2026-07-14-bycli-plugin-wechat-design.md`
- Create: `docs/adapters/browser/weixin.md` if absent, otherwise modify it
- Modify: `README.md` only if its adapter index is maintained manually
- Modify: `README.zh-CN.md` only if its adapter index is maintained manually
- Modify/Delete: stale independent-plugin plan references under `docs/superpowers/plans/`

- [ ] **Step 1: Add documentation/manifest assertions**

Add or update the relevant manifest/doc test to require:

```text
weixin accounts
weixin articles
weixin save-articles
browser = conditional
```

Add a repository assertion that production `package.json`/lockfile and `clis/weixin` contain no `wechat-article-crawler`, `wechat-crawler` spawn, or `bycli-plugin-wechat` runtime dependency.

- [ ] **Step 2: Update user documentation**

Document browser login, env variables, two-step `accounts` then `articles/save-articles` flow, security guidance, output examples, and the distinction between existing Sogou `weixin search` and backend `weixin accounts`.

Mark the old independent-plugin implementation plan superseded rather than presenting it as active. Keep the approved design filename for history.

- [ ] **Step 3: Verify generated artifacts and commit**

```bash
rtk npm test
rtk npm run typecheck
rtk npm run build
rtk npm run docs:build
rtk rg -n "wechat-article-crawler|spawn.*wechat-crawler" package.json package-lock.json clis/weixin
rtk git diff --check
rtk git add docs README.md README.zh-CN.md cli-manifest.json
rtk git commit -m "docs: document built-in weixin history commands"
```

Expected: tests/build/docs pass, manifest contains all three commands, and the dependency search returns no production hit.

### Task 7: Final regression, security, and controlled integration verification

**Files:**
- Create: `tests/e2e/weixin-history.test.ts`
- Modify only as required by discovered integration failures.

- [ ] **Step 1: Add isolated end-to-end tests**

Using synthetic transport/page fixtures, execute the registered command functions for:

```text
browser accounts -> two similar candidates retained
env articles -> bounded article rows
env save-articles -> one saved and one failed row
expired credentials -> AuthRequiredError
login timeout -> TimeoutError
malformed API -> CommandExecutionError
```

Assert formatted output contains no token, Cookie, fingerprint, or cookie-value fragments.

- [ ] **Step 2: Run focused and full verification**

```bash
rtk npx vitest run clis/weixin tests/e2e/weixin-history.test.ts
rtk npm test
rtk npm run typecheck
rtk npm run build
rtk npm run docs:build
rtk git diff --check
rtk git status --short
```

Expected: all commands and existing `weixin` tests pass; worktree contains only intentional integration changes.

- [ ] **Step 3: Commit integration fixes**

```bash
rtk git add clis/weixin tests/e2e/weixin-history.test.ts docs cli-manifest.json
rtk git commit -m "test: verify built-in weixin history workflow"
```

Do not perform a live WeChat request in CI. Record any manual Chrome E2E separately without credentials or raw network payloads.
