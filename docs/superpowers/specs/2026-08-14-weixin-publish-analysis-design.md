# WeChat Publish Analysis Markdown Design

## Goal

Change `bycli weixin download-publish-data` from downloading WeChat's XLS data
detail export to collecting the authenticated Publish Data / Content Analysis
page and saving one Markdown report per selected published item.

## Contract

The command keeps its existing single-record selection interface: an exact
published article URL or title plus optional publication date. It still scans
published records to resolve the record and opens the authenticated analysis
page. It no longer finds or clicks a `download=1` link and never writes an XLS
file.

Its result row is `title`, `publishedAt`, `url`, `status`, `markdownPath`,
`size`, and `error`. A success has `status: "saved"`, a readable Markdown
path, its byte size, and `error: null`. A page or data failure has
`status: "failed"`, null path and size, and a redacted error string.

## Collection and rendering

The collector starts browser network capture before opening the trusted
`appmsganalysis?action=detailpage` route. It accepts only successful JSON-like
responses from `mp.weixin.qq.com` while the analysis page is loaded. It keeps
the page-visible data tree and renders it without losing nested sections:

- objects of scalar values become a two-column metric table;
- arrays of records become a header-and-row table;
- nested objects and arrays become titled subsections;
- null values produce empty cells; newlines become `<br>`; and `|` is escaped.

The report starts with the article title and publication date. It contains no
token, cookie, or URL query data. A collector error is sanitized through the
existing WeChat redaction helpers before it reaches the output row or report.

## Files and errors

Markdown is saved under `--output` (default `./weixin-publish-data`) using a
safe, collision-resistant title-derived filename. Saving is atomic and does
not overwrite an existing report. Match, authentication, and published-list
errors remain command-level failures. Analysis collection or report-writing
failure becomes the selected record's returned `failed` row.

## Verification

Unit tests cover Markdown rendering, escaping, capture filtering, redaction,
safe report publication, command projection, and failure status. Adapter tests
confirm no download wait/click API is used. A browser integration run collects
the most recent three published records sequentially and verifies each returned
Markdown path is readable.
