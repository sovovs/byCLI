# Integrate `@sovovs/wechat-article-crawler` into byCLI

## Context

byCLI currently ships `weixin accounts`, `weixin articles`, and `weixin save-articles` as built-in commands. The latter two commands use article-history, pagination, and saving code that was previously migrated from `@sovovs/wechat-article-crawler` into the byCLI repository. This creates two independently maintained implementations.

The crawler package is currently version `1.0.0`. It publishes a CommonJS CLI binary but does not expose a documented package root or stable programmatic API. byCLI must not depend on private `src/*` paths or pass browser credentials through a child-process command line.

## Goals

- Publish `@sovovs/wechat-article-crawler@1.1.0` with a stable public API.
- Make byCLI depend directly on that public API.
- Preserve the current `weixin accounts`, `weixin articles`, and `weixin save-articles` command contracts.
- Preserve byCLI's browser authentication, environment authentication, typed errors, Browser Bridge fallback, output columns, and partial-failure behavior.
- Remove duplicated article API, pagination, and secure-saving implementations from byCLI.
- Keep the crawler independent of byCLI.

## Non-goals

- Do not make the crawler depend on `@sovovs/bycli` or Browser Bridge.
- Do not replace the existing byCLI commands with a spawned `wechat-crawler` process.
- Do not pass tokens or cookies through argv, stdout, progress messages, or error details.
- Do not change crawler CLI arguments or its JSON envelope.
- Do not publish a new byCLI package version as part of this work.
- Do not move account search or fingerprint capture into the crawler.

## Architecture

### Crawler package

The crawler remains CommonJS for backward compatibility. It gains a package root entry and explicit `exports`, allowing consumers to import the supported API without reaching into `src/*`.

The public API exposes:

- `createWechatApi(options)`: creates the authenticated article-history transport and parses WeChat responses.
- `collectArticles(options)`: applies bounded pagination, URL validation, deduplication, limits, and progress reporting.
- `saveArticles(options)`: coordinates article download, injected Markdown conversion, collision-safe filenames, and secure file writes.
- `CrawlerError`: reports stable, non-secret error codes and safe messages.

Implementation helpers may remain private. Public functions are re-exported from one root entry so byCLI depends only on the declared package contract.

The crawler owns no browser or byCLI concepts. It accepts callbacks such as `fetchArticleHtml`, `buildMarkdown`, and optional test doubles for transport and filesystem behavior. Its errors use crawler-owned codes rather than byCLI error classes.

### byCLI

byCLI retains:

- Browser and environment credential acquisition.
- `accounts` search and fingerprint capture.
- Browser Bridge article fallback after a failed direct Node download.
- WeChat HTML extraction and Markdown conversion.
- Secret redaction and typed-error presentation.
- Adapter registration, arguments, columns, and output projection.

byCLI adds a narrow adapter module that imports the crawler root API and maps `CrawlerError` codes to byCLI typed errors. Commands use the adapter rather than importing crawler internals.

After compatibility tests pass, byCLI removes its duplicated `_wechat/article-service.js`, `_wechat/wechat-api.js`, and `_wechat/save-service.js` implementations and their implementation-specific tests. Equivalent behavior remains covered by crawler unit tests and byCLI integration/contract tests.

## Public API contract

### Module format and exports

`@sovovs/wechat-article-crawler` continues to publish CommonJS. `package.json` adds `main` and `exports` for the root module. Existing `bin/wechat-crawler.js` remains unchanged from a user's perspective.

The root export is a plain object containing the supported functions and `CrawlerError`. byCLI imports only this root object. Private source paths are not part of the compatibility promise.

### Error model

`CrawlerError` contains:

- A stable `code` suitable for programmatic mapping.
- A safe user-facing `message` with no token, cookie, or request URL containing secrets.
- Optional safe structured details that never contain credentials.

The stable categories cover argument validation, authentication, remote protocol/HTTP failure, article download/conversion failure, and filesystem failure. Exact internal exceptions and raw WeChat payloads are not exposed.

byCLI maps those categories as follows:

| Crawler category | byCLI result |
| --- | --- |
| Invalid arguments | `ArgumentError` |
| Expired or rejected credentials | `AuthRequiredError` |
| Remote HTTP, response, or protocol failure | `CommandExecutionError` |
| Output-directory or write failure | `CommandExecutionError` |
| Per-article ordinary download/conversion failure | Existing failed output row |

An empty valid collection remains a byCLI `EmptyResultError`. Authentication-required failures from the injected Browser Bridge downloader propagate immediately rather than becoming partial-failure rows.

## Data flow

### `weixin articles`

1. byCLI validates command arguments and selects browser or environment authentication.
2. byCLI resolves credentials in memory.
3. The adapter creates the crawler WeChat API using those credentials.
4. `collectArticles` requests and validates bounded history pages.
5. byCLI maps public articles to the existing `title`, `author`, `digest`, `publishedAt`, and `url` columns.
6. A valid empty result is converted to the existing `EmptyResultError`.

