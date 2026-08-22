# Remaining Search Adapters Design

## Goal

Add search commands for every platform identified as missing in the current bycli adapter inventory:

- General search: Baidu, Bing, Yandex, 360 Search, Sogou
- Social/realtime: Threads
- Developer/content communities: GitLab, CSDN, 52pojie (吾爱破解)

Each adapter should expose as many useful platform-native input and output fields as can be supported reliably, while preserving a predictable common result shape.

## Scope and naming

The existing `clis/<site>/<command>.js` convention remains unchanged. New site names are:

| Platform | bycli site name |
| --- | --- |
| Baidu | `baidu` |
| Bing | `bing` |
| Yandex | `yandex` |
| 360 Search | `so` |
| Sogou | `sogou` |
| Threads | `threads` |
| GitLab | `gitlab` |
| CSDN | `csdn` |
| 吾爱破解 | `52pojie` |

The existing `baidu-scholar` adapter is not changed and is not treated as general Baidu search.

## Architecture

Use a hybrid acquisition strategy:

1. Prefer a public HTTP/API endpoint when the endpoint is accessible without a private token and returns stable structured data.
2. Use browser navigation and DOM extraction for sites whose public endpoint is unavailable, unstable, or protected by browser-only behavior.
3. Keep extraction and normalization site-local. Shared helpers may be added only for repeated validation, pagination, error conversion, and common row shaping; do not create a generic scraper that hides platform differences.

Adapters must not silently claim support when a site returns a login page, CAPTCHA, blocked response, malformed payload, or empty result page. They should raise the project's existing typed errors with a useful recovery hint.

## Command interface

Every new adapter provides a `search` command with a required positional `keyword` and the following common options when meaningful for that platform:

- `--limit`: maximum returned rows, bounded by a platform-specific safe maximum
- `--page` or `--offset`: pagination control when supported
- `--sort`: platform-specific sort choices, exposed as readable names
- `--time`: date/time filter when supported
- `--lang`: language preference when supported
- `--region`: market, country, or region when supported
- `--type`: result-type filter when supported
- `--safe`: safe-search or content-filter mode when supported

Platform-native options are added where they map to a documented or observed platform control:

- Baidu: `--site`, `--filetype`, `--platform`
- Bing: `--freshness`, `--market`, `--answer`
- Yandex: `--lr`, `--lang`
- 360 Search: `--type`, `--safe`
- Sogou: `--type`, `--time`, `--sort`
- Threads: `--author`, `--since`, `--until`
- GitLab: `--scope`, `--order-by`, `--sort`
- CSDN: `--content-type`, `--sort`
- 52pojie: `--section`, `--sort`

Only options that are actually accepted and applied by an adapter are declared in its `args`; unsupported combinations must fail validation instead of being ignored.

## Output contract

Search rows use a common superset where the platform exposes the value:

```text
rank
title
url
snippet
displayUrl
source
resultType
author
publishedAt
score
extra
```

The `extra` field is a shallow object for platform-specific fields that would otherwise be dropped, such as repository namespace, issue state, forum author level, answer count, or search-engine metadata. Rows must remain serializable and comply with the project's column-shape validation rules.

Adapters should omit unavailable values as `null` or an empty string according to existing project conventions; they must not fabricate metadata.

## Platform acquisition and normalization

### General search engines

- Baidu, Bing, Yandex, 360 Search, and Sogou should first use their public search pages or publicly callable search endpoints.
- URL parameters must be encoded through `URL`/`URLSearchParams` rather than string concatenation where practical.
- Search-engine result extraction must deduplicate URLs, skip navigational/internal links, preserve result order, and identify ads or special result types where detectable.
- CAPTCHA, consent pages, or anti-bot pages must produce a typed execution error with a browser/login/retry hint rather than an empty successful response.

### Threads

- Prefer the public search/explore surface available to the logged-in browser session.
- Preserve author and timestamp when present.
- If Threads requires authentication for the requested search path, return `AuthRequiredError` or the project's equivalent typed error.

### GitLab

- Support public project/code/issue/merge-request search scopes where the public GitLab search surface exposes them.
- Map native ordering and direction to `--order-by` and `--sort`.
- Preserve project path, object type, author, and timestamps in the common fields or `extra`.

### CSDN

- Support public article/search result pages.
- Preserve article author, publication time, content type, and engagement metadata when available.
- Detect login/verification pages and report them as execution/auth errors.

### 52pojie

- Support publicly visible forum search pages.
- Expose section and ordering controls only where the site accepts them.
- Preserve thread author, reply/view counts, forum section, and last-update time in `extra` when available.

## Error handling

Each adapter must validate inputs before network/browser work:

- reject blank keywords;
- reject non-positive or excessive limits;
- reject invalid enum values for sort, type, region, or other choices;
- reject invalid pagination values.

Network failures, non-OK responses, malformed payloads, login requirements, CAPTCHA/anti-bot pages, and empty result sets must use existing bycli error types and include the platform and next action in the message.

## Testing strategy

Tests follow the repository's adapter patterns and TDD:

1. Registration tests verify site, command name, access, strategy, browser mode, argument declarations, columns, and domain.
2. Pure helper tests cover URL construction, option mapping, pagination, URL decoding, result normalization, deduplication, and error-page detection.
3. Fixture-based extraction tests cover representative success pages, empty pages, special result types, malformed responses, and blocked/login pages.
4. The existing full test suite and build/convention checks must pass after each batch.

External requests should not be required for unit tests. Browser adapters should use the repository's existing page mocks and fixture conventions.

## Delivery order

Implement and verify in three batches:

1. Baidu, Bing, Yandex, 360 Search, Sogou
2. GitLab, CSDN
3. Threads, 52pojie

Each batch must leave registered commands, tests, and help/completion metadata in a working state. Documentation should include command examples and note platform-specific authentication or anti-bot limitations.

## Non-goals

- Do not change existing adapters unless a shared helper change is required for compatibility.
- Do not promise authenticated/private search capabilities that the platform does not expose through the available browser session.
- Do not add a universal catch-all `--raw-param` option that bypasses validation.
