# Weixin Publish Data Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `bycli weixin published` for structured published-record discovery and `bycli weixin download-publish-data <query>` for deterministic single-article `.xls` detail downloads.

**Architecture:** A browser-only INTERCEPT transport captures the authenticated `appmsgpublish` JSON request, then replays paginated requests with `page.fetchJson`. A pure shared module parses and matches records, while a second shared module validates the detail page, observes the browser download, and moves the completed file without overwriting. Thin command modules expose stable CLI contracts.

**Tech Stack:** JavaScript ESM adapters, byCLI registry/errors/Page APIs, Vitest, Node `fs/promises` and `path`.

---

## File map

- Create `clis/weixin/_wechat/fixtures/published-page.json`: synthetic, credential-free `publish_page` response.
- Create `clis/weixin/_wechat/publish-records.js`: argument validation, capture, pagination, response parsing, URL/title matching, detail URL construction.
- Create `clis/weixin/_wechat/publish-records.test.js`: pure parser/matcher and mocked browser transport tests.
- Create `clis/weixin/published.js`: read command metadata and output projection.
- Create `clis/weixin/published.test.js`: command contract and delegation tests.
- Create `clis/weixin/_wechat/publish-download.js`: detail-link validation, download observation, safe non-overwriting file move.
- Create `clis/weixin/_wechat/publish-download.test.js`: download success, timeout, cross-domain, empty-file, and suffix tests.
- Create `clis/weixin/download-publish-data.js`: write command metadata, matching orchestration, and result projection.
- Create `clis/weixin/download-publish-data.test.js`: command contract, unique match, zero match, and ambiguity tests.
- Modify `cli-manifest.json`: generated adapter entries via `npm run build-manifest`.
- Create `~/.bycli/sites/weixin/verify/published.json`: local, redacted browser verification contract. The download command uses `--no-fixture` because its required article selector is private.
- Update `~/.bycli/sites/weixin/notes.md`: local endpoint and field-map observations without credentials or real response bodies.

## Task 1: Parse and normalize published records

**Files:**
- Create: `clis/weixin/_wechat/fixtures/published-page.json`
- Create: `clis/weixin/_wechat/publish-records.js`
- Create: `clis/weixin/_wechat/publish-records.test.js`

- [ ] **Step 1: Add the synthetic fixture**

Create a response whose `publish_page` is a JSON string, matching the real nesting and field names:

```json
{
  "base_resp": { "ret": 0, "err_msg": "ok" },
  "publish_page": "{\"total_count\":2,\"publish_list\":[{\"publish_info\":\"{\\\"msgid\\\":1001,\\\"sent_info\\\":{\\\"time\\\":1786032000},\\\"sent_status\\\":{\\\"succ\\\":120,\\\"fail\\\":2},\\\"appmsg_info\\\":[{\\\"appmsgid\\\":1001,\\\"itemidx\\\":1,\\\"title\\\":\\\"Ontology Weekly\\\",\\\"content_url\\\":\\\"https://mp.weixin.qq.com/s/ontology-weekly\\\",\\\"read_num\\\":88,\\\"like_num\\\":7,\\\"share_num\\\":9,\\\"moment_like_num\\\":4,\\\"comment_num\\\":3,\\\"reprint_num\\\":1,\\\"line_info\\\":{\\\"line_count\\\":5}}]}\"},{\"publish_info\":\"{\\\"msgid\\\":1002,\\\"sent_info\\\":{\\\"time\\\":1785945600},\\\"sent_status\\\":{\\\"succ\\\":90,\\\"fail\\\":0},\\\"appmsg_info\\\":[{\\\"appmsgid\\\":1002,\\\"itemidx\\\":1,\\\"title\\\":\\\"Ontology Weekly Special\\\",\\\"content_url\\\":\\\"https://mp.weixin.qq.com/s/ontology-special?scene=1\\\",\\\"read_num\\\":null,\\\"like_num\\\":null,\\\"share_num\\\":null,\\\"moment_like_num\\\":null,\\\"comment_num\\\":null,\\\"line_info\\\":{}}]}\"}]}"
}
```

- [ ] **Step 2: Write failing parser tests**

Create `publish-records.test.js` with tests that import the fixture using `readFile` and assert the exact public row plus private routing fields:

