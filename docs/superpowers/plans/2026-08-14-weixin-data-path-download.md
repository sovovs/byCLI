# Weixin Data Path Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `weixin download-publish-data` return an Excel `dataPath` when download succeeds, fall back to a Markdown `markdownPath` only when Excel fails, and reliably trigger Excel downloads by navigating to the validated download URL.

**Architecture:** Keep spreadsheet download validation and file publication in `_wechat/publish-download.js`. Let the command adapter orchestrate Excel-first behavior and invoke the existing Markdown collector only after an Excel error; map the one saved artifact into the public response and redact any exposed failure context.

**Tech Stack:** JavaScript ES modules, byCLI adapter registry, Chrome/CDP page abstraction, Vitest.

---

## File structure

- Modify `clis/weixin/_wechat/publish-download.js`: replace the ineffective native link click with direct navigation to the already validated download URL.
- Modify `clis/weixin/_wechat/publish-download.test.js`: specify navigation ordering, download observation timing, no-click behavior, and pre-navigation rejection of unsafe links.
- Modify `clis/weixin/download-publish-data.js`: orchestrate Excel-first download, Markdown fallback, public `dataPath`, and redacted dual-failure errors.
- Modify `clis/weixin/download-publish-data.test.js`: specify output columns and all success/fallback/failure branches.

### Task 1: Reliably trigger the Excel download

**Files:**
- Modify: `clis/weixin/_wechat/publish-download.test.js`
- Modify: `clis/weixin/_wechat/publish-download.js`

- [ ] **Step 1: Write the failing direct-navigation tests**

Update the successful download test to require two navigations and no click:

```js
expect(context.page.goto.mock.calls).toEqual([
  [DETAIL_URL],
  [DOWNLOAD_URL, { waitUntil: 'none' }],
]);
expect(context.page.click).not.toHaveBeenCalled();
```

Replace the click-order test with a navigation-order test. Configure the second `goto` call to append `navigate-download` to `context.events`, keep `waitForDownload` appending `wait`, and assert:

```js
expect(context.events).toEqual(['navigate-download', 'wait']);
expect(waitOptions).toEqual({
  includeRecent: true,
  startedAfterMs: expect.any(Number),
});
expect(waitOptions.startedAfterMs).toBeGreaterThanOrEqual(before);
expect(waitOptions.startedAfterMs).toBeLessThanOrEqual(after);
```

For each untrusted-link case, additionally assert that `goto` was called exactly once with `DETAIL_URL`, proving no navigation to the unsafe candidate occurred.

- [ ] **Step 2: Run the helper tests and verify RED**

Run:

```bash
npx vitest run --project adapter clis/weixin/_wechat/publish-download.test.js
```

Expected: FAIL because production calls `page.click(DOWNLOAD_SELECTOR)` and never calls `page.goto(DOWNLOAD_URL, { waitUntil: 'none' })`.

- [ ] **Step 3: Implement the minimal download trigger fix**

In `downloadPublishData`, replace:

```js
const clickedAfterMs = Date.now();
await page.click(DOWNLOAD_SELECTOR);
```

with:

```js
const startedAfterMs = Date.now();
await page.goto(detail.link, { waitUntil: 'none' });
```

Then pass `startedAfterMs` to `waitForDownload`:

```js
{ includeRecent: true, startedAfterMs },
```

Remove `DOWNLOAD_SELECTOR` if it is no longer referenced outside the browser-side `evaluate` callback.

- [ ] **Step 4: Run the helper tests and verify GREEN**

Run:

```bash
npx vitest run --project adapter clis/weixin/_wechat/publish-download.test.js
```

Expected: all tests in `publish-download.test.js` PASS.

- [ ] **Step 5: Commit the helper fix**

```bash
git add clis/weixin/_wechat/publish-download.js clis/weixin/_wechat/publish-download.test.js
git commit -m "fix(weixin): navigate to publish data downloads"
```

### Task 2: Add Excel-first command output with Markdown fallback

**Files:**
- Modify: `clis/weixin/download-publish-data.test.js`
- Modify: `clis/weixin/download-publish-data.js`

