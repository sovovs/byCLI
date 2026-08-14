# Weixin publish-data title filenames

## Goal

Save each downloaded WeChat publish-data spreadsheet using the selected article's title, rather than the filename supplied by the WeChat download.

## Naming

The destination filename is `<title>.xls`. The title is cleaned for filesystem portability: path separators, reserved filename characters, and control characters are replaced with `_`; leading and trailing whitespace is removed. If the cleaned title is empty, the fallback is `publish-data.xls`.

The existing exclusive publish loop remains responsible for collision handling, producing `-1`, `-2`, and so on without overwriting an existing file.

## Scope

Only the destination filename in `downloadPublishData` changes. Download validation, file type, paths, metadata, and Markdown fallback behavior are unchanged. The downloaded file remains an XLS file; this change does not convert it to XLSX.

## Verification

Unit tests will prove that titles override WeChat-supplied download names, unsafe title characters are sanitized, empty titles use the fallback, and collisions remain non-destructive.