```js
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parsePublishResponse } from './publish-records.js';

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/published-page.json', import.meta.url), 'utf8',
));

describe('parsePublishResponse', () => {
  it('maps real Weixin field names and preserves routing identifiers', () => {
    const result = parsePublishResponse(fixture);
    expect(result.totalCount).toBe(2);
    expect(result.records[0]).toEqual({
      title: 'Ontology Weekly', publishedAt: '2026-08-07',
      url: 'https://mp.weixin.qq.com/s/ontology-weekly',
      notified: 120, failed: 2, reads: 88, likes: 7, shares: 9,
      recommends: 4, comments: 3, underlines: 5, reprints: 1,
      msgid: '1001', itemIdx: '1', publishDate: '2026-08-07',
    });
  });

  it('uses null for missing metrics instead of inventing zero', () => {
    expect(parsePublishResponse(fixture).records[1]).toMatchObject({
      reads: null, likes: null, shares: null, recommends: null,
      comments: null, underlines: null, reprints: null,
    });
  });

  it('rejects malformed and nonzero business responses', () => {
    expect(() => parsePublishResponse({ base_resp: { ret: 200013, err_msg: 'invalid credential' } }))
      .toThrowError(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    expect(() => parsePublishResponse({ base_resp: { ret: 200013, err_msg: 'unrelated failure' } }))
      .toThrowError(expect.objectContaining({ code: 'COMMAND_EXEC' }));
    expect(() => parsePublishResponse({ base_resp: { ret: 9 }, publish_page: '{}' }))
      .toThrowError(expect.objectContaining({ code: 'COMMAND_EXEC' }));
    expect(() => parsePublishResponse({ base_resp: { ret: 0 }, publish_page: '{' }))
      .toThrowError(expect.objectContaining({ code: 'COMMAND_EXEC' }));
  });
});
```

- [ ] **Step 3: Run the parser test and verify RED**

Run:

```bash
rtk npx vitest run clis/weixin/_wechat/publish-records.test.js
```

Expected: FAIL because `publish-records.js` does not exist.

- [ ] **Step 4: Implement the pure parser**

Create `publish-records.js` with these exact public helpers and typed failures:

```js
import {
  ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError, TimeoutError,
} from '@sovovs/bycli/errors';

const DOMAIN = 'mp.weixin.qq.com';
const LIST_PATH = '/cgi-bin/appmsgpublish';

const nullableNumber = value => Number.isFinite(value) ? Number(value) : null;

function shanghaiDate(epochSeconds) {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(epochSeconds * 1000));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseJson(value, label) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') throw new CommandExecutionError(`${label} was missing`);
  try { return JSON.parse(value); }
  catch { throw new CommandExecutionError(`${label} was invalid JSON`); }
}

function parseInfo(value) {
  let info = parseJson(value, 'Weixin publish_info');
  if (info.publish_info) info = parseJson(info.publish_info, 'Weixin nested publish_info');
  return info;
}

export function parsePublishResponse(response) {
  const ret = Number(response?.base_resp?.ret);
  const message = String(response?.base_resp?.err_msg ?? '').trim().toLowerCase();
  if (ret === 200013 && message === 'invalid credential') {
    throw new AuthRequiredError(DOMAIN, 'Weixin session expired while reading published records');
  }
  if (ret !== 0) throw new CommandExecutionError(`Weixin published-record request failed with ret=${Number.isFinite(ret) ? ret : 'missing'}`);
  const page = parseJson(response.publish_page, 'Weixin publish_page');
  const entries = Array.isArray(page.publish_list) ? page.publish_list : [];
  const records = [];
  for (const entry of entries) {
    const info = parseInfo(entry?.publish_info);
    const publishedAt = shanghaiDate(info?.sent_info?.time ?? info?.create_time);
    for (const item of Array.isArray(info?.appmsg_info) ? info.appmsg_info : []) {
      if (item?.is_deleted || !String(item?.title ?? '').trim() || !String(item?.content_url ?? '').trim()) continue;
      const msgid = String(info.msgid ?? item.msgid ?? item.appmsgid ?? '').trim();
      const itemIdx = String(item.itemidx ?? '').trim();
      if (!msgid || !itemIdx || !publishedAt) throw new CommandExecutionError('Weixin published record lacked routing fields');
      records.push({
        title: String(item.title).trim(), publishedAt, url: String(item.content_url).trim(),
        notified: nullableNumber(info?.sent_status?.succ), failed: nullableNumber(info?.sent_status?.fail),
        reads: nullableNumber(item.read_num), likes: nullableNumber(item.like_num),
        shares: nullableNumber(item.share_num), recommends: nullableNumber(item.moment_like_num),
        comments: nullableNumber(item.comment_num), underlines: nullableNumber(item?.line_info?.line_count),
        reprints: nullableNumber(item.reprint_num), msgid, itemIdx, publishDate: publishedAt,
      });
    }
  }
  return { totalCount: Number.isSafeInteger(page.total_count) ? page.total_count : entries.length, records };
}
```

- [ ] **Step 5: Run the parser test and verify GREEN**