### `weixin save-articles`

1. byCLI performs the same credential and history steps as `articles`.
2. byCLI creates an injected article downloader that tries Node fetch first.
3. In browser-auth mode only, the downloader falls back to the current Browser Bridge page when direct download fails.
4. byCLI injects its existing bounded WeChat HTML extractor and Markdown converter.
5. crawler `saveArticles` coordinates per-article work and securely writes Markdown files.
6. byCLI maps results to the existing `title`, `status`, `stage`, `path`, `error`, and `url` columns.

### `weixin accounts`

This command remains entirely within byCLI. The crawler has no account-search or fingerprint responsibilities.

## Security and reliability

- Tokens and cookies remain in memory and are never passed through subprocess argv.
- Neither crawler return values nor `CrawlerError` details contain credentials.
- HTTP errors do not include full authenticated request URLs or headers.
- Article URLs accept only trusted HTTPS `mp.weixin.qq.com/s` paths without credentials or custom ports.
- Pagination has hard page, page-size, and article-count limits and must always advance safely.
- Duplicate canonical article URLs are emitted once.
- Article HTML remains bounded before Markdown conversion.
- File targets remain inside the resolved output directory.
- Secure writes reject symbolic-link traversal, use exclusive creation, preserve collision suffixes, and detect output-root replacement.
- Ordinary per-article failures do not delete successful files or stop unrelated articles.
- Authentication/verification failures stop the operation immediately.

## Compatibility

The integration must not change:

- `weixin accounts`, `weixin articles`, or `weixin save-articles` names.
- Existing positional arguments, options, defaults, browser conditions, access modes, domains, or strategies.
- Existing output columns and null conventions.
- Browser login and focus behavior.
- Explicit `--auth-source env` behavior.
- Browser-only direct-download fallback.
- Partial-failure rows and command-level failure classification.
- The existing `wechat-crawler list/save` CLI contract and JSON envelope.

The byCLI dependency is `@sovovs/wechat-article-crawler` with a compatible `^1.1.0` range. Public API changes must follow semantic versioning.

## Testing

### Crawler tests

- Root API and package `exports` can be loaded from a packed installation.
- Existing CLI argument, output-envelope, progress, and exit-code tests continue to pass.
- Response parsing distinguishes authentication rejection from malformed and unknown remote failures.
- Pagination validates positive bounds, caps work, advances safely, filters untrusted URLs, and deduplicates canonical URLs.
- Save behavior covers download failures, converter failures, authentication propagation, duplicate filenames, exclusive races, symbolic links, root replacement, write failures, and the absolute article cap.
- Error messages and details never expose token or cookie fixtures.

### byCLI tests

- Adapter registration and all public command contracts remain unchanged.
- `articles` and `save-articles` use the crawler root API through injectable seams.
- Every crawler error category maps to the expected byCLI typed error.
- Browser authentication and environment authentication retain their current isolation.
- Environment mode does not connect to a browser.
- Browser mode retains Node-first download and Browser Bridge fallback.
- Partial failures, empty results, null fields, absolute paths, and output columns remain unchanged.
- Tests fail if byCLI imports crawler private `src/*` paths or retains duplicated service implementations.
- Typecheck, unit/adapter tests, build, manifest generation, documentation checks, and packed-install checks pass.

## Release sequence

1. Add failing crawler tests for the public API and hardened behavior.
2. Implement the crawler-owned error model, hardened services, root entry, and explicit exports.
3. Keep the old CLI as a compatibility adapter over the new public API.
4. Run the full crawler test suite and an `npm pack` clean-install smoke test.
5. Set the crawler version to `1.1.0`, inspect the tarball, and publish with public access.
6. Verify `@sovovs/wechat-article-crawler@1.1.0` and its root API from the npm registry.
7. Add `^1.1.0` to byCLI and implement the crawler-to-byCLI error adapter.
8. Switch `articles` and `save-articles` to the public API, then remove duplicated byCLI modules.
9. Run the full byCLI verification suite and packed-install smoke test.
10. Commit the byCLI integration without publishing a byCLI release.

## Acceptance criteria

- A clean install can load the crawler public API from the package root.
- The published crawler CLI remains backward compatible.
- `bycli weixin articles` and `bycli weixin save-articles` directly execute crawler public APIs without a subprocess.
- byCLI browser login and Browser Bridge fallback work as before.
- Existing byCLI command contracts and output are unchanged.
- No credential is present in logs, returned errors, output rows, fixtures, or subprocess arguments.
- crawler contains no byCLI dependency or Browser Bridge knowledge.
- byCLI contains no crawler private-path import and no duplicate article API, pagination, or secure-saving implementation.
- Both repositories pass their complete relevant verification suites.