- [ ] **Step 1: Write failing command orchestration tests**

Mock `./_wechat/publish-download.js`, import `downloadPublishData`, and make the default arrangement resolve:

```js
publishDownload.downloadPublishData.mockResolvedValue({
  status: 'downloaded',
  path: '/tmp/data.xls',
  size: 25088,
});
```

Update command metadata expectations so columns are:

```js
['title', 'publishedAt', 'url', 'status', 'markdownPath', 'dataPath', 'size', 'error']
```

Specify Excel success as:

```js
{
  title: 'Ontology Weekly',
  publishedAt: '2026-08-07',
  url: 'https://mp.weixin.qq.com/s/ontology-weekly',
  status: 'saved',
  markdownPath: null,
  dataPath: '/tmp/data.xls',
  size: 25088,
  error: null,
}
```

Assert `collectPublishAnalysis` was not called. Assert the download helper received `detailUrl`, title, output directory, and timeout.

Add an Excel-failure/Markdown-success test where `downloadPublishData` rejects with `new CommandExecutionError('download failed token-1')` and `collectPublishAnalysis` resolves with `/tmp/data.md`. Require `status: 'saved'`, `markdownPath: '/tmp/data.md'`, `dataPath: null`, Markdown size, and a redacted error that contains `download failed` but not `token-1`.

Add a dual-failure test where both helpers reject. Require `status: 'failed'`, both paths and size null, an error containing both `Excel download failed` and `Markdown fallback failed`, and no token, cookie, or private Weixin URL.

- [ ] **Step 2: Run the command tests and verify RED**

Run:

```bash
npx vitest run --project adapter clis/weixin/download-publish-data.test.js
```

Expected: FAIL because the command has no `dataPath`, does not call the spreadsheet helper, and always runs Markdown collection.

- [ ] **Step 3: Implement Excel-first orchestration**

Import the spreadsheet helper:

```js
import { downloadPublishData } from './_wechat/publish-download.js';
```

Add `dataPath` to `COLUMNS`. Extract a local sanitizer that uses the existing `redactText`, `buildSecretSet`, and private-URL replacement for every surfaced error.

After building `detailUrl`, call `downloadPublishData` first:

```js
try {
  const result = await downloadPublishData(page, commonOptions);
  return [{
    title: record.title,
    publishedAt: record.publishedAt,
    url: record.url,
    status: 'saved',
    markdownPath: null,
    dataPath: result.path,
    size: result.size,
    error: null,
  }];
} catch (downloadError) {
  // Run collectPublishAnalysis only in this branch.
}
```

On successful Markdown fallback, return its path and size with `dataPath: null` and the sanitized Excel error. If Markdown also fails, return a failed row with both paths and size null and a sanitized message in this form:

```js
`Excel download failed: ${downloadMessage}; Markdown fallback failed: ${markdownMessage}`
```

Use one shared options object so both helpers receive the same article identity, output directory, and timeout; include `publishedAt` for the Markdown collector.

- [ ] **Step 4: Run the command tests and verify GREEN**

Run:

```bash
npx vitest run --project adapter clis/weixin/download-publish-data.test.js
```

Expected: all tests in `download-publish-data.test.js` PASS.

- [ ] **Step 5: Commit the command behavior**

```bash
git add clis/weixin/download-publish-data.js clis/weixin/download-publish-data.test.js
git commit -m "feat(weixin): return publish data file paths"
```

### Task 3: Verify the integrated adapter

**Files:**
- Verify only; no planned production changes.

- [ ] **Step 1: Run both focused test files together**

```bash
npx vitest run --project adapter clis/weixin/download-publish-data.test.js clis/weixin/_wechat/publish-download.test.js
```

Expected: all focused tests PASS with no warnings.

- [ ] **Step 2: Run the full adapter test project**

```bash
npm run test:adapter
```

Expected: adapter project PASS.

- [ ] **Step 3: Run static and build verification**

```bash
npm run typecheck
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 4: Inspect the final diff**

```bash
git diff --check
git status --short
git log -5 --oneline
```

Expected: no whitespace errors; only known user-owned `tmp/` files remain untracked; implementation commits are present.