Run the same Vitest command. Expected: 3 tests PASS.

- [ ] **Step 6: Commit parser and fixture**

```bash
rtk git add clis/weixin/_wechat/fixtures/published-page.json clis/weixin/_wechat/publish-records.js clis/weixin/_wechat/publish-records.test.js
rtk git commit -m "feat(weixin): parse published records"
```

## Task 2: Capture, paginate, and match records

**Files:**
- Modify: `clis/weixin/_wechat/publish-records.js`
- Modify: `clis/weixin/_wechat/publish-records.test.js`

- [ ] **Step 1: Add failing browser-transport and matcher tests**

Append tests using a mocked page. The transport test must prove the captured fingerprint URL is replayed with updated `begin`, while the matcher tests prove deterministic precedence:

```js
import { vi } from 'vitest';
import {
  collectPublishedRecords, matchPublishedRecord, buildDetailUrl,
} from './publish-records.js';

it('captures the authenticated JSON request and paginates with fetchJson', async () => {
  const page = {
    startNetworkCapture: vi.fn().mockResolvedValue(true),
    readNetworkCapture: vi.fn().mockResolvedValue([{ url: 'https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&begin=0&count=10&fingerprint=fp&token=t&lang=zh_CN&f=json&ajax=1' }]),
    goto: vi.fn().mockResolvedValue(undefined), wait: vi.fn().mockResolvedValue(undefined),
    fetchJson: vi.fn().mockResolvedValue(fixture),
  };
  const rows = await collectPublishedRecords(page, { token: 't', limit: 2, maxPages: 1 });
  expect(rows).toHaveLength(2);
  expect(page.startNetworkCapture).toHaveBeenCalledWith('/cgi-bin/appmsgpublish');
  expect(page.fetchJson.mock.calls[0][0]).toContain('fingerprint=fp');
});

it('matches URL, exact title, substring, and date in that order', () => {
  const rows = parsePublishResponse(fixture).records;
  expect(matchPublishedRecord(rows, 'https://mp.weixin.qq.com/s/ontology-special?scene=9').msgid).toBe('1002');
  expect(matchPublishedRecord(rows, 'Ontology Weekly').msgid).toBe('1001');
  expect(matchPublishedRecord(rows, 'Special').msgid).toBe('1002');
  expect(matchPublishedRecord(rows, 'Ontology Weekly', '2026-08-07').msgid).toBe('1001');
});

it('returns typed errors for zero and ambiguous matches', () => {
  const rows = parsePublishResponse(fixture).records;
  expect(() => matchPublishedRecord(rows, 'missing')).toThrowError(expect.objectContaining({ code: 'EMPTY_RESULT' }));
  expect(() => matchPublishedRecord(rows, 'Ontology')).toThrowError(expect.objectContaining({ code: 'ARGUMENT' }));
});

it('builds a trusted detail URL without credentials', () => {
  const row = parsePublishResponse(fixture).records[0];
  expect(buildDetailUrl(row, 't')).toBe('https://mp.weixin.qq.com/misc/appmsganalysis?action=detailpage&msgid=1001_1&publish_date=2026-08-07&type=int&pageVersion=1&token=t&lang=zh_CN');
});
```

- [ ] **Step 2: Run the expanded test and verify RED**

Expected: FAIL because the three exported helpers are absent.

- [ ] **Step 3: Implement validation, capture, pagination, matching, and URL building**

Append these helpers to `publish-records.js`; keep the captured URL in memory only:

```js
const TRACKING_PARAMS = new Set([
  'scene', 'srcid', 'from', 'isappinstalled', 'sharer_shareinfo',
  'sharer_shareinfo_first', 'exportkey', 'pass_ticket', 'wx_header',
]);

export function positiveSafeInteger(value, name, fallback) {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ArgumentError(`${name} must be a positive safe integer`);
  return parsed;
}

function trustedListUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === DOMAIN && url.port === ''
      && url.pathname === LIST_PATH && url.searchParams.get('f') === 'json'
      && url.searchParams.get('sub') === 'list';
  } catch { return false; }
}

async function captureListUrl(page, token, timeoutSeconds) {
  if (!page?.startNetworkCapture || !page?.readNetworkCapture || !page?.fetchJson) {
    throw new CommandExecutionError('Browser Bridge does not support Weixin publish capture');
  }
  if (await page.startNetworkCapture(LIST_PATH) === false) {
    throw new CommandExecutionError('Browser Bridge could not capture the Weixin publish request');
  }
  await page.goto(`https://${DOMAIN}${LIST_PATH}?sub=list&begin=0&count=10&token=${encodeURIComponent(token)}&lang=zh_CN`);
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const entries = await page.readNetworkCapture();
    const found = Array.isArray(entries) ? entries.find(entry => trustedListUrl(entry?.url)) : null;
    if (found) return found.url;
    await page.wait(0.2);
  }
  throw new TimeoutError('Weixin published-record capture', timeoutSeconds);
}

