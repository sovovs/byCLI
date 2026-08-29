# Weixin User Growth XLS Download Design

## Goal

Add a built-in command that downloads the official `.xls` workbook behind the WeChat Official Account 用户分析 → 用户增长 → 下载表格 action.

## Command Interface

```text
bycli weixin download-user-growth-data \
  --begin 2026-07-30 \
  --end 2026-08-28 \
  --source all \
  --output ./weixin-user-growth
```

Arguments:

- `--begin` and `--end` reuse the calendar validation and 30-day default window from `user-growth`.
- `--source` defaults to `all` and accepts one named or numeric source. The official workbook represents the one source selected in the WeChat UI, so comma-separated multi-source exports are rejected instead of being guessed or merged.
- `--output` defaults to `./weixin-user-growth` and is treated as a directory.
- `--timeout` defaults to 60 seconds and controls how long the browser download may take.

The command returns one row:

```text
status, path, size, begin, end, source, source_code
```

`status` is `downloaded` only after the completed file has been validated and published to the output directory.

## Download Flow

1. Reuse `resolveBrowserCredentials` to obtain the current Official Account token without persisting it.
2. Validate the dates and single source using the existing user-analysis helpers.
3. Build the authenticated official URL at `/misc/useranalysis` with `download=1`, `begin_date`, `end_date`, `source`, and `token`.
4. Navigate the browser to the URL with navigation waiting disabled, then wait for the matching browser download.
5. Accept only a completed, safe download whose observed URL is HTTPS on `mp.weixin.qq.com`, whose path is `/misc/useranalysis`, and whose download/date/source parameters exactly match the request.
6. Verify the temporary file is a non-empty regular file, create the output directory, and atomically publish it as `weixin-user-growth-<begin>-<end>-<source>.xls`. Existing files are preserved with a numeric suffix.
7. Remove the browser temporary file on a best-effort basis after publishing.

## Errors and Privacy

- Invalid dates, multiple sources, invalid timeouts, and invalid output values produce `ArgumentError`.
- Missing browser download support, unrelated or unsafe URLs, malformed metadata, unreadable files, and filesystem failures produce `CommandExecutionError`.
- A download that does not complete before the configured timeout produces `TimeoutError`.
- The token, cookies, raw authenticated URL, and browser temporary path are not exposed in command rows or error messages.
- The command has `access: write` because it creates a local artifact, while remaining read-only against WeChat.

## Testing and Release Artifacts

- Unit tests cover trusted URL matching, filename allocation, download metadata validation, empty files, timeouts, cleanup, and token redaction.
- Command tests cover registry metadata, argument defaults, credential reuse, single-source enforcement, output projection, and artifact validation.
- Documentation and manifest tests ensure the command is bundled and explain the official single-source workbook behavior.
- Final verification includes the complete Weixin adapter suite, repository gates, production build, and a real download against the logged-in account without committing the workbook.
