# Remaining Search Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tested `search` commands for Baidu, Bing, Yandex, 360 Search, Sogou, Threads, GitLab, CSDN, and 52pojie with validated platform-specific inputs and normalized structured outputs.

**Architecture:** Keep one adapter per platform under `clis/<site>/search.js`. Reuse the existing search validation/browser helpers for common behavior, but keep URL construction, extraction, normalization, and platform error detection local to each adapter. Add fixture-driven unit tests before each implementation and validate each batch through the adapter test project, build, and convention checks.

**Tech Stack:** Node.js 20 ESM, bycli registry/errors, Vitest, JSDOM fixtures, browser page mocks, `URL`/`URLSearchParams`.

---

## File map

### Shared files

- Modify: `clis/_shared/search-adapter.js` only if a missing validation or error helper is needed by at least two new adapters.
- Create/modify: `clis/_shared/search-adapter.test.js` for any shared helper behavior.
- Modify: `README.md` and `README.zh-CN.md` with command examples and authentication/anti-bot limitations.

### Adapter files

- Create `clis/baidu/search.js` and `clis/baidu/search.test.js`.
- Create `clis/bing/search.js` and `clis/bing/search.test.js`.
- Create `clis/yandex/search.js` and `clis/yandex/search.test.js`.
- Create `clis/so/search.js` and `clis/so/search.test.js`.
- Create `clis/sogou/search.js` and `clis/sogou/search.test.js`.
- Create `clis/gitlab/search.js` and `clis/gitlab/search.test.js`.
- Create `clis/csdn/search.js` and `clis/csdn/search.test.js`.
- Create `clis/threads/search.js` and `clis/threads/search.test.js`.
- Create `clis/52pojie/search.js` and `clis/52pojie/search.test.js`.

Each adapter test must export/import `__test__.command` in the same style as `clis/duckduckgo/search.test.js`, so registration and pure helper behavior can be tested without live network access.

## Task 1: Establish the shared search contract

**Files:**

- Test: `clis/_shared/search-adapter.test.js`
- Modify: `clis/_shared/search-adapter.js` only when the test demonstrates a missing shared behavior.

- [ ] **Step 1: Write failing tests for shared validation and normalization helpers.** Cover blank query rejection, bounded positive limit, non-negative page/offset, canonical HTTP(S) URL conversion, typed empty-result errors, and shallow `extra` object preservation.

```js
it('rejects blank search queries before navigation', () => {
  expect(() => requireSearchQuery('  ')).toThrow(/cannot be empty/);
});

it('accepts a bounded positive integer limit', () => {
  expect(requireBoundedInteger('20', 10, 1, 100, '--limit')).toBe(20);
});
```

- [ ] **Step 2: Run the focused shared test and confirm it fails only for helpers not already present.**

Run: `npm run test:adapter -- clis/_shared/search-adapter.test.js`

Expected: existing helper assertions pass; any newly requested helper assertion fails because the helper is not exported or implemented.

- [ ] **Step 3: Implement only the missing shared helpers, preserving existing error classes and row-shape conventions.** Do not add a raw parameter passthrough.

- [ ] **Step 4: Run the focused test again and confirm it passes.**

Run: `npm run test:adapter -- clis/_shared/search-adapter.test.js`

- [ ] **Step 5: Commit the shared contract changes.**

```bash
git add clis/_shared/search-adapter.js clis/_shared/search-adapter.test.js
git commit -m "feat: extend shared search adapter contract"
```

## Task 2: Add general search engines

**Files:**

- Create: `clis/baidu/search.js`, `clis/baidu/search.test.js`
- Create: `clis/bing/search.js`, `clis/bing/search.test.js`
- Create: `clis/yandex/search.js`, `clis/yandex/search.test.js`
- Create: `clis/so/search.js`, `clis/so/search.test.js`
- Create: `clis/sogou/search.js`, `clis/sogou/search.test.js`

