# Weixin publish data path and reliable download design

## Goal

Extend `bycli weixin download-publish-data` so it prefers the Excel detail file and falls back to a Markdown analysis report only when the Excel download fails. The two artifacts are not generated together.

```json
{
  "title": "示例文章",
  "publishedAt": "2026-08-07",
  "url": "https://mp.weixin.qq.com/s/...",
  "status": "saved",
  "markdownPath": null,
  "dataPath": "/.../示例文章.xls",
  "size": 25088,
  "error": null
}
```

If the Excel download fails but Markdown collection succeeds, the command returns `status: "saved"`, the saved `markdownPath`, `dataPath: null`, the Markdown file size, and the redacted Excel download error. If both attempts fail, both paths and `size` are `null`, and `status` is `failed`.

## Selected approach

Keep the existing command as the orchestration boundary. After matching one published record, it first calls `downloadPublishData` with the validated detail URL, title, output directory, and timeout. On success, the public row maps the spreadsheet's returned `path` to `dataPath`, leaves `markdownPath` null, and reports the spreadsheet size.

If and only if the Excel attempt fails, the command calls `collectPublishAnalysis`. A successful fallback returns the Markdown path and size, leaves `dataPath` null, and exposes the redacted Excel error so callers can distinguish a fallback result from an Excel result. This avoids unnecessary duplicate navigation and files while still producing useful analysis data when browser download triggering fails.

This is preferred over merging Markdown and spreadsheet logic into one helper because the two artifacts have independent validation and persistence rules. It is also preferred over always producing both artifacts because callers only need one usable representation of the article data.

## Download trigger fix

`downloadPublishData` will continue to extract and validate the private `download=1` URL against the selected article's `msgid` and `publish_date`. It will record `startedAfterMs` immediately before triggering the download, then call:

```js
await page.goto(detail.link, { waitUntil: 'none' });
```

It will then use the existing `waitForDownload` filter and safety checks. The current `page.click(DOWNLOAD_SELECTOR)` path will be removed. A live diagnostic run already established that native clicking can return successfully without dispatching a DOM event, while direct navigation creates the expected Chrome download item and is observed by `waitForDownload`.

## Error and security behavior

- The download URL must pass the existing HTTPS host, path, action, message ID, publication date, and `download=1` checks before navigation.
- Download metadata must still indicate a complete, safe/accepted, non-empty file associated with the selected article.
- An Excel failure triggers Markdown collection; it does not immediately fail the command.
- If Markdown fallback succeeds, the result remains `saved`, with `markdownPath` set, `dataPath: null`, and the redacted Excel error retained.
- If Markdown fallback also fails, the command produces one `failed` row with `markdownPath: null`, `dataPath: null`, `size: null`, and a redacted error containing both failure contexts.
- Credentials and private Weixin URLs remain redacted from errors.

## Tests

Tests will be written before production changes and will cover:

1. The public command columns and Excel-success output include `dataPath`, with `markdownPath: null`.
2. Excel success does not invoke Markdown collection.
3. Excel failure invokes Markdown collection and maps its path and size while retaining the redacted Excel error.
4. Failure of both attempts returns both paths as null and preserves redaction for both errors.
5. The spreadsheet helper navigates to the trusted download URL with `waitUntil: 'none'`, records the observation time before navigation, and does not call `page.click`.
6. Untrusted URLs are rejected before any download navigation.

Related adapter tests, type checks, and the build must pass before completion.
