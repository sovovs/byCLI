# Toutiao Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public, unauthenticated `bycli toutiao search <query>` adapter command that returns richly normalized Toutiao search results.

**Architecture:** Keep the command in `clis/toutiao/search.js`, put URL/number/result normalization in `clis/toutiao/utils.js`, and keep network/error orchestration in the command. Tests will exercise helpers and the registered command with mocked `fetch`, following the existing Toutiao test style. The generated manifest will be refreshed after the adapter is implemented.

**Tech Stack:** Node.js ESM, Vitest, byCLI registry/errors, public Toutiao HTTP endpoint.

---

### Task 1: Establish the failing search contract

**Files:**
- Modify: `clis/toutiao/toutiao.test.js`
- Inspect: `clis/toutiao/utils.js`, `clis/toutiao/hot.js`, `clis/toutiao/articles.js`

- [ ] **Step 1: Inspect the current Toutiao response conventions and existing test helpers.**

Run: `rtk sed -n '1,240p' clis/toutiao/utils.js && rtk sed -n '200,430p' clis/toutiao/toutiao.test.js`

Confirm the new test imports use the existing `getRegistry()` and `__test__` conventions, and identify the public search endpoint/response shape from the current adapter patterns or a bounded live request.

- [ ] **Step 2: Add failing tests for the desired behavior.**

Add tests that assert:

```js
const search = getRegistry().get('toutiao/search');
expect(search).toBeDefined();
expect(search.args.map(({ name }) => name)).toEqual(['query', 'limit']);

const rows = parseToutiaoSearchResults({ data: [
  { title: '标题', url: '/article/1', source: '来源',
    publish_time: '2026-08-21', abstract: '摘要',
    image_url: 'https://img.example/a.jpg',
    digg_count: 12, comment_count: 3, share_count: 4, read_count: 99 },
] }, 10);
expect(rows[0]).toMatchObject({
  rank: 1,
  title: '标题',
  url: 'https://www.toutiao.com/article/1',
  source: '来源',
  summary: '摘要',
  image_url: 'https://img.example/a.jpg',
  like_count: 12,
  comment_count: 3,
  share_count: 4,
  read_count: 99,
});
```

Also cover: limit truncates to 50 maximum after normalization, missing metrics become `null`, invalid limits throw `ArgumentError`, HTTP/JSON failures throw typed command errors, and an empty upstream list throws `EmptyResultError`.

- [ ] **Step 3: Run the focused test and verify it fails for the missing adapter.**

Run: `rtk npm test -- clis/toutiao/toutiao.test.js`

Expected: FAIL because `clis/toutiao/search.js` and `parseToutiaoSearchResults` do not exist yet.

### Task 2: Implement search normalization and command

**Files:**
- Create: `clis/toutiao/search.js`
- Modify: `clis/toutiao/utils.js`

- [ ] **Step 1: Add minimal normalization helpers.**

Implement `parseSearchLimit(value, fallback = 20)` with integer range `[1, 50]`, `toNonNegativeInt` for metric fields, and `parseToutiaoSearchResults(payload, limit)` that maps the actual endpoint fields to `rank`, `title`, `url`, `source`, `publish_time`, `summary`, `image_url`, `like_count`, `comment_count`, `share_count`, and `read_count`. Preserve rows with missing optional fields as `null`; omit rows only when there is no usable title or URL. Resolve relative article URLs against `https://www.toutiao.com/`.

- [ ] **Step 2: Add the registered public command.**

Register `site: 'toutiao'`, `name: 'search'`, `access: 'read'`, `strategy: Strategy.PUBLIC`, `browser: false`, and positional `query` plus integer `limit` defaulting to 20. Build the encoded query into the verified public search endpoint, call `fetch` with browser-like `User-Agent`/`Referer` headers, reject non-2xx responses and malformed/error payloads with `CommandExecutionError`, and throw `EmptyResultError` when normalization returns no rows.

- [ ] **Step 3: Run the focused test and verify it passes.**

Run: `rtk npm test -- clis/toutiao/toutiao.test.js`

Expected: PASS, including the new normalization, registration, limit, and error tests.

### Task 3: Complete docs and generated registration

**Files:**
- Modify: `docs/adapters/browser/toutiao.md`
- Modify: `docs/adapters/index.md`
- Modify: `cli-manifest.json`

- [ ] **Step 1: Document the search command.**

Add examples for `bycli toutiao search "关键词"`, `--limit`, and `-f json`; state that it is public/no-login; list all normalized output fields and clarify that unavailable upstream metrics are `null`.

- [ ] **Step 2: Regenerate the manifest and verify the command is discoverable.**

Run: `rtk npm run build-manifest`

Expected: `cli-manifest.json` contains `toutiao/search` and the source/module path points to `toutiao/search.js`.

- [ ] **Step 3: Run the complete relevant verification.**

Run: `rtk npm run test:adapter && rtk npm run typecheck && rtk git diff --check`

Expected: all adapter tests pass, type checking succeeds, and the diff has no whitespace errors.

- [ ] **Step 4: Commit the implementation.**

Run: `rtk git add clis/toutiao docs/adapters/browser/toutiao.md docs/adapters/index.md cli-manifest.json && rtk git commit -m "feat: add Toutiao public search adapter"`