- [ ] **Step 1: Write registration, URL-builder, option-validation, and extraction tests for all five engines.** Each test must assert `site`, `name`, `access: read`, `strategy: public`, browser mode, required positional `keyword`, bounded `limit`, pagination, native filter flags, result columns, URL encoding, duplicate removal, and blocked/CAPTCHA detection.

```js
it('builds an encoded search URL with native filters', () => {
  expect(__test__.buildSearchUrl({
    keyword: 'open cli', limit: 10, page: 2, site: 'example.com', filetype: 'pdf',
  })).toContain('open+cli');
});

it('returns normalized rows and skips duplicate internal links', async () => {
  await expect(command.func(pageWithFixture, { keyword: 'opencli', limit: 2 })).resolves.toEqual([
    expect.objectContaining({ rank: 1, title: 'Result', url: 'https://example.com/a' }),
  ]);
});
```

- [ ] **Step 2: Run the five focused test files and verify the new tests fail because the adapters do not exist.**

Run: `npm run test:adapter -- clis/baidu/search.test.js clis/bing/search.test.js clis/yandex/search.test.js clis/so/search.test.js clis/sogou/search.test.js`

- [ ] **Step 3: Implement Baidu.** Use browser navigation to the public web search surface, expose `--site`, `--filetype`, `--platform`, `--time`, `--page`, and `--limit`, extract organic result title/url/snippet/display URL and detectable result type, and throw a typed execution error for CAPTCHA/verification pages.

- [ ] **Step 4: Implement Bing.** Build the public search URL with `--freshness`, `--market`, `--answer`, `--safe`, `--page`, and `--limit`; normalize result title/url/snippet/display URL and preserve answer/result type in `extra`.

- [ ] **Step 5: Implement Yandex.** Build the public search URL with `--lr`, `--lang`, `--page`, `--sort`, and `--limit`; normalize organic results and detect consent/block pages.

- [ ] **Step 6: Implement 360 Search under the `so` site name.** Expose `--type`, `--safe`, `--page`, and `--limit`; extract canonical result links and snippets while excluding ads and internal navigation.

- [ ] **Step 7: Implement Sogou.** Expose `--type`, `--time`, `--sort`, `--page`, and `--limit`; normalize web/news/video result types and report verification pages as typed errors.

- [ ] **Step 8: Run the five focused test files and confirm they pass.**

Run: `npm run test:adapter -- clis/baidu/search.test.js clis/bing/search.test.js clis/yandex/search.test.js clis/so/search.test.js clis/sogou/search.test.js`

- [ ] **Step 9: Build the adapter manifest and run convention checks.**

Run: `npm run build && npm run check:silent-column-drop && npm run check:typed-error-lint`

- [ ] **Step 10: Commit the engine batch.**

```bash
git add clis/baidu clis/bing clis/yandex clis/so clis/sogou
git commit -m "feat: add general search engine adapters"
```

## Task 3: Add GitLab and CSDN search

**Files:**

- Create: `clis/gitlab/search.js`, `clis/gitlab/search.test.js`
- Create: `clis/csdn/search.js`, `clis/csdn/search.test.js`

- [ ] **Step 1: Write failing tests for GitLab scope/order and CSDN content-type/sort.** Tests must cover public success fixtures, pagination, canonical URLs, author/date mapping, `extra` metadata, login/verification detection, malformed payloads, and empty results.

```js
it('maps GitLab native ordering into the request and output', async () => {
  const result = await command.func(pageWithGitLabFixture, {
    keyword: 'runner', scope: 'issues', orderBy: 'updated_at', sort: 'desc', limit: 10,
  });
  expect(result[0]).toMatchObject({ resultType: 'issue', author: 'alice' });
});
```

- [ ] **Step 2: Run both focused tests and verify the expected missing-adapter failures.**

Run: `npm run test:adapter -- clis/gitlab/search.test.js clis/csdn/search.test.js`

- [ ] **Step 3: Implement GitLab search.** Prefer the public search endpoint/page, validate `--scope`, `--order-by`, `--sort`, `--page`, and `--limit`, and map project path, result type, author, timestamp, and state into the common fields plus shallow `extra`.