export async function collectPublishedRecords(page, options) {
  const limit = positiveSafeInteger(options.limit, 'limit', 10);
  const maxPages = positiveSafeInteger(options.maxPages, 'max-pages', 5);
  const timeoutSeconds = positiveSafeInteger(options.timeout, 'timeout', 30);
  const seed = new URL(await captureListUrl(page, options.token, timeoutSeconds));
  const records = [];
  const seen = new Set();
  for (let pageIndex = 0; pageIndex < maxPages && records.length < limit; pageIndex += 1) {
    const url = new URL(seed);
    url.searchParams.set('begin', String(pageIndex * 10));
    url.searchParams.set('count', '10');
    const parsed = parsePublishResponse(await page.fetchJson(url.href, { timeoutMs: timeoutSeconds * 1000 }));
    for (const row of parsed.records) {
      const key = `${row.msgid}:${row.itemIdx}`;
      if (!seen.has(key)) { seen.add(key); records.push(row); }
    }
    if (parsed.records.length === 0 || (pageIndex + 1) * 10 >= parsed.totalCount) break;
  }
  if (records.length === 0) throw new EmptyResultError('weixin published', 'No published records were returned by Weixin.');
  return records.slice(0, limit);
}

function normalizedTitle(value) { return String(value ?? '').trim().replace(/\s+/g, ' '); }

function normalizedArticleUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.hostname !== DOMAIN) return null;
    url.hash = '';
    for (const name of TRACKING_PARAMS) url.searchParams.delete(name);
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}

export function matchPublishedRecord(records, query, date) {
  const text = normalizedTitle(query);
  if (!text) throw new ArgumentError('query is required');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ArgumentError('date must use YYYY-MM-DD');
  const dated = date ? records.filter(row => row.publishedAt === date) : records;
  const url = normalizedArticleUrl(text);
  const stages = url
    ? [dated.filter(row => normalizedArticleUrl(row.url) === url)]
    : [dated.filter(row => normalizedTitle(row.title) === text), dated.filter(row => normalizedTitle(row.title).includes(text))];
  for (const matches of stages) {
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const hint = matches.slice(0, 5).map(row => `${row.publishedAt} ${row.title} ${row.url}`).join('\n');
      throw new ArgumentError(`query matched multiple published records\n${hint}`, 'Use the full article URL or add --date YYYY-MM-DD');
    }
  }
  throw new EmptyResultError('weixin download-publish-data', `No published record matched "${text}".`);
}

