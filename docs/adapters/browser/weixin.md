# WeChat (微信公众号)

**Mode**: 🌐 / 🔐 Browser · **Domains**: `weixin.sogou.com`, `mp.weixin.qq.com`

`weixin accounts` searches the logged-in WeChat Official Accounts backend and returns public accounts plus their `fakeid`. Use that `fakeid` with `articles` or `save-articles`.

## Commands

| Command | Description |
|---------|-------------|
| `bycli weixin sougousearch` | Search public-account articles through Sogou Weixin |
| `bycli weixin accounts` | Search backend public accounts and obtain `fakeid` values |
| `bycli weixin articles` | List published articles for an explicit `fakeid` |
| `bycli weixin save-articles` | List and save published articles as Markdown |
| `bycli weixin freepublish-list` | List published articles through the official API |
| `bycli weixin freepublish-get` | Get one published article by `article_id` through the official API |
| `bycli weixin published-articles` | List through the official API with controlled browser fallback |
| `bycli weixin article-fetch` | Fetch one article through the API or a supplied public URL |
| `bycli weixin collections` | List content collections owned by the logged-in official account |
| `bycli weixin collection-detail` | Show one collection's settings and ordered content items |
| `bycli weixin user-growth` | Read follower growth by date and acquisition source |
| `bycli weixin user-attributes` | Read demographic, region, platform, and device-brand snapshots |
| `bycli weixin download-publish-data` | Save one published article's content analysis as Markdown |
| `bycli weixin download` | Download one WeChat article as Markdown |
| `bycli weixin drafts` | List drafts in the Official Accounts backend |
| `bycli weixin create-draft` | Create an Official Accounts draft |
| `bycli weixin create-newspic` | Create an API-only image-post draft with 1–20 images |

## Search and history workflow

`sougousearch` is a public Sogou Weixin article search and does not require a WeChat Official Accounts login. It returns article titles, public-account names (`account`), result links, snippets, and the time text shown by Sogou. Use `download` with an `mp.weixin.qq.com` result URL when you need Markdown content.

```bash
bycli weixin sougousearch "AI" --page 1 --limit 5 -f json
bycli weixin download --url "https://mp.weixin.qq.com/s/xxx" --output ./weixin
```

Sogou may require a browser verification. Complete it in Chrome and retry; byCLI does not bypass verification or rate limits.

`accounts` and `articles` are intentionally separate: inspect all account matches, choose the correct `fakeid`, and then list its articles before saving them. A similar account name is never selected automatically.

With browser authentication and a non-empty `--name`, `articles` and `save-articles` automatically use a bounded Sogou Weixin fallback only when the authenticated article index returns `COMMAND_EXEC` or `EMPTY_RESULT`. Authentication, login, CAPTCHA, environment-verification, argument, interruption, and unknown failures never trigger it. Environment authentication remains browserless and never switches to Sogou.

Fallback matching trims the displayed Sogou account name and compares it to `--name` case-insensitively; substring, alias, punctuation, and fuzzy matches are excluded. The scan is sequential, defaults to at most 50 Sogou pages, and reuses an explicit `--max-pages`. It collects the full bounded result set, deduplicates and sorts it newest first, and only then applies `--limit`. Sogou coverage is not guaranteed to equal the official account's complete publishing history.

```bash
# 1. Search backend accounts; limit defaults to 10
bycli weixin accounts "前端之神" --limit 10 --auth-source browser -f json

# 2. Preview history for the selected fakeid
bycli weixin articles 'Mzg2NjY2NTcyNg==' \
  --name "前端之神" --limit 20 --max-pages 3 --auth-source browser -f json

# 3. Save the selected account's history; output defaults to ./weixin-articles
bycli weixin save-articles 'Mzg2NjY2NTcyNg==' \
  --name "前端之神" --output ./weixin-articles \
  --limit 20 --max-pages 3 --auth-source browser -f json
```

## Collection workflow

`collections` and `collection-detail` are read-only, browser-session-only commands. List the account's collections first, copy a returned `collectionId`, and pass that ID to the detail command:

```bash
bycli weixin collections --limit 20 --max-pages 5 -f json
bycli weixin collection-detail '<collectionId>' --max-pages 5 -f json
```

The list response exposes the readable `collectionType`, but the detail endpoint requires WeChat's numeric type. `collection-detail` resolves that type internally by scanning the collection list for the exact `collectionId`; callers do not need to supply it.

## Official published-article API

