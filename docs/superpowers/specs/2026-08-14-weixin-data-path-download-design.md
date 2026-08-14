# Weixin publish data path and reliable download design

## Goal

Extend `bycli weixin download-publish-data` so one successful result contains both the saved Markdown analysis path and the downloaded Excel detail path:

```json
{
  "title": "示例文章",
  "publishedAt": "2026-08-07",
  "url": "https://mp.weixin.qq.com/s/...",
  "status": "saved",
  "markdownPath": "/.../示例文章.md",
  "dataPath": "/.../示例文章.xls",
  "size": 3600,
  "error": null
}
```

On failure, `markdownPath`, `dataPath`, and `size` are `null`, while `error` contains the existing redacted diagnostic message.

## Selected approach

Keep the existing command as the orchestration boundary. After matching one published record, it will first save the Markdown analysis with `collectPublishAnalysis`, then download the spreadsheet with `downloadPublishData`, using the same validated detail URL, title, output directory, and timeout. The successful public row maps the spreadsheet's returned `path` to `dataPath`; `size` keeps its existing meaning and reports the Markdown file size.

This is preferred over merging Markdown and spreadsheet logic into one helper because the two artifacts have independent validation and persistence rules. It is also preferred over making the spreadsheet best-effort because the command name promises publish-data download: reporting `saved` without a spreadsheet would be misleading.

## Download trigger fix

`downloadPublishData` will continue to extract and validate the private `download=1` URL against the selected article's `msgid` and `publish_date`. It will record `startedAfterMs` immediately before triggering the download, then call:

```js
await page.goto(detail.link, { waitUntil: 'none' });
```

It will then use the existing `waitForDownload` filter and safety checks. The current `page.click(DOWNLOAD_SELECTOR)` path will be removed. A live diagnostic run already established that native clicking can return successfully without dispatching a DOM event, while direct navigation creates the expected Chrome download item and is observed by `waitForDownload`.

## Error and security behavior

- The download URL must pass the existing HTTPS host, path, action, message ID, publication date, and `download=1` checks before navigation.
- Download metadata must still indicate a complete, safe/accepted, non-empty file associated with the selected article.
- Any analysis or spreadsheet failure produces one `failed` row with `markdownPath: null`, `dataPath: null`, and `size: null`.
- Credentials and private Weixin URLs remain redacted from errors.

## Tests

Tests will be written before production changes and will cover:

1. The public command columns and successful output include `dataPath`.
2. The command calls both collectors sequentially and maps each returned path correctly.
3. Failure output contains `dataPath: null` and preserves redaction.
4. The spreadsheet helper navigates to the trusted download URL with `waitUntil: 'none'`, records the observation time before navigation, and does not call `page.click`.
5. Untrusted URLs are rejected before any download navigation.

Related adapter tests, type checks, and the build must pass before completion.
