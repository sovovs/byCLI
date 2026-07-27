# WeChat Crawler Package Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a stable crawler programmatic API and make byCLI's existing WeChat history commands use it without changing either product's public behavior.

**Architecture:** The crawler owns generic WeChat history transport, bounded collection, and secure saving behind a CommonJS root API. byCLI keeps authentication, Browser Bridge fallback, Markdown conversion, typed errors, and command projection behind a narrow adapter that imports only the crawler package root.

**Tech Stack:** Node.js 18+/20+, CommonJS, ESM adapters, npm workspaces, `node:test`, Vitest, npm package exports, Browser Bridge.

---

## Repository map

Work in these two repositories only:

- Crawler: `/Users/lijiahui/Desktop/WeChat-Article-Crawler-main`
- byCLI: `/Users/lijiahui/Desktop/OpenCLI`

Crawler file responsibilities after the change:

- `src/index.js`: the only public package-root API composition point.
- `src/errors.js`: crawler-owned stable error codes and legacy CLI error compatibility.
- `src/wechat-api.js`: authenticated history transport and response normalization.
- `src/article-service.js`: trusted URL filtering, bounded pagination, and deduplication.
- `src/save-service.js`: generic secure saving with injected download/conversion callbacks.
- `src/save-command.js`: legacy CLI envelope over public services, explicitly using overwrite policy.
- `src/list-command.js`: legacy list envelope over public collection.
- `src/cli.js`: argument parsing, output, progress, redaction, and exit-code compatibility.

byCLI file responsibilities after the change:

- `clis/weixin/_wechat/crawler-runtime.js`: the only crawler import and error mapping boundary.
- `clis/weixin/articles.js`: existing command registration and output projection.
- `clis/weixin/save-articles.js`: existing download/browser fallback and output projection.
- `clis/weixin/_wechat/markdown.js`: byCLI-specific high-fidelity Markdown callback.
- `clis/weixin/_wechat/auth-session.js`: browser/environment credentials, unchanged.

## Task 1: Publish a loadable crawler root API

**Repository:** `/Users/lijiahui/Desktop/WeChat-Article-Crawler-main`

**Files:**

- Create: `src/index.js`
- Create: `test/public-api.test.js`
- Modify: `src/errors.js`
- Modify: `package.json`

- [ ] **Step 1: Write the failing root-API tests**

Create `test/public-api.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const api = require('..');

test('package root exposes only the documented runtime API', () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'CrawlerError', 'collectArticles', 'createWechatApi', 'isTrustedWechatArticleUrl',
  ]);
});

test('CrawlerError carries a stable code and safe details', () => {
  const error = new api.CrawlerError('INVALID_ARGUMENT', 'limit is invalid', { argument: 'limit' });
  assert.equal(error.name, 'CrawlerError');
  assert.equal(error.code, 'INVALID_ARGUMENT');
  assert.deepEqual(error.details, { argument: 'limit' });
});
```

- [ ] **Step 2: Run the test and verify that the package root is missing**

Run:

```bash
rtk node --test test/public-api.test.js
```

Expected: FAIL with `Cannot find module` for the package root or missing exports.

- [ ] **Step 3: Add the crawler error type and root entry**

Replace `src/errors.js` with:

```js
'use strict';

const CRAWLER_ERROR_CODES = Object.freeze([
  'INVALID_ARGUMENT',
  'AUTH_REQUIRED',
  'REMOTE_ERROR',
  'DOWNLOAD_FAILED',
  'CONVERSION_FAILED',
  'FILESYSTEM_ERROR',
]);

class CrawlerError extends Error {
  constructor(code, message, details = {}) {
    if (!CRAWLER_ERROR_CODES.includes(code)) throw new TypeError(`Unknown crawler error code: ${code}`);
    super(String(message));
    this.name = 'CrawlerError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

class CliError extends Error {
  constructor(message, exitCode = 1, details = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.details = details;
  }
}

module.exports = { CRAWLER_ERROR_CODES, CrawlerError, CliError };
```

Create `src/index.js`:

```js
'use strict';

const { CrawlerError } = require('./errors');
const { collectArticles, isTrustedWechatArticleUrl } = require('./article-service');
const { createWechatApi } = require('./wechat-api');
module.exports = {
  CrawlerError,
  collectArticles,
  createWechatApi,
  isTrustedWechatArticleUrl,
};
```