export function buildDetailUrl(record, token) {
  const url = new URL(`https://${DOMAIN}/misc/appmsganalysis`);
  url.search = new URLSearchParams({
    action: 'detailpage', msgid: `${record.msgid}_${record.itemIdx}`,
    publish_date: record.publishDate, type: 'int', pageVersion: '1', token, lang: 'zh_CN',
  }).toString();
  return url.href;
}
```

- [ ] **Step 4: Run the shared tests and verify GREEN**

Expected: all parser, transport, matcher, and URL tests PASS.

- [ ] **Step 5: Commit transport and matching**

```bash
rtk git add clis/weixin/_wechat/publish-records.js clis/weixin/_wechat/publish-records.test.js
rtk git commit -m "feat(weixin): collect and match published records"
```

## Task 3: Expose the `published` command

**Files:**
- Create: `clis/weixin/published.js`
- Create: `clis/weixin/published.test.js`

- [ ] **Step 1: Write the failing command-contract test**

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import * as auth from './_wechat/auth-session.js';
import * as records from './_wechat/publish-records.js';

vi.mock('./_wechat/auth-session.js');
vi.mock('./_wechat/publish-records.js');
await import('./published.js');

describe('weixin published command', () => {
  const command = getRegistry().get('weixin/published');
  beforeEach(() => vi.resetAllMocks());

  it('registers stable read metadata and columns', () => {
    expect(command).toMatchObject({
      site: 'weixin', name: 'published', access: 'read', strategy: 'intercept',
      browser: true, domain: 'mp.weixin.qq.com',
      columns: ['title', 'publishedAt', 'url', 'notified', 'failed', 'reads', 'likes', 'shares', 'recommends', 'comments', 'underlines', 'reprints'],
    });
  });

  it('collects, filters, limits, and removes private routing fields', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 't', cookie: 'secret' });
    records.collectPublishedRecords.mockResolvedValue([
      { title: 'Alpha', publishedAt: '2026-08-07', url: 'https://mp.weixin.qq.com/s/a', notified: 1, failed: 0, reads: 2, likes: 3, shares: 4, recommends: 5, comments: 6, underlines: 7, reprints: 8, msgid: '1', itemIdx: '1', publishDate: '2026-08-07' },
    ]);
    await expect(command.func({}, { query: 'Alpha', limit: 10, 'max-pages': 5 }))
      .resolves.toEqual([{ title: 'Alpha', publishedAt: '2026-08-07', url: 'https://mp.weixin.qq.com/s/a', notified: 1, failed: 0, reads: 2, likes: 3, shares: 4, recommends: 5, comments: 6, underlines: 7, reprints: 8 }]);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Expected: FAIL because `published.js` is absent.

- [ ] **Step 3: Implement the thin command**

```js
import { EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { resolveBrowserCredentials } from './_wechat/auth-session.js';
import { collectPublishedRecords } from './_wechat/publish-records.js';

const columns = ['title', 'publishedAt', 'url', 'notified', 'failed', 'reads', 'likes', 'shares', 'recommends', 'comments', 'underlines', 'reprints'];

export const publishedCommand = cli({
  site: 'weixin', name: 'published', access: 'read', domain: 'mp.weixin.qq.com',
  description: 'List Weixin published records and engagement metrics',
  strategy: Strategy.INTERCEPT, browser: true, navigateBefore: false,
  args: [
    { name: 'query', positional: true, help: 'Optional article title or URL filter' },
    { name: 'limit', type: 'int', default: 10, help: 'Maximum articles to return' },
    { name: 'max-pages', type: 'int', default: 5, help: 'Maximum published-record pages to scan' },
    { name: 'timeout', type: 'int', default: 30, help: 'Maximum seconds for request capture' },
  ],
  columns,
  func: async (page, args) => {
    const { token } = await resolveBrowserCredentials(page);
    const query = String(args.query ?? '').trim();
    const maxPages = args['max-pages'] ?? 5;
    const rows = await collectPublishedRecords(page, {
      token, limit: query ? maxPages * 10 : args.limit, maxPages, timeout: args.timeout,
    });
    const filtered = rows.filter(row => !query || row.title.includes(query) || row.url.includes(query));
    if (filtered.length === 0) throw new EmptyResultError('weixin published', `No published record matched "${query}".`);
    return filtered.slice(0, args.limit ?? 10)
      .map(row => Object.fromEntries(columns.map(name => [name, row[name]])));
  },
});
```

- [ ] **Step 4: Run command and shared tests; verify GREEN**

```bash
rtk npx vitest run clis/weixin/published.test.js clis/weixin/_wechat/publish-records.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the list command**

```bash
rtk git add clis/weixin/published.js clis/weixin/published.test.js
rtk git commit -m "feat(weixin): list published metrics"
```

## Task 4: Implement safe browser download handling

**Files:**
- Create: `clis/weixin/_wechat/publish-download.js`
- Create: `clis/weixin/_wechat/publish-download.test.js`

- [ ] **Step 1: Write failing download-helper tests**

Use a temporary directory created by Vitest and a mocked page:

```js
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadPublishData } from './publish-download.js';

const dirs = [];
afterEach(async () => Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))));

async function fixturePage(source, link) {
  await writeFile(source, 'xls-bytes');
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({ title: 'Ontology Weekly', link }),
    click: vi.fn().mockResolvedValue({ matches_n: 1, match_level: 'exact' }),
    waitForDownload: vi.fn().mockResolvedValue({ downloaded: true, filename: source, totalBytes: 9, state: 'complete', danger: 'safe', mime: 'application/vnd.ms-excel', elapsedMs: 2 }),
  };
}

describe('downloadPublishData', () => {
  it('validates, downloads, and moves without overwriting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bycli-weixin-')); dirs.push(dir);
    const source = join(dir, 'browser.xls');
    const output = join(dir, 'out');
    const detailUrl = 'https://mp.weixin.qq.com/misc/appmsganalysis?action=detailpage&msgid=1001_1&publish_date=2026-08-07&type=int&pageVersion=1&token=t&lang=zh_CN';
    const page = await fixturePage(source, `${detailUrl}&download=1`);
    const result = await downloadPublishData(page, { detailUrl, title: 'Ontology Weekly', outputDir: output, timeoutSeconds: 60 });
    expect(result.status).toBe('downloaded');
    expect(result.size).toBe(9);
    expect(await readFile(result.path, 'utf8')).toBe('xls-bytes');
  });

  it('rejects cross-domain links and download timeouts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bycli-weixin-')); dirs.push(dir);
    const page = await fixturePage(join(dir, 'a.xls'), 'https://evil.test/file.xls?download=1');
    await expect(downloadPublishData(page, { detailUrl: 'https://mp.weixin.qq.com/misc/appmsganalysis?action=detailpage&msgid=1001_1', title: 'A', outputDir: dir, timeoutSeconds: 1 }))
      .rejects.toMatchObject({ code: 'COMMAND_EXEC' });
    page.evaluate.mockResolvedValue({ title: 'A', link: 'https://mp.weixin.qq.com/misc/appmsganalysis?action=detailpage&msgid=1001_1&download=1' });
    page.waitForDownload.mockResolvedValue({ downloaded: false, elapsedMs: 1000, error: 'timeout' });
    await expect(downloadPublishData(page, { detailUrl: 'https://mp.weixin.qq.com/misc/appmsganalysis?action=detailpage&msgid=1001_1', title: 'A', outputDir: dir, timeoutSeconds: 1 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
```

- [ ] **Step 2: Run the helper test and verify RED**

Expected: FAIL because `publish-download.js` does not exist.

- [ ] **Step 3: Implement trusted link validation and exclusive file movement**

```js
import { constants } from 'node:fs';
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';

function safeName(filename, title) {
  const fallback = `数据明细（${title}）.xls`;
  const cleaned = basename(filename || fallback).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return cleaned.toLowerCase().endsWith('.xls') ? cleaned : `${cleaned}.xls`;
}

function trustedDownloadLink(raw, expected) {
  try {
    const link = new URL(raw);
    const detail = new URL(expected);
    return link.protocol === 'https:' && link.hostname === 'mp.weixin.qq.com' && link.port === ''
      && link.pathname === '/misc/appmsganalysis' && link.searchParams.get('action') === 'detailpage'
      && link.searchParams.get('msgid') === detail.searchParams.get('msgid')
      && link.searchParams.get('publish_date') === detail.searchParams.get('publish_date')
      && link.searchParams.get('download') === '1';
  } catch { return false; }
}

async function copyExclusive(source, outputDir, filename) {
  await mkdir(outputDir, { recursive: true });
  const stem = filename.slice(0, filename.length - extname(filename).length);
  const ext = extname(filename);
  for (let n = 0; n < 10_000; n += 1) {
    const target = resolve(outputDir, n === 0 ? filename : `${stem}-${n}${ext}`);
    try { await copyFile(source, target, constants.COPYFILE_EXCL); await unlink(source); return target; }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
  }
  throw new CommandExecutionError('Could not allocate a unique publish-data filename');
}

export async function downloadPublishData(page, options) {
  if (!page?.waitForDownload) throw new CommandExecutionError('Browser Bridge does not support download observation');
  await page.goto(options.detailUrl);
  const detail = await page.evaluate(() => ({
    title: document.querySelector('#js_mp_main_content')?.textContent ?? '',
    link: document.querySelector('a.target_part[href*="download=1"]')?.href ?? '',
  }));
  if (!detail.title.includes(options.title)) throw new CommandExecutionError('Weixin publish-data page did not match the selected article');
  if (!trustedDownloadLink(detail.link, options.detailUrl)) throw new CommandExecutionError('Weixin publish-data download link was rejected');
  const waiting = page.waitForDownload('.xls', options.timeoutSeconds * 1000);
  await page.click('a.target_part[href*="download=1"]');
  const downloaded = await waiting;
  if (!downloaded?.downloaded) throw new TimeoutError('Weixin publish-data download', options.timeoutSeconds);
  if (!downloaded.filename || downloaded.state !== 'complete' || downloaded.danger === 'dangerous') {
    throw new CommandExecutionError('Weixin publish-data download did not complete safely');
  }
  const sourceStat = await stat(downloaded.filename);
  if (!sourceStat.isFile() || sourceStat.size <= 0) throw new CommandExecutionError('Weixin publish-data download was empty');
  const filename = safeName(downloaded.filename, options.title);
  const path = await copyExclusive(downloaded.filename, resolve(options.outputDir), filename);
  return { status: 'downloaded', path, size: sourceStat.size };
}
```

- [ ] **Step 4: Run the helper test and verify GREEN**

Expected: all helper tests PASS and temporary directories are removed.

- [ ] **Step 5: Commit download handling**

```bash
rtk git add clis/weixin/_wechat/publish-download.js clis/weixin/_wechat/publish-download.test.js
rtk git commit -m "feat(weixin): safely download publish data"
```

## Task 5: Expose `download-publish-data`

**Files:**
- Create: `clis/weixin/download-publish-data.js`
- Create: `clis/weixin/download-publish-data.test.js`

- [ ] **Step 1: Write the failing command test**

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import * as auth from './_wechat/auth-session.js';
import * as records from './_wechat/publish-records.js';
import * as downloads from './_wechat/publish-download.js';

vi.mock('./_wechat/auth-session.js');
vi.mock('./_wechat/publish-records.js');
vi.mock('./_wechat/publish-download.js');
await import('./download-publish-data.js');

describe('weixin download-publish-data command', () => {
  const command = getRegistry().get('weixin/download-publish-data');
  beforeEach(() => vi.resetAllMocks());

  it('registers exact write metadata', () => {
    expect(command).toMatchObject({
      site: 'weixin', name: 'download-publish-data', access: 'write',
      strategy: 'intercept', browser: true, domain: 'mp.weixin.qq.com',
      columns: ['title', 'publishedAt', 'url', 'status', 'path', 'size'],
    });
  });

  it('collects, uniquely matches, downloads, and maps output', async () => {
    const row = { title: 'Alpha', publishedAt: '2026-08-07', url: 'https://mp.weixin.qq.com/s/a', msgid: '1', itemIdx: '1', publishDate: '2026-08-07' };
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 't', cookie: 'secret' });
    records.collectPublishedRecords.mockResolvedValue([row]);
    records.matchPublishedRecord.mockReturnValue(row);
    records.buildDetailUrl.mockReturnValue('https://mp.weixin.qq.com/misc/appmsganalysis?action=detailpage&msgid=1_1');
    downloads.downloadPublishData.mockResolvedValue({ status: 'downloaded', path: '/out/a.xls', size: 42 });
    await expect(command.func({}, { query: 'Alpha', output: '/out', 'max-pages': 5, timeout: 60 }))
      .resolves.toEqual([{ title: 'Alpha', publishedAt: '2026-08-07', url: row.url, status: 'downloaded', path: '/out/a.xls', size: 42 }]);
  });
});
```

- [ ] **Step 2: Run the command test and verify RED**

Expected: FAIL because `download-publish-data.js` is absent.

- [ ] **Step 3: Implement the orchestration command**

```js
import { ArgumentError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { resolveBrowserCredentials } from './_wechat/auth-session.js';
import { downloadPublishData } from './_wechat/publish-download.js';
import {
  buildDetailUrl, collectPublishedRecords, matchPublishedRecord, positiveSafeInteger,
} from './_wechat/publish-records.js';

export const downloadPublishDataCommand = cli({
  site: 'weixin', name: 'download-publish-data', access: 'write', domain: 'mp.weixin.qq.com',
  description: 'Match a Weixin published article and download its detail spreadsheet',
  strategy: Strategy.INTERCEPT, browser: true, navigateBefore: false,
  args: [
    { name: 'query', positional: true, required: true, help: 'Exact article URL or title text' },
    { name: 'date', help: 'Optional publication date in YYYY-MM-DD' },
    { name: 'output', default: './weixin-publish-data', help: 'Directory for downloaded spreadsheets' },
    { name: 'max-pages', type: 'int', default: 5, help: 'Maximum published-record pages to scan' },
    { name: 'timeout', type: 'int', default: 60, help: 'Maximum seconds for capture and download' },
  ],
  columns: ['title', 'publishedAt', 'url', 'status', 'path', 'size'],
  func: async (page, args) => {
    const query = String(args.query ?? '').trim();
    if (!query) throw new ArgumentError('query is required');
    const timeoutSeconds = positiveSafeInteger(args.timeout, 'timeout', 60);
    const { token } = await resolveBrowserCredentials(page);
    const rows = await collectPublishedRecords(page, {
      token, limit: positiveSafeInteger(args['max-pages'], 'max-pages', 5) * 10,
      maxPages: args['max-pages'], timeout: timeoutSeconds,
    });
    const record = matchPublishedRecord(rows, query, args.date);
    const result = await downloadPublishData(page, {
      detailUrl: buildDetailUrl(record, token), title: record.title,
      outputDir: args.output ?? './weixin-publish-data', timeoutSeconds,
    });
    return [{ title: record.title, publishedAt: record.publishedAt, url: record.url, ...result }];
  },
});
```

- [ ] **Step 4: Run all new command and helper tests; verify GREEN**

```bash
rtk npx vitest run clis/weixin/published.test.js clis/weixin/download-publish-data.test.js clis/weixin/_wechat/publish-records.test.js clis/weixin/_wechat/publish-download.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the download command**

```bash
rtk git add clis/weixin/download-publish-data.js clis/weixin/download-publish-data.test.js
rtk git commit -m "feat(weixin): download published data details"
```

## Task 6: Generate manifests and run repository verification

**Files:**
- Modify: `cli-manifest.json`

- [ ] **Step 1: Rebuild the adapter manifest**

```bash
rtk npm run build-manifest
```

Expected: manifest generation succeeds and includes `weixin/published` plus `weixin/download-publish-data`.

- [ ] **Step 2: Run the complete Weixin test suite**

```bash
rtk npx vitest run 'clis/weixin/**/*.test.js'
```

Expected: all Weixin tests PASS with no warnings or unhandled rejections.

- [ ] **Step 3: Run semantic, convention, type, build, and diff checks**

```bash
rtk npx tsx src/main.ts validate weixin
rtk npx tsx src/main.ts convention-audit weixin
rtk npx tsc --noEmit
rtk npm run build
rtk git diff --check
```

Expected: every command exits 0; validation reports both new commands and no new convention violations.

- [ ] **Step 4: Commit generated manifest changes**

```bash
rtk git add cli-manifest.json
rtk git commit -m "chore(weixin): register publish data commands"
```

## Task 7: Real-browser verification and site memory

**Files:**
- Create: `~/.bycli/sites/weixin/verify/published.json`
- Modify: `~/.bycli/sites/weixin/notes.md`

- [ ] **Step 1: Verify the list command with trace and write a local fixture**

```bash
rtk npx tsx src/main.ts weixin published --limit 3 --max-pages 1 --trace on --keep-tab true --window foreground -f json
rtk npx tsx src/main.ts browser weixin-verify verify weixin/published --write-fixture --seed-args '{"limit":3,"max-pages":1}'
```

Expected: three rows contain nonempty `title`, `publishedAt`, and `url`; visible metrics match the Weixin page; the fixture contains patterns/types but no real token, Cookie, fingerprint, or response body.

- [ ] **Step 2: Verify unique matching and a real `.xls` download**

Capture one exact URL returned by Step 1 in `/tmp` and a shell-local task variable; neither is committed:

```bash
rtk npx tsx src/main.ts weixin published --limit 1 --max-pages 1 -f json > /tmp/bycli-weixin-published.json
BYCLI_WEIXIN_ARTICLE_URL="$(rtk jq -r '.[0].url' /tmp/bycli-weixin-published.json)"
rtk npx tsx src/main.ts weixin download-publish-data "$BYCLI_WEIXIN_ARTICLE_URL" --max-pages 1 --output /tmp/bycli-weixin-publish-data --trace on --keep-tab true --window foreground -f json
rtk npx tsx src/main.ts browser weixin-verify verify weixin/download-publish-data --no-fixture --seed-args "{\"query\":\"$BYCLI_WEIXIN_ARTICLE_URL\",\"max-pages\":1,\"output\":\"/tmp/bycli-weixin-publish-data\"}"
rtk file /tmp/bycli-weixin-publish-data/*.xls
```

Expected: one result with `status: "downloaded"`, an absolute `.xls` path, and positive `size`; `file` confirms a Microsoft Excel-compatible document. Use `--no-fixture` so the private article URL is never persisted.

- [ ] **Step 3: Tighten the list fixture and repeat the private download check**

Set the `published` fixture `rowCount` to a bounded range, require `notEmpty` for `title`, `publishedAt`, and `url`, require ISO date and HTTPS URL patterns, and keep numeric metrics as `number|null`. Run `browser weixin-verify verify weixin/published` again and repeat Step 2 with `--no-fixture`; expected: the list matches its fixture and the private download still succeeds without persisting its selector.

- [ ] **Step 4: Update local site memory without secrets**

Prepend a dated section to `~/.bycli/sites/weixin/notes.md` recording:

```markdown
## 2026-08-13 by Codex

- `appmsgpublish` returns list data in a JSON-encoded `publish_page` field.
- Metrics map from `read_num`, `like_num`, `share_num`, `moment_like_num`, `comment_num`, `line_info.line_count`, and `reprint_num`.
- The single-article detail route uses `msgid=<msgid>_<itemidx>` and `publish_date=YYYY-MM-DD`.
- The verified download link is same-origin and adds `download=1`; Browser Bridge returns a completed `.xls` path.
- Never persist token, Cookie, fingerprint, raw private responses, article URLs, or titles in site memory.
```

- [ ] **Step 5: Final repository check and handoff commit**

```bash
rtk git status --short
rtk git diff --check
```

Expected: only intentional repository changes remain; `~/.bycli/sites/weixin/**` stays outside the repository. If any repository cleanup is required, commit it with:

```bash
rtk git add clis/weixin cli-manifest.json
rtk git commit -m "test(weixin): verify publish data download"
```
