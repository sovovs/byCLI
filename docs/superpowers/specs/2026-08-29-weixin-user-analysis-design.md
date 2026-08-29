# Weixin User Analysis Design

## Goal

Add built-in `bycli weixin` commands that expose the WeChat Official Accounts “用户增长” and “用户属性” datasets through stable, machine-readable rows.

## Chosen Interface

Two commands keep time-series and snapshot semantics explicit:

```text
bycli weixin user-growth --begin 2026-06-01 --end 2026-08-28 --source all
bycli weixin user-attributes --date 2026-08-28 --dimension all
```

Alternatives considered:

- One `user-analysis` command with a mode flag: fewer command names, but produces incompatible row shapes and makes discovery less clear.
- One command per attribute dimension: simple individual schemas, but creates unnecessary command proliferation.
- Two commands with a normalized attribute schema: selected because each command has one data model while all attribute dimensions remain queryable and composable.

## `user-growth`

The command requests `/misc/useranalysis` as authenticated JSON. Its arguments are:

- `--begin`: optional ISO date; defaults to 30 days before the latest available day.
- `--end`: optional ISO date; defaults to yesterday in the local calendar.
- `--source`: defaults to `all`; accepts the documented names below, a numeric source code, or a comma-separated list.

Supported names map to the current WeChat UI:

| Name | Code |
|---|---:|
| `all` | 99999999 |
| `search` | 1 |
| `qr` | 30 |
| `article` | 57 |
| `card` | 17 |
| `mini-program` | 149 |
| `reprint` | 161 |
| `ad` | 100 |
| `channels-live` | 201 |
| `channels` | 200 |
| `other` | 0 |

Rows use these columns:

```text
date, source, source_code, new_followers, unfollows,
net_new_followers, cumulative_followers
```

The adapter preserves sparse source-specific results instead of inventing zero rows. It sorts by date and then requested source order. The server currently clamps broad requests to 91 inclusive days; the command reports returned data without fabricating older rows.

## `user-attributes`

The command opens `/misc/useranalysis?action=attr` and extracts the server-rendered `window.cgiData.list[0]` snapshot. Its arguments are:

- `--date`: optional ISO date, defaulting to yesterday.
- `--dimension`: defaults to `all`; accepts `gender`, `age`, `language`, `region`, `platform`, or `brand`.

Rows use one normalized schema:

```text
date, dimension, name, code, parent_code, count, percent
```

Dimension mapping:

- `gender`: `genders[]`
- `age`: `ages[]`
- `language`: `langs[]`
- `region`: raw `regions[]`, retaining province, city, overseas, and unknown-region identifiers
- `platform`: `platforms[]`
- `brand`: `devices[]`; this data exists in the payload even though the current UI hides the brand panel

`percent` is normalized to a numeric percentage. For rows where WeChat does not supply it, the adapter derives it from the correct dimension total. Raw region rows do not have a single unambiguous denominator across province/city hierarchy, so their percentage remains `null`; consumers can aggregate by `parent_code` if needed.

Accounts with fewer than 100 followers legitimately have no attribute snapshot. The command raises an empty-result error explaining WeChat’s threshold rather than returning a sentinel row.

## Architecture

- `clis/weixin/user-growth.js` and `clis/weixin/user-attributes.js` register the commands and map normalized data to CLI columns.
- `clis/weixin/_wechat/user-analysis.js` owns date/source validation, URL construction, growth response normalization, and attribute snapshot normalization.
- Growth uses authenticated same-origin `fetch` inside the browser page so fingerprint and cookies remain browser-managed.
- Attributes navigate to the token-scoped HTML page and read `window.cgiData`, avoiding brittle DOM scraping.
- Both commands reuse `resolveBrowserCredentials` and are read-only browser commands.

## Errors and Privacy

- Invalid dates, reversed ranges, unknown dimensions, and unknown source names produce `ArgumentError`.
- Authentication continues to use the existing typed errors from `resolveBrowserCredentials`.
- Non-zero WeChat response codes and malformed payloads produce `CommandExecutionError`.
- Empty successful datasets produce `EmptyResultError` with a targeted explanation.
- Tokens, cookies, fingerprint values, account identifiers, and raw private payloads are never written to repository fixtures or logs.

## Testing and Verification

- Pure unit tests cover source parsing, date validation, URL construction, sparse multi-source normalization, percentage normalization, region identifiers, and malformed/empty payloads.
- Command tests verify registry metadata, navigation/fetch behavior, column order, and snake_case output.
- Manifest and documentation tests verify both commands are bundled and documented.
- Final verification runs focused adapter tests, the relevant documentation/manifest tests, a production build, and live commands against the current logged-in WeChat account with redacted output inspection.