Add the `main` field to `package.json` without changing the version yet:

```json
{
  "main": "./src/index.js"
}
```
- [ ] **Step 4: Add the root export map after the public save service exists**

The `exports` map is added in Task 4, when `src/save-service.js` is a real public implementation. This keeps every intermediate commit loadable without a stub.

- [ ] **Step 5: Run the root test**

Run:

```bash
rtk node --test test/public-api.test.js
```

Expected: 2 tests PASS.

- [ ] **Step 6: Commit the root contract**

```bash
rtk git add package.json src/index.js src/errors.js test/public-api.test.js
rtk git commit -m "feat: expose crawler runtime api"
```

## Task 2: Harden crawler history transport and safe errors

**Repository:** `/Users/lijiahui/Desktop/WeChat-Article-Crawler-main`

**Files:**

- Modify: `test/wechat-api.test.js`
- Modify: `src/wechat-api.js`

- [ ] **Step 1: Add failing authentication, malformed-response, and redaction tests**

Append to `test/wechat-api.test.js`:

```js
const { CrawlerError } = require('../src/errors');

test('parsePublishData classifies the exact expired credential response', () => {
  assert.throws(
    () => parsePublishData({ base_resp: { ret: 200013, err_msg: 'invalid credential' } }),
    (error) => error instanceof CrawlerError && error.code === 'AUTH_REQUIRED',
  );
});

test('parsePublishData rejects malformed nested JSON as a remote error', () => {
  assert.throws(
    () => parsePublishData({ base_resp: { ret: 0 }, publish_page: '{bad' }),
    (error) => error instanceof CrawlerError && error.code === 'REMOTE_ERROR',
  );
});

test('history request errors never expose credentials', async () => {
  const token = 'history-secret-token';
  const cookie = 'history-secret-cookie';
  const api = createWechatApi({
    token,
    cookie,
    fetchImpl: async () => { throw new Error(`request failed ${token} ${cookie}`); },
  });
  await assert.rejects(
    () => api.fetchPage({ fakeid: 'id' }),
    (error) => error instanceof CrawlerError
      && error.code === 'REMOTE_ERROR'
      && !JSON.stringify(error).includes('history-secret'),
  );
});
```

Delete the older `parsePublishData rejects business errors` test because the new classification test replaces its weaker assertion.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
rtk node --test test/wechat-api.test.js
```

Expected: FAIL because responses still throw generic `Error` and leak underlying messages.

- [ ] **Step 3: Implement safe response and transport classification**

Update `src/wechat-api.js` to import `CrawlerError`, parse nested JSON through a helper, strictly validate `base_resp`, totals, timestamps, and arrays, and wrap transport errors. The public signatures must be:

The module must keep the existing exported function names and signatures: `parsePublishData(data)`, `createWechatApi({ token, cookie, timeoutMs, timeout, fetchImpl })`, `api.fetchPage({ fakeid, begin, count })`, and `api.fetchArticleHtml(url)`. `fetchPage` and `parsePublishData` may throw only `CrawlerError`; `fetchArticleHtml` remains available to the legacy CLI and rejects untrusted URLs before invoking its injected fetcher.

Use these exact classifications:

```js
if (ret === 200013 && normalizedMessage(message) === 'invalid credential') {
  throw new CrawlerError('AUTH_REQUIRED', 'WeChat article-history credentials have expired');
}
if (ret !== undefined && ret !== 0) {
  throw new CrawlerError('REMOTE_ERROR', `WeChat article history failed (ret=${String(ret)})`);
}
```

On any other fetch, JSON, or schema failure, throw:

```js
throw new CrawlerError('REMOTE_ERROR', 'WeChat article history request failed');
```

Do not attach the request URL, token, cookie, raw response, or original error message to `details`.

- [ ] **Step 4: Run API and CLI tests**

Run:

```bash
rtk node --test test/wechat-api.test.js test/cli.test.js
```

Expected: all tests PASS; existing `timeout` CLI option still controls requests through the compatibility alias.

- [ ] **Step 5: Commit transport hardening**

```bash
rtk git add src/wechat-api.js test/wechat-api.test.js
rtk git commit -m "feat: add safe crawler transport errors"
```

## Task 3: Move bounded and deduplicated collection into the public API

**Repository:** `/Users/lijiahui/Desktop/WeChat-Article-Crawler-main`

**Files:**

- Modify: `test/article-service.test.js`
- Modify: `src/article-service.js`

- [ ] **Step 1: Replace permissive URL fixtures and add failing boundary tests**

Change the article helper to:

```js
const article = (id, extra = {}) => ({
  title: id,
  url: `https://mp.weixin.qq.com/s/${id}`,
  isDeleted: false,
  ...extra,
});
```

Append:

```js
const { CrawlerError } = require('../src/errors');