`freepublish-list` and `freepublish-get` call the official `api.weixin.qq.com/cgi-bin/freepublish` API and never open a browser. Configure `WECHAT_APPID` and `WECHAT_APPSECRET`, or provide a managed `WECHAT_ACCESS_TOKEN`. Command arguments `--appid`, `--appsecret`, and `--access-token` override their environment counterparts, but environment variables keep secrets out of shell history.

```bash
WECHAT_APPID='wx123' WECHAT_APPSECRET='secret' \
  bycli weixin freepublish-list --offset 0 --count 20 --content none -f table

bycli weixin freepublish-list --count 20 --content inline -f json
bycli weixin freepublish-list --count 20 --content file --output ./weixin-published -f json
bycli weixin freepublish-get '<articleId>' --content inline -f json
```

The account must have the corresponding official API capability and the caller may need to be in the configured IP allowlist. `--content none` sends `no_content=1`; `--content inline` returns `content_html`; `--content file` writes non-overwriting HTML and JSON artifacts and returns their absolute paths in `artifact_paths_json`. The common `-f table|json|yaml|plain|md|csv` option controls serialization, independently from content handling.

`published-articles` and `article-fetch` add an explicit `--source auto|api|browser` facade. In `auto`, missing official credentials produces `fallback_reason: "api-not-configured"`; an explicit API capability error produces `fallback_reason: "api-not-authorized"`. Invalid credentials, transport errors, malformed responses, and rate limiting do not silently fall back. `article-fetch` requires a trusted public `mp.weixin.qq.com` URL before it can use browser fallback because an `article_id` alone cannot be converted into a public URL.

```bash
bycli weixin published-articles --source auto --limit 20 -f json
bycli weixin article-fetch --article-id '<articleId>' \
  --url 'https://mp.weixin.qq.com/s/xxx' --source auto \
  --content file --output ./weixin-published -f json
```

## User analysis workflow

`user-growth` and `user-attributes` reuse the current logged-in Official Account browser session. Both are read-only against WeChat; `user-growth` can optionally write an official workbook to the local filesystem. They correspond to the **用户增长** and **用户属性** tabs under 用户分析.

```bash
bycli weixin user-growth --begin 2026-08-01 --end 2026-08-28 --source all -f json
bycli weixin user-growth --begin 2026-08-01 --end 2026-08-28 --source all-sources --output ./weixin-user-growth -f json
bycli weixin user-attributes --date 2026-08-28 --dimension all -f json
```

Growth defaults to the 30 calendar days ending yesterday. `--source all` returns only WeChat's aggregate source (`99999999`). `--source all-sources` returns that aggregate followed by every available channel. Explicit selection still accepts one or more comma-separated names or numeric source codes: `search`, `qr`, `article`, `card`, `mini-program`, `reprint`, `ad`, `channels-live`, `channels`, and `other`. WeChat currently limits one response to at most 91 inclusive days; request smaller windows when exporting longer history.

Growth rows contain `date`, `source`, `source_code`, `new_followers`, `unfollows`, `net_new_followers`, `cumulative_followers`, `official_xls_path`, and `official_xls_size`. When several sources are requested, sparse source/date combinations are preserved as returned rather than filled with invented zeroes.

The official XLS is downloaded only when `--output` is provided. It is always the single aggregate “全部来源” workbook shown by WeChat's 下载表格 action, even when the row output uses `all-sources` or another channel. Without `--output`, both artifact fields are `null` and no file is written. A successful download repeats the validated absolute path and byte size on every row. The filename is `weixin-user-growth-<begin>-<end>-all.xls`; an existing file is preserved and the new name receives a numeric suffix.

Attribute `--dimension` accepts `all`, `gender`, `age`, `language`, `region`, `platform`, or `brand`; the default date is yesterday. Rows contain `date`, `dimension`, `name`, `code`, `parent_code`, `count`, and `percent`. Region rows retain WeChat's hierarchical IDs in `code` and `parent_code`, and their `percent` is `null` because the hierarchy has no single valid denominator. Percentages for other dimensions are derived from that dimension's counts.

WeChat only publishes user-attribute data on the day after an account reaches 100 followers. Accounts below that threshold receive an explicit empty-result message. The current page can also hide device-brand charts; `brand` is still requested from the embedded snapshot when WeChat supplies it, so an empty brand result is possible. Blank platform and brand labels are returned as `未知`.

### Implementation boundary

`articles` history retrieval and `save-articles` saving use the published `@sovovs/wechat-article-crawler` public root API (`createWechatApi`, `collectArticles`, `saveArticles`). The adapter imports only that root entry—never private `src/*`/`bin/*` paths—and never starts a `wechat-crawler` subprocess.

