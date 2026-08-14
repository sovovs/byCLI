# WeChat Collection Content Analysis Design

## Goal

Change `bycli weixin collection-detail` from returning only the collection's
ordered content metadata to enriching every returned content item with the
data shown after clicking **发表数据** (Publish data) in the WeChat Official
Accounts backend.

The command continues to return one collection row. `itemsJson` remains a
compact JSON string, but each item retains its existing base fields and gains
either `analysisMarkdown` or `analysisError`.

## Scope

- Keep the existing collection lookup, pagination, collection settings, and
  one-row command output contract.
- For every collected item, identify its published-content analysis route.
- Read the authenticated 图文 (article) or 视频 (video) content-analysis view.
- Capture all data represented by the view's analysis requests and render it
  as a Markdown document made of titled tables.
- Preserve an item's base fields if its analysis cannot be retrieved; attach a
  safe `analysisError` and continue with the other items.

The command does not create spreadsheets, Markdown files, or other output
artifacts. It does not emit raw response JSON.

## Output contract

Each object in decoded `itemsJson` has all current fields, plus exactly one of
the following fields:

```json
{
  "appmsgId": "70001",
  "title": "Example article",
  "link": "https://mp.weixin.qq.com/...",
  "analysisMarkdown": "## 内容分析\n\n### 汇总指标\n\n| 指标 | 值 |\n| --- | --- |\n| 阅读次数 | 123 |"
}
```

or:

```json
{
  "appmsgId": "70002",
  "title": "Unavailable article",
  "link": "https://mp.weixin.qq.com/...",
  "analysisError": "Analysis data is unavailable for this item."
}
```

`analysisMarkdown` contains all visible analysis sections. A scalar object is
rendered as a two-column metric table. An array of records becomes a table
whose columns are the record keys. Nested objects and arrays receive section
headings so their meaning remains visible. Cell newlines are converted to
`<br>` and Markdown table separators (`|`) are escaped. `null` values render
as an empty cell.

## Architecture

### Collection orchestration

`collection-detail` remains responsible for validating command options,
resolving the authenticated browser token, locating the collection type, and
retrieving the paginated collection items. It then enriches each returned item
independently and serializes the complete list into `itemsJson`.

`--max-pages` retains its present meaning: it bounds collection-list lookup
and collection-item pagination. Every item obtained within that bound is
eligible for analysis collection.

### Published-content route resolution

A route resolver uses the existing authenticated published-record listing to
associate a collection item with its published record. For article items it
uses the existing `msgid`, item index, and Shanghai publication date to build
the `appmsganalysis?action=detailpage` route. Video analysis uses the
corresponding `videoanalysis?action=stat_all_video_page` flow and resolves the
page-specific identifier from the item/page data.

No route containing token or cookie data is returned, persisted, or included
in an error.

### Analysis collector

A dedicated WeChat analysis module owns browser navigation, trusted-page
validation, request capture, and response parsing. Article and video
collectors are separate adapters behind one item-analysis interface, so their
different pages and internal responses do not leak into collection logic.

The collector runs items sequentially. This keeps browser navigation
deterministic and avoids unnecessary bursts against the Official Accounts
backend.

### Markdown formatter

A pure formatter receives the normalized visible-analysis tree and produces
the `analysisMarkdown` string. It does not access the browser or credentials.
It recursively emits headings and tables, providing deterministic output and
focused unit tests.

## Error handling and privacy

- Authentication loss, invalid collection payloads, and invalid collection
  pagination remain command-level errors.
- An unmatched published record, unavailable analysis data, unsupported item,
  or analysis-page/request failure affects only that item. The item is
  retained with a sanitized `analysisError`.
- Errors and captured values are redacted before serialization. Tokens,
  cookies, and URLs carrying sensitive query parameters are never present in
  `itemsJson`, diagnostics, tests, fixtures, or documentation.
- A malformed analysis response is treated as an item-level retrieval failure,
  rather than guessing or silently omitting sections.

## Verification

Tests will cover:

1. article and video route selection and trusted-page checks;
2. capture and normalization of complete nested analysis data;
3. scalar, record-array, nested, null, newline, and pipe handling in Markdown
   tables;
4. per-item failure continuation and sanitized `analysisError` values;
5. no credential leakage in output or error paths; and
6. existing collection pagination, output shape, and authentication behavior.

The command-level tests will verify a single collection row whose `itemsJson`
contains base item fields plus `analysisMarkdown` for successful items and
`analysisError` for failures.