test('isUsableArticle accepts only trusted WeChat article paths', () => {
  assert.equal(isUsableArticle(article('ok')), true);
  assert.equal(isUsableArticle(article('evil', { url: 'https://mp.weixin.qq.com.evil.test/s/x' })), false);
  assert.equal(isUsableArticle(article('port', { url: 'https://mp.weixin.qq.com:444/s/x' })), false);
  assert.equal(isUsableArticle(article('path', { url: 'https://mp.weixin.qq.com/cgi-bin/home' })), false);
});

test('collectArticles validates hard limits before fetching', async () => {
  for (const options of [{ limit: 0 }, { limit: 1001 }, { maxPages: 101 }, { pageSize: 11 }]) {
    let calls = 0;
    await assert.rejects(
      () => collectArticles({ fakeid: 'id', fetchPage: async () => { calls += 1; }, ...options }),
      (error) => error instanceof CrawlerError && error.code === 'INVALID_ARGUMENT',
    );
    assert.equal(calls, 0);
  }
});

test('collectArticles deduplicates canonical URLs', async () => {
  const result = await collectArticles({
    fakeid: 'id',
    fetchPage: async () => ({ total: 1, publishItemCount: 1, articles: [
      article('same'),
      article('duplicate', { url: 'https://mp.weixin.qq.com/s/same#fragment' }),
    ] }),
  });
  assert.equal(result.articles.length, 1);
  assert.equal(result.summary.duplicates, 1);
});
```

- [ ] **Step 2: Run and verify boundary failures**

Run:

```bash
rtk node --test test/article-service.test.js
```

Expected: FAIL on trusted URL filtering, hard bounds, or missing duplicate count.

- [ ] **Step 3: Implement the bounded collector**

Replace `src/article-service.js` with the hardened algorithm currently proven in byCLI's `clis/weixin/_wechat/article-service.js`, changing only the error construction to crawler-owned errors:

```js
'use strict';

const { CrawlerError } = require('./errors');

const MAX_PAGES = 100;
const MAX_PAGE_SIZE = 10;
const MAX_ARTICLES = 1000;

function invalid(message, argument) {
  return new CrawlerError('INVALID_ARGUMENT', message, { argument });
}

function isTrustedWechatArticleUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'mp.weixin.qq.com'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && (url.pathname === '/s' || url.pathname.startsWith('/s/'));
  } catch {
    return false;
  }
}

function isUsableArticle(value) {
  return Boolean(value)
    && value.isDeleted !== true
    && typeof value.url === 'string'
    && isTrustedWechatArticleUrl(value.url)
    && !value.url.includes('tempkey=');
}
```

The `collectArticles` body must preserve the existing return shape and add `duplicates`:

```js
return {
  articles,
  summary: { totalFromApi, scanned, valid: articles.length, invalid, duplicates, pages },
};
```

Validate `pageSize`, `limit`, and `maxPages` as positive safe integers no larger than their constants. Advance `begin` by `pageSize`, stop on empty/short pages, API total, limit, or maximum pages, and reject invalid page metadata with `CrawlerError('REMOTE_ERROR', safeMessage)`.

Export:

```js
module.exports = {
  MAX_ARTICLES,
  MAX_PAGES,
  MAX_PAGE_SIZE,
  collectArticles,
  isTrustedWechatArticleUrl,
  isUsableArticle,
};
```

- [ ] **Step 4: Update legacy summary assertions and run collection tests**

Update exact summary assertions in `test/article-service.test.js`, `test/list-command.test.js`, and `test/save-command.test.js` to include `duplicates: 0` when they inspect the collector summary.

Run:

```bash
rtk node --test test/article-service.test.js test/list-command.test.js test/save-command.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit collection behavior**

```bash
rtk git add src/article-service.js test/article-service.test.js test/list-command.test.js test/save-command.test.js
rtk git commit -m "feat: harden crawler article collection"
```

## Task 4: Add generic secure saving while preserving crawler CLI overwrite behavior