Credential acquisition, Browser Bridge login/focus, account search and fingerprint capture remain byCLI responsibilities. byCLI also supplies the browser fallback downloader, Markdown metadata, typed errors and output projection.

Article saving requires `@sovovs/wechat-article-crawler` 1.1.3 or newer. Its secure-save implementation supports Linux and macOS; byCLI pins that minimum version so `save-articles` can write through the real Node filesystem on both platforms.

Command arguments and defaults:

| Command | Arguments |
|---------|-----------|
| `accounts` | required positional `<query>`; `--limit <positive integer>` (default `10`); `--auth-source browser\|env` (default `browser`) |
| `articles` | required positional `<fakeid>`; optional `--name <nickname>`, `--limit <positive integer>`, `--max-pages <positive integer>`; `--auth-source browser\|env` (default `browser`) |
| `save-articles` | required positional `<fakeid>`; optional `--name <nickname>`, `--limit <positive integer>`, `--max-pages <positive integer>`; `--output <directory>` (default `./weixin-articles`); `--auth-source browser\|env` (default `browser`) |
| `collections` | `--limit <positive integer>` (default `20`); `--max-pages <positive integer>` (default `5`) |
| `collection-detail` | required positional `<collectionId>`; `--max-pages <positive integer>` (default `5`) |
| `user-growth` | optional `--begin YYYY-MM-DD`, `--end YYYY-MM-DD`, `--source` (default `all`; use `all-sources` for aggregate plus all channels), and `--output <directory>` to download the aggregate XLS |
| `user-attributes` | optional `--date YYYY-MM-DD`; `--dimension all\|gender\|age\|language\|region\|platform\|brand` (default `all`) |

All commands also accept byCLI's common output option, such as `-f table|json|yaml|plain|md|csv`. On the authenticated primary path, `--name` remains display metadata. At an eligible browser fallback boundary it becomes mandatory and is the exact account-name filter; it never changes or invents the selected `fakeid`.

## Login and authentication

### 微信开放平台第三方平台账号资料

`weixin open-platform-authorizer-info` 是独立于公众号后台登录状态的只读命令。它先使用第三方平台
凭据和微信最近推送的 `component_verify_ticket` 换取 `component_access_token`，再调用
`api_get_authorizer_info` 返回授权公众号的 `appid`、`nickname`、`username`（`gh_` 原始 ID）和
`principal_name`。

```bash
WECHAT_COMPONENT_APPID='...' \
WECHAT_COMPONENT_APPSECRET='...' \
WECHAT_COMPONENT_VERIFY_TICKET='...' \
  bycli weixin open-platform-authorizer-info 'wx-authorizer-appid' -f json
```

`component_verify_ticket` 不能由 AppID/AppSecret 主动获取；微信会定时推送到第三方平台配置的授权事件
接收 URL，调用方必须提供最近一次已验证的 ticket。不要把 AppSecret、ticket 或返回的 access token
写入命令历史、日志、测试夹具或仓库文件。该命令不读取浏览器 Cookie，也不会回退到
`mp.weixin.qq.com`。

The default `--auth-source browser` mode connects through Browser Bridge and reuses Chrome's `mp.weixin.qq.com` session. If the session is not authenticated, byCLI opens the Official Accounts login page, brings it to the foreground, and waits up to 180 seconds for you to scan the QR code (扫码) and finish login. Already-authenticated runs do not deliberately steal focus.

For `accounts`, byCLI opens the editor's **账号名片** picker, enters the query in the **插入账号名片** dialog, and captures only the `fingerprint` value from the resulting backend search request. It does not select a result, click **插入**, save the draft, or persist credentials. If the picker cannot be opened automatically after the editor has had time to render, byCLI brings the window to the foreground and waits for you to open the **插入账号名片** dialog manually; once the dialog appears, the command fills the query and continues automatically.

For automation, explicitly select environment authentication:

```bash
# accounts requires all three values
WECHAT_TOKEN='...' WECHAT_COOKIE='...' WECHAT_FINGERPRINT='...' \
  bycli weixin accounts "前端之神" --auth-source env -f json

# articles and save-articles require token and cookie
WECHAT_TOKEN='...' WECHAT_COOKIE='...' \
  bycli weixin articles 'Mzg2NjY2NTcyNg==' --auth-source env -f json
```

Environment credentials are all-or-nothing and are never mixed with a browser session. Browser mode requires Chrome plus the [Browser Bridge extension](/guide/browser-bridge); env mode does not connect to Chrome.

Tokens, cookies, and fingerprints are temporary credentials. They are kept in command memory only and are redacted from errors, logs, traces, and output. Do not put them in shell history, committed files, fixtures, or shared logs. When credentials expire, the command reports an authentication error: log in again in browser mode or replace the complete environment-variable set. byCLI does not persist, refresh, or bypass expired credentials or WeChat risk controls.

