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
| `bycli weixin collections` | List content collections owned by the logged-in official account |
| `bycli weixin collection-detail` | Show one collection's settings and ordered content items |
| `bycli weixin download-publish-data` | Save one published article's content analysis as Markdown |
| `bycli weixin download` | Download one WeChat article as Markdown |
| `bycli weixin drafts` | List drafts in the Official Accounts backend |
| `bycli weixin create-draft` | Create an Official Accounts draft |

## Search and history workflow

`sougousearch` is a public Sogou Weixin article search and does not require a WeChat Official Accounts login. It returns article titles, public-account names (`account`), result links, snippets, and the time text shown by Sogou. Use `download` with an `mp.weixin.qq.com` result URL when you need Markdown content.

```bash
bycli weixin sougousearch "AI" --page 1 --limit 5 -f json
bycli weixin download --url "https://mp.weixin.qq.com/s/xxx" --output ./weixin
```

Sogou may require a browser verification. Complete it in Chrome and retry; byCLI does not bypass verification or rate limits.

`accounts` and `articles` are intentionally separate: inspect all account matches, choose the correct `fakeid`, and then list its articles before saving them. A similar account name is never selected automatically.

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

All commands also accept byCLI's common output option, such as `-f table|json|yaml|plain|md|csv`. `--name` is display metadata only; it does not choose or validate an account.

## Login and authentication

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

`collections` and `collection-detail` always use the current Browser Bridge session and do not accept environment credentials. WeChat may return HTTP 200 even when that session has expired; byCLI detects the response body and reports `AUTH_REQUIRED`. The request URL must include the temporary token, but byCLI does not copy it into the Referer, output, errors, or committed artifacts, and redacts it from diagnostics.

## Output and partial failures

`accounts` columns are `nickname`, `fakeid`, and `alias`. Missing aliases are `null`.

`articles` columns are `title`, `author`, `digest`, `publishedAt`, and `url`. Missing optional values are `null`; an empty article list is reported explicitly rather than disguised as an authentication success.

`save-articles` columns are `title`, `status`, `stage`, `path`, `error`, and `url`. Successful rows have `status: "saved"`, an absolute Markdown `path`, and null `stage`/`error`. A per-article download or conversion failure produces `status: "failed"`, a `stage`, and a safe error message. This 部分失败 behavior preserves already-written files and continues with the remaining articles. Output-directory creation, permission, or write failures remain command-level errors.

`collections` columns are `collectionId`, `title`, `collectionType`, `itemCount`, `views`, `continuousRead`, `isUpdating`, `isBanned`, `isPaid`, `createdAt`, `updatedAt`, and `coverUrl`.

`collection-detail` returns exactly one row with columns `collectionId`, `title`, `description`, `collectionType`, `coverUrl`, `itemCount`, `createdAt`, `updatedAt`, `settingsJson`, and `itemsJson`. The last two fields are compact JSON strings that can be decoded with `JSON.parse`; this preserves nested business data, including collection settings and ordered content items, while complying with byCLI's row-shape validator.

`download-publish-data` no longer downloads an XLS export. It opens the authenticated content-analysis page and saves a Markdown report under `--output` (default `./weixin-publish-data`). Successful rows return `title`, `publishedAt`, `url`, `status: "saved"`, `markdownPath`, `size`, and `error: null`; a page-analysis failure returns `status: "failed"` with a safe error message and no report path.

In browser authentication mode, `save-articles` tries a direct Node download first and automatically falls back to loading the article through the current Browser Bridge page when WeChat redirects direct traffic to a verification page. Environment authentication remains Node-only so CI and browserless use do not launch Chrome implicitly.

## Existing article and draft commands

```bash
bycli weixin download --url "https://mp.weixin.qq.com/s/xxx" --output ./weixin
bycli weixin download --url "https://mp.weixin.qq.com/s/xxx" --download-images
bycli weixin drafts --limit 5
bycli weixin create-draft --title "周报" --author "byCLI" --summary "本周更新摘要" "这里是正文内容"
```

`download` writes Markdown and, by default, local images below the selected output directory. `create-draft --cover-image` requires Browser Bridge file-upload support.