**Repository:** `/Users/lijiahui/Desktop/WeChat-Article-Crawler-main`

**Files:**

- Replace: `src/save-service.js`
- Create: `test/save-service.test.js`
- Modify: `src/save-command.js`
- Modify: `test/save-command.test.js`

- [ ] **Step 1: Add failing public save-service tests**

Create `test/save-service.test.js` by porting the behavior tests from byCLI's `clis/weixin/_wechat/save-service.test.js` and using Node's `node:test` plus `assert`. Cover these exact cases:

Write eight tests with these exact names and assertions: `suffix policy writes same.md then same-2.md` must assert two absolute distinct paths; `overwrite policy replaces an existing regular file` must assert the final body; `ordinary fetch and converter failures return failed rows and continue` must assert statuses `failed, failed, saved`; `AUTH_REQUIRED errors stop immediately` must assert the second fetch is never called; `saving rejects more than 1000 articles before filesystem work` must assert `INVALID_ARGUMENT` and zero filesystem calls; `saving rejects symlink targets` must assert `FILESYSTEM_ERROR`; `suffix policy retries EEXIST races and caps attempts at 100` must assert the next suffix and the 100-attempt failure; and `saving detects output-root replacement` must assert `FILESYSTEM_ERROR` and no write through the replacement root.

Use the same real-filesystem root-replacement fixtures and in-memory filesystem shape already present in the byCLI test. Replace Vitest mocks with small counters/functions so the test has no external dependency.

- [ ] **Step 2: Run and verify the pre-implementation test fails**

Run:

```bash
rtk node --test test/save-service.test.js
```

Expected: FAIL because `src/save-service.js` does not exist yet.

- [ ] **Step 3: Implement generic secure saving**

Replace `src/save-service.js` with the secure filesystem algorithm from byCLI's `clis/weixin/_wechat/save-service.js`, with these public inputs and crawler-owned errors:

Implement `saveArticles({ articles, accountName, outputDir, fetchArticleHtml, buildMarkdown, existingFilePolicy = 'suffix', fsImpl = require('node:fs'), onDownload = () => {} })`. It returns the uniform `saved`/`failed` row shapes below and never includes raw callback errors in those rows.

Validate:

```js
if (!Array.isArray(articles) || articles.length > 1000) {
  throw new CrawlerError('INVALID_ARGUMENT', 'articles must be an array of at most 1000 items', { argument: 'articles' });
}
if (typeof fetchArticleHtml !== 'function' || typeof buildMarkdown !== 'function') {
  throw new CrawlerError('INVALID_ARGUMENT', 'fetchArticleHtml and buildMarkdown must be functions');
}
if (!['suffix', 'overwrite'].includes(existingFilePolicy)) {
  throw new CrawlerError('INVALID_ARGUMENT', 'existingFilePolicy must be suffix or overwrite', { argument: 'existingFilePolicy' });
}
```

Preserve these row shapes:

```js
{ title, url, status: 'saved', stage: null, saved: absolutePath, error: '' }
{ title, url, status: 'failed', stage: 'download', saved: '', error: 'article download failed' }
{ title, url, status: 'failed', stage: 'download', saved: '', error: 'invalid article content' }
```

If an injected callback throws `CrawlerError` with code `AUTH_REQUIRED`, rethrow it. Also rethrow non-crawler errors whose `code` property equals `AUTH_REQUIRED`; this lets independent hosts signal authentication without importing crawler classes. Convert all filesystem failures to `CrawlerError('FILESYSTEM_ERROR', safeMessage)`.

For `suffix`, use exclusive `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW` creation and bounded suffix retries. For `overwrite`, reject symbolic links and non-regular targets, open with `O_WRONLY | O_TRUNC | O_NOFOLLOW`, and revalidate the output-root identity before and after writing. Both policies keep the resolved target inside the opened output root.

- [ ] **Step 4: Make the legacy save command delegate with overwrite policy**

First add `const { saveArticles } = require('./save-service');` to `src/index.js`, add `saveArticles` to its root object, and add `"exports": { ".": "./src/index.js" }` to `package.json`. Then refactor `src/save-command.js` to collect articles, call `saveArticles`, and convert its rows back into the existing CLI envelope:

```js
const rows = await saveArticles({
  articles: collected.articles,
  accountName: options.name,
  outputDir: options.outputDir,
  fetchArticleHtml: async (article) => fetchArticleHtml(article.url),
  buildMarkdown: ({ html, ...metadata }) => buildMarkdown({
    title: metadata.title,
    url: metadata.url,
    publishedAt: metadata.publishedAt,
    digest: metadata.digest,
    author: metadata.author,
  }, options.name, html),
  existingFilePolicy: 'overwrite',
  onDownload,
});
```

Map `saved` rows to `files`, failed rows to the existing `errors`, and preserve exit codes `0`, `2`, and `3`. Map `FILESYSTEM_ERROR` to `CliError(message, 3, safeDetails)` at the CLI boundary.

Also update `test/public-api.test.js` so its expected root keys include `saveArticles`, then run that test from the package root to verify both `require('..')` and the explicit `exports` map expose the same five keys.

- [ ] **Step 5: Run save and CLI regression tests**

Run:

```bash
rtk node --test test/save-service.test.js test/save-command.test.js test/cli.test.js
```

Expected: all tests PASS, including the existing same-title overwrite assertion.

- [ ] **Step 6: Commit generic saving**

```bash
rtk git add src/save-service.js src/save-command.js test/save-service.test.js test/save-command.test.js
rtk git commit -m "feat: expose secure article saving"
```

## Task 5: Document, pack, and release crawler 1.1.0

**Repository:** `/Users/lijiahui/Desktop/WeChat-Article-Crawler-main`

**Files:**

- Modify: `README.md`
- Modify: `package.json`
- Create: `test/package-install.test.js`

- [ ] **Step 1: Add a packed-install test**

Create `test/package-install.test.js` that copies the repository to a temporary staging directory without `.git`, runs `npm pack --json --ignore-scripts`, installs the tarball into a clean CommonJS project, and executes:

```js
const api = require('@sovovs/wechat-article-crawler');
if (typeof api.createWechatApi !== 'function') process.exit(1);
if (typeof api.collectArticles !== 'function') process.exit(1);
if (typeof api.saveArticles !== 'function') process.exit(1);
```

Assert the tarball contains `src/index.js`, all runtime service files, `README.md`, and `LICENSE`, and contains no `test/` or `.worktrees/` entries.

- [ ] **Step 2: Run the packed-install test before documentation changes**

Run:

```bash
rtk node --test test/package-install.test.js
```

Expected: PASS once Task 1's `main`, `exports`, and `files` entries are correct.

- [ ] **Step 3: Document the public API and version compatibility**

Add a `程序化 API` section to `README.md` with a complete example:

```js
const {
  createWechatApi,
  collectArticles,
  saveArticles,
} = require('@sovovs/wechat-article-crawler');

const api = createWechatApi({
  token: process.env.WECHAT_TOKEN,
  cookie: process.env.WECHAT_COOKIE,
});

const { articles } = await collectArticles({
  fakeid: 'Mzg2NjY2NTcyNg==',
  fetchPage: api.fetchPage,
  limit: 10,
});

await saveArticles({
  articles,
  accountName: '前端之神',
  outputDir: './articles',
  fetchArticleHtml: async article => api.fetchArticleHtml(article.url),
  buildMarkdown: ({ title, html }) => `# ${title}\n\n${html}`,
});
```

Document that injected callbacks keep the API host-independent, `suffix` is the public default, and the CLI retains overwrite behavior.

- [ ] **Step 4: Set version 1.1.0 and run all prepublication checks**

Run:

```bash
rtk npm version 1.1.0 --no-git-tag-version
rtk npm test
rtk npm pack --dry-run
rtk git diff --check
```

Expected: all tests PASS; dry-run tarball contains only documented runtime files; version is `1.1.0`.

- [ ] **Step 5: Commit the release candidate**

```bash
rtk git add package.json README.md test/package-install.test.js
rtk git commit -m "chore: prepare crawler 1.1.0"
```

- [ ] **Step 6: Publish and verify the registry artifact**

Run:

```bash
rtk npm whoami
rtk npm publish --access public
rtk npm view @sovovs/wechat-article-crawler@1.1.0 version main exports --json
```

Expected: authenticated npm identity; publish succeeds; registry returns version `1.1.0`, `./src/index.js` as `main`, and the root export.

If authentication, OTP, package ownership, or registry policy blocks publishing, stop without changing registry configuration and ask the user to resolve that external authorization step.

- [ ] **Step 7: Verify a clean registry install**

Create a temporary directory with `mktemp -d`, initialize a private package, install `@sovovs/wechat-article-crawler@1.1.0 --ignore-scripts`, and require the root API. Remove only that validated temporary directory afterward.

Expected: root API loads and exposes all five documented keys.

## Task 6: Add the byCLI dependency and decoupling adapter

**Repository:** `/Users/lijiahui/Desktop/OpenCLI`

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `clis/weixin/_wechat/crawler-runtime.js`
- Create: `clis/weixin/_wechat/crawler-runtime.test.js`

- [ ] **Step 1: Install the published compatible dependency**

Run:

```bash
rtk npm install @sovovs/wechat-article-crawler@^1.1.0
```

Expected: `package.json` and `package-lock.json` record `^1.1.0`; no lifecycle script from the crawler runs.

- [ ] **Step 2: Write failing error-mapping tests**

Create `clis/weixin/_wechat/crawler-runtime.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { CrawlerError } from '@sovovs/wechat-article-crawler';
import { AuthRequiredError, CommandExecutionError, ArgumentError } from '@sovovs/bycli/errors';
import { callCrawler } from './crawler-runtime.js';