- [ ] **Step 4: Implement CSDN search.** Use the public search page/endpoint, validate `--content-type`, `--sort`, `--time`, `--page`, and `--limit`, and map article title, URL, summary, author, published time, engagement values, and content type.

- [ ] **Step 5: Run both focused tests and confirm green.**

Run: `npm run test:adapter -- clis/gitlab/search.test.js clis/csdn/search.test.js`

- [ ] **Step 6: Commit the developer/content batch.**

```bash
git add clis/gitlab clis/csdn
git commit -m "feat: add GitLab and CSDN search adapters"
```

## Task 4: Add Threads and 52pojie search

**Files:**

- Create: `clis/threads/search.js`, `clis/threads/search.test.js`
- Create: `clis/52pojie/search.js`, `clis/52pojie/search.test.js`

- [ ] **Step 1: Write failing browser-fixture tests for Threads and 52pojie.** Cover required keyword, `--limit`, pagination, `--author`/date filters for Threads, `--section`/`--sort` for 52pojie, author/time mapping, forum counts, duplicate removal, authentication detection, CAPTCHA detection, and empty-result errors.

```js
it('returns Threads posts with author and timestamp', async () => {
  await expect(command.func(pageWithThreadsFixture, {
    keyword: 'opencli', author: 'alice', limit: 10,
  })).resolves.toEqual([
    expect.objectContaining({ title: expect.any(String), author: 'alice', publishedAt: expect.any(String) }),
  ]);
});
```

- [ ] **Step 2: Run both focused tests and confirm they fail because the adapters are absent.**

Run: `npm run test:adapter -- clis/threads/search.test.js clis/52pojie/search.test.js`

- [ ] **Step 3: Implement Threads browser search.** Navigate the public/logged-in search surface, apply author and date filters through supported URL or page controls, preserve post author/time/text/link, and throw the existing auth or command execution error for login/blocked pages.

- [ ] **Step 4: Implement 52pojie browser search.** Apply section and sort controls, extract thread title/link/summary/author/last-update, and put reply/view counts and section in `extra`.

- [ ] **Step 5: Run both focused tests and confirm green.**

Run: `npm run test:adapter -- clis/threads/search.test.js clis/52pojie/search.test.js`

- [ ] **Step 6: Commit the social/forum batch.**

```bash
git add clis/threads clis/52pojie
git commit -m "feat: add Threads and 52pojie search adapters"
```

## Task 5: Document commands and run integration verification

**Files:**

- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Add one command example per new site and a limitation note.** Document site names, common options, major native options, browser/login requirements, and CAPTCHA/anti-bot behavior without claiming unsupported private access.

- [ ] **Step 2: Run all adapter tests.**

Run: `npm test`

Expected: Vitest exits with code 0 and reports zero failed tests.

- [ ] **Step 3: Run typecheck and manifest/build checks.**

Run: `npm run typecheck && npm run build && npm run check:silent-column-drop && npm run check:typed-error-lint`

Expected: all commands exit with code 0; generated adapter metadata contains `baidu`, `bing`, `yandex`, `so`, `sogou`, `gitlab`, `csdn`, `threads`, and `52pojie` search commands.

- [ ] **Step 4: Verify the CLI help exposes every new site and search command.**

Run: `node dist/src/main.js --help` and `node dist/src/main.js <site> --help` for each new site.

Expected: each site lists a `search` command and its declared options; no option is silently dropped.

- [ ] **Step 5: Commit documentation and final integration changes.**

```bash
git add README.md README.zh-CN.md
git commit -m "docs: document new search adapters"
```

## Final review checklist

- [ ] All nine missing platforms have a registered `search` command.
- [ ] Every declared option is validated and affects request/navigation behavior.
- [ ] Every adapter returns normalized rows with no silent column drops.
- [ ] Empty, malformed, blocked, CAPTCHA, and auth-required responses use typed errors.
- [ ] Focused tests, full tests, typecheck, build, manifest, and convention checks pass with fresh command output.
- [ ] Existing adapters and unrelated untracked files remain unchanged.
