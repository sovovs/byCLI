# Weixin User Growth All-Sources and Optional XLS Design

## Goal

Extend the existing `bycli weixin user-growth` command so one invocation can return the WeChat aggregate plus every acquisition-source breakdown, and can optionally download the official aggregate `.xls` workbook.

## Command Interface

```text
bycli weixin user-growth \
  --begin 2026-07-30 \
  --end 2026-08-28 \
  --source all-sources \
  --output ./weixin-user-growth
```

Behavior:

- `--source all` remains the WeChat aggregate source (`99999999`) for backward compatibility.
- `--source all-sources` expands, in stable order, to the aggregate followed by `search`, `qr`, `article`, `card`, `mini-program`, `reprint`, `ad`, `channels-live`, `channels`, and `other`.
- Existing named, numeric, and comma-separated source selection remains supported.
- `--output <directory>` is optional and has no default. When absent, the command performs no download and writes no local file.
- When `--output` is present, the command downloads exactly one official workbook for WeChat's aggregate “全部来源”, regardless of the value passed to `--source`.

The command keeps its growth columns and appends:

```text
official_xls_path, official_xls_size
```

The two artifact fields are `null` without `--output`. After a successful download, the validated absolute path and byte size are repeated on every growth row so the command retains one stable row shape.

## Data and Download Flow

1. Reuse `resolveBrowserCredentials`, growth date validation, and source parsing.
2. Expand `all-sources` before constructing the authenticated JSON request.
3. Collect and normalize sparse per-date source rows as today; do not invent zero-valued source/date combinations.
4. If `--output` is absent, return rows immediately with null artifact fields.
5. If `--output` is present, request `/misc/useranalysis` with `download=1`, the selected date range, source `99999999`, and the authenticated token.
6. Wait for a matching completed browser download. Accept only HTTPS `mp.weixin.qq.com/misc/useranalysis` metadata whose download, dates, and aggregate source match the request.
7. Verify a non-empty regular `.xls` file, create the output directory, and publish it atomically as `weixin-user-growth-<begin>-<end>-all.xls`. Preserve existing files with a numeric suffix.
8. Best-effort remove the browser temporary file after publishing, then attach the final path and size to every returned row.

## Errors, Access, and Privacy

- Invalid dates, sources, or output values produce `ArgumentError`.
- Missing browser download support, unsafe download metadata, malformed files, or filesystem failures produce `CommandExecutionError`.
- Download timeout uses the existing browser default and produces the existing typed timeout error.
- Download failure fails the command rather than returning data that implies the requested artifact succeeded.
- Tokens, cookies, authenticated URLs, and temporary paths never appear in command rows or error messages.
- `user-growth` changes from `access: read` to `access: write` because `--output` can create a local artifact.

## Testing and Release Artifacts

- Helper tests cover `all-sources` expansion, stable ordering, and coexistence with existing explicit selections.
- Download tests cover URL matching, aggregate-source enforcement, filename allocation, validation, cleanup, and token redaction.
- Command tests cover no-download behavior, optional output behavior, stable columns, credential reuse, and artifact projection.
- Documentation and manifest tests explain `all` versus `all-sources`, optional XLS output, and the aggregate-only official workbook.
- Verification includes the complete Weixin adapter suite, repository gates, production build, and a real logged-in download without committing the workbook.