describe('crawler runtime boundary', () => {
  it.each([
    ['INVALID_ARGUMENT', ArgumentError],
    ['AUTH_REQUIRED', AuthRequiredError],
    ['REMOTE_ERROR', CommandExecutionError],
    ['FILESYSTEM_ERROR', CommandExecutionError],
  ])('maps %s without exposing details', async (code, Expected) => {
    const error = new CrawlerError(code, 'safe message', { token: 'must-not-pass-through' });
    const thrown = await callCrawler(async () => { throw error; }).catch(value => value);
    expect(thrown).toBeInstanceOf(Expected);
    expect(JSON.stringify(thrown)).not.toContain('must-not-pass-through');
  });

  it('preserves host authentication errors from injected callbacks', async () => {
    const source = new AuthRequiredError('mp.weixin.qq.com', 'verification required');
    await expect(callCrawler(async () => { throw source; })).rejects.toBe(source);
  });
});
```

- [ ] **Step 3: Run and verify the adapter is missing**

Run:

```bash
rtk npx vitest run --project adapter clis/weixin/_wechat/crawler-runtime.test.js
```

Expected: FAIL because `crawler-runtime.js` does not exist.

- [ ] **Step 4: Implement the single import and error boundary**

Create `clis/weixin/_wechat/crawler-runtime.js`:

```js
import crawler from '@sovovs/wechat-article-crawler';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';

export const {
  CrawlerError,
  collectArticles,
  createWechatApi,
  isTrustedWechatArticleUrl,
  saveArticles,
} = crawler;