`collections`, `collection-detail`, `user-growth`, and `user-attributes` always use the current Browser Bridge session and do not accept environment credentials. WeChat may return HTTP 200 even when that session has expired; byCLI detects the response body and reports `AUTH_REQUIRED`. The request URL must include the temporary token, but byCLI does not copy it into the Referer, output, errors, or committed artifacts, and redacts it from diagnostics.

## Output and partial failures

`accounts` columns are `nickname`, `fakeid`, and `alias`. Missing aliases are `null`.

`articles` columns are `title`, `author`, `digest`, `publishedAt`, `url`, `source`, and `coverage`. Missing optional values are `null`; an empty article list is reported explicitly rather than disguised as an authentication success. Primary rows use `source: "wechat"` and `coverage: null`. Fallback rows use `source: "sogou"` and `coverage: "search-exhausted"` or `"max-pages-reached"`. The fallback index is atomic: any selected link that cannot resolve to a trusted WeChat article URL fails the command instead of silently truncating the index.

`save-articles` columns are `title`, `status`, `stage`, `path`, `error`, `url`, `source`, and `coverage`. Successful rows have `status: "saved"`, an absolute Markdown `path`, and null `stage`/`error`. A per-article resolution, download, or conversion failure produces `status: "failed"`, a `stage`, and a safe error message. This 部分失败 behavior preserves already-written files and continues with the remaining articles. Authentication and verification errors remain command-level stops. Output-directory creation, permission, or write failures also remain command-level errors.

`collections` columns are `collectionId`, `title`, `collectionType`, `itemCount`, `views`, `continuousRead`, `isUpdating`, `isBanned`, `isPaid`, `createdAt`, `updatedAt`, and `coverUrl`.

`collection-detail` returns exactly one row with columns `collectionId`, `title`, `description`, `collectionType`, `coverUrl`, `itemCount`, `createdAt`, `updatedAt`, `settingsJson`, and `itemsJson`. The last two fields are compact JSON strings that can be decoded with `JSON.parse`; this preserves nested business data, including collection settings and ordered content items, while complying with byCLI's row-shape validator.

`download-publish-data` saves both the matched article's XLS data export and a Markdown content-analysis report under `--output` (default `./weixin-publish-data`). A `downloaded` row means both artifacts passed validation, `partial` preserves the one validated artifact and the other error, and `failed` means neither artifact passed. All three are terminal outcomes.

`download` and `download-publish-data` support opt-in named Adapter sessions.
Pass `--site-session persistent --keep-tab true --adapter-session worker-a` to
bind one command stream to its own Adapter-managed tab. Up to three different
session names may run in one browser profile/site pool; the fourth command
waits until a running command releases its daemon lease. Reusing the same name
always remains serial. Give every concurrent invocation its own output
directory. The runtime also serializes the same article and the same normalized
output directory, validates successful Markdown and local image artifacts, and
does not expose raw article URLs or output paths in scheduler diagnostics.
Named sessions share the Chrome profile's cookies, login account, and
rate-limit state.

In browser authentication mode, `save-articles` tries a direct Node download first and automatically falls back to loading the article through the current Browser Bridge page when WeChat redirects direct traffic to a verification page. Environment authentication remains Node-only so CI and browserless use do not launch Chrome implicitly.

## Existing article and draft commands

```bash
bycli weixin download --url "https://mp.weixin.qq.com/s/xxx" --output ./weixin
bycli weixin download --url "https://mp.weixin.qq.com/s/xxx" --download-images
bycli weixin drafts --limit 5
bycli weixin create-draft --title "周报" --author "byCLI" --summary "本周更新摘要" "这里是正文内容"
bycli weixin create-newspic \
  --title "周末随拍" \
  --images "./01.jpg,http://example.com/02.png" \
  --content "图片说明" \
  --appid "$APPID" \
  --appsecret "$APPSECRET"
```

`download` writes Markdown and, by default, local images below the selected output directory. `create-draft --cover-image` requires Browser Bridge file-upload support.

`create-newspic` does not open a browser and does not publish the result. It
uploads every input image as permanent Weixin image material, then creates a
draft with `article_type: "newspic"`. Local paths and HTTP(S) URLs can be mixed
in input order. Localhost and private-network URLs require
`--allow-private-image-hosts true`; cloud metadata addresses are always blocked.
If upload or draft creation fails, the command makes a best-effort attempt to
delete permanent materials uploaded by that invocation.