export async function callCrawler(operation) {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof CrawlerError)) throw error;
    if (error.code === 'INVALID_ARGUMENT') throw new ArgumentError(error.message);
    if (error.code === 'AUTH_REQUIRED') {
      throw new AuthRequiredError('mp.weixin.qq.com', error.message);
    }
    throw new CommandExecutionError(error.message);
  }
}
```

Do not project `error.details` into any byCLI error.

- [ ] **Step 5: Run adapter tests and audit imports**

Run:

```bash
rtk npx vitest run --project adapter clis/weixin/_wechat/crawler-runtime.test.js
rtk rg -n "wechat-article-crawler/(src|bin)|node:child_process|child_process" clis/weixin
```

Expected: adapter test PASS; ripgrep prints no private import or child-process use.

- [ ] **Step 6: Commit dependency boundary**

```bash
rtk git add package.json package-lock.json clis/weixin/_wechat/crawler-runtime.js clis/weixin/_wechat/crawler-runtime.test.js
rtk git commit -m "feat(weixin): add crawler runtime dependency"
```

## Task 7: Switch byCLI commands to the crawler API

**Repository:** `/Users/lijiahui/Desktop/OpenCLI`

**Files:**

- Modify: `clis/weixin/articles.js`
- Modify: `clis/weixin/articles.test.js`
- Modify: `clis/weixin/save-articles.js`
- Modify: `clis/weixin/save-articles.test.js`
- Delete: `clis/weixin/_wechat/article-service.js`
- Delete: `clis/weixin/_wechat/article-service.test.js`
- Delete: `clis/weixin/_wechat/wechat-api.js`
- Delete: `clis/weixin/_wechat/wechat-api.test.js`
- Delete: `clis/weixin/_wechat/save-service.js`
- Delete: `clis/weixin/_wechat/save-service.test.js`

- [ ] **Step 1: Repoint command tests to the public boundary and verify failure**

In both command tests, replace mocks of the three local service modules with:

```js
import * as crawler from './_wechat/crawler-runtime.js';
vi.mock('./_wechat/crawler-runtime.js');
```

Set `crawler.callCrawler.mockImplementation(operation => operation())`, then update expectations to reference `crawler.createWechatApi`, `crawler.collectArticles`, `crawler.saveArticles`, and `crawler.isTrustedWechatArticleUrl`.

Run:

```bash
rtk npx vitest run --project adapter clis/weixin/articles.test.js clis/weixin/save-articles.test.js
```

Expected: FAIL because production commands still import local services.

- [ ] **Step 2: Switch `articles` through `callCrawler`**

Replace the three service imports in `clis/weixin/articles.js` with:

```js
import { callCrawler, collectArticles, createWechatApi } from './_wechat/crawler-runtime.js';
```

Wrap only crawler-owned work:

```js
const { articles } = await callCrawler(async () => {
  const { fetchPage } = createWechatApi(credentials);
  return collectArticles({
    fakeid,
    fetchPage,
    limit: args.limit,
    maxPages: args['max-pages'],
  });
});
```

Keep the existing empty-result check and output projection unchanged.

- [ ] **Step 3: Switch `save-articles` through `callCrawler`**

Replace local service imports in `clis/weixin/save-articles.js` with:

```js
import {
  callCrawler,
  collectArticles,
  createWechatApi,
  isTrustedWechatArticleUrl,
  saveArticles,
} from './_wechat/crawler-runtime.js';
import { wechatArticleToMarkdown } from './_wechat/markdown.js';
```

Keep `fetchArticleHtml`, `fetchArticleHtmlInBrowser`, and `createArticleHtmlDownloader` in byCLI. Execute crawler work as:

```js
const rows = await callCrawler(async () => {
  const { fetchPage } = createWechatApi(credentials);
  const { articles } = await collectArticles({
    fakeid,
    fetchPage,
    limit: args.limit,
    maxPages: args['max-pages'],
  });
  return saveArticles({
    articles,
    accountName: String(args.name ?? '').trim(),
    outputDir: args.output ?? './weixin-articles',
    fetchArticleHtml: createArticleHtmlDownloader({ authSource, page }),
    buildMarkdown: wechatArticleToMarkdown,
    existingFilePolicy: 'suffix',
  });
});
```

Keep the existing row projection unchanged.

- [ ] **Step 4: Run command and browser-fallback tests**

Run:

```bash
rtk npx vitest run --project adapter clis/weixin/articles.test.js clis/weixin/save-articles.test.js
```

Expected: all tests PASS, including env browser isolation and Node-first browser fallback.

- [ ] **Step 5: Delete duplicated modules and prove no references remain**

Delete the six local implementation/test files listed above, then run:

```bash
rtk rg -n "_wechat/(article-service|wechat-api|save-service)" clis src
```

Expected: no matches.

- [ ] **Step 6: Run all WeChat adapter tests**

Run:

```bash
rtk npx vitest run --project adapter clis/weixin
```

Expected: all WeChat adapter tests PASS.

- [ ] **Step 7: Commit command migration**

```bash
rtk git add clis/weixin
rtk git commit -m "refactor(weixin): use crawler public api"
```

## Task 8: Update byCLI release guards, docs, and package smoke test

**Repository:** `/Users/lijiahui/Desktop/OpenCLI`

**Files:**

- Modify: `src/weixin-built-in-docs.test.ts`
- Modify: `docs/2026-07-14-bycli-plugin-wechat-design.md`
- Modify: `docs/adapters/browser/weixin.md`
- Modify: `scripts/check-package-install.mjs`

- [ ] **Step 1: Replace the obsolete no-dependency guard with a decoupling guard**

Update the first test in `src/weixin-built-in-docs.test.ts` to assert:

```ts
expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  .dependencies?.['@sovovs/wechat-article-crawler']).toBe('^1.1.0');
expect(adapterSource.join('\n')).toContain("from '@sovovs/wechat-article-crawler'");
expect(adapterSource.join('\n')).not.toMatch(/wechat-article-crawler\/(?:src|bin)/u);
expect(adapterSource.join('\n')).not.toMatch(/spawn|execFile|child_process/u);
```

Also assert the three deleted service paths do not exist.

- [ ] **Step 2: Run the guard and verify stale documentation fails**

Run:

```bash
rtk npx vitest run --project unit src/weixin-built-in-docs.test.ts
```

Expected: FAIL while the old design still states that no crawler dependency exists.

- [ ] **Step 3: Update documentation to the final architecture**

At the top of `docs/2026-07-14-bycli-plugin-wechat-design.md`, add a supersession note pointing to:

```text
docs/superpowers/specs/2026-07-27-wechat-crawler-package-integration-design.md
```

Revise sections that ban the dependency so they state that byCLI uses the crawler's public root API without spawning its CLI, while browser authentication and fallback remain byCLI-owned.

In `docs/adapters/browser/weixin.md`, add one concise implementation note: history collection and safe saving use the crawler library API; credentials remain managed by byCLI and are never sent to a subprocess.

- [ ] **Step 4: Extend packed installation verification**

After installing the packed byCLI tarball in `scripts/check-package-install.mjs`, add:

```js
const crawlerDirectory = join(project, 'node_modules/@sovovs/wechat-article-crawler');
const crawlerManifest = JSON.parse(readFileSync(join(crawlerDirectory, 'package.json'), 'utf8'));
assert.equal(crawlerManifest.version, '1.1.0');
const crawler = await import(pathToFileURL(join(crawlerDirectory, 'src/index.js')).href);
assert.equal(typeof crawler.default.createWechatApi, 'function');
assert.equal(typeof crawler.default.collectArticles, 'function');
assert.equal(typeof crawler.default.saveArticles, 'function');
```

- [ ] **Step 5: Run docs, build, and package checks**

Run:

```bash
rtk npx vitest run --project unit src/weixin-built-in-docs.test.ts
rtk npm run build
rtk npm run check:package-install
```

Expected: documentation guard PASS; build regenerates a stable manifest; packed installation loads the crawler runtime.

- [ ] **Step 6: Commit release artifacts and docs**

```bash
rtk git add src/weixin-built-in-docs.test.ts docs/2026-07-14-bycli-plugin-wechat-design.md docs/adapters/browser/weixin.md scripts/check-package-install.mjs cli-manifest.json
rtk git commit -m "docs(weixin): document crawler api integration"
```

## Task 9: Full verification and final integration audit

**Repositories:** both repositories

**Files:** verification only unless a test exposes a defect.

- [ ] **Step 1: Verify the crawler release tree**

From `/Users/lijiahui/Desktop/WeChat-Article-Crawler-main` run:

```bash
rtk git status --short
rtk npm test
rtk npm pack --dry-run
rtk npm view @sovovs/wechat-article-crawler@1.1.0 version --json
```

Expected: clean tree; all tests PASS; package contents are expected; registry returns `"1.1.0"`.

- [ ] **Step 2: Verify the complete byCLI tree**

From `/Users/lijiahui/Desktop/OpenCLI` run:

```bash
rtk npm run typecheck
rtk npm test
rtk npm run build
rtk npm run check:typed-error-lint
rtk npm run check:silent-column-drop
rtk npm run check:package-install
rtk git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Audit dependency direction and secret boundaries**

Run:

```bash
rtk rg -n "@sovovs/bycli|Browser Bridge|auth-session" /Users/lijiahui/Desktop/WeChat-Article-Crawler-main/src
rtk rg -n "wechat-article-crawler/(src|bin)|child_process" /Users/lijiahui/Desktop/OpenCLI/clis/weixin
rtk rg -n "WECHAT_TOKEN|WECHAT_COOKIE" /Users/lijiahui/Desktop/OpenCLI/clis/weixin /Users/lijiahui/Desktop/WeChat-Article-Crawler-main/src
```

Expected: first two commands return no matches; credential names appear only in intentional credential parsing/docs, never in returned error details or subprocess construction.

- [ ] **Step 4: Review both diffs and histories**

Run in each repository:

```bash
rtk git status --short
rtk git log -8 --oneline
```

Expected: no uncommitted implementation changes; commits follow the task boundaries above.

- [ ] **Step 5: Record the integration outcome**

In the final handoff report, include crawler version `1.1.0`, its npm verification result, byCLI's dependency range, the removed duplicate modules, all verification commands run, and any intentionally unexecuted live WeChat E2E check. Do not claim live browser or production WeChat validation unless it was actually performed.
