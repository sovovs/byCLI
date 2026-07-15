# WeChat (微信公众号)

**Mode**: 🌐 / 🔐 Browser · **Domains**: `weixin.sogou.com`, `mp.weixin.qq.com`

The built-in `weixin` adapter has two distinct search paths:

- `weixin search` searches **articles** through Sogou Weixin. It does not return a public-account `fakeid`.
- `weixin accounts` searches the logged-in WeChat Official Accounts backend and returns public accounts plus their `fakeid`. Use that `fakeid` with `articles` or `save-articles`.

## Commands

| Command | Description |
|---------|-------------|
| `bycli weixin search` | Search Sogou Weixin article results |
| `bycli weixin accounts` | Search backend public accounts and obtain `fakeid` values |
| `bycli weixin articles` | List published articles for an explicit `fakeid` |
| `bycli weixin save-articles` | List and save published articles as Markdown |
| `bycli weixin download` | Download one WeChat article as Markdown |
| `bycli weixin drafts` | List drafts in the Official Accounts backend |
| `bycli weixin create-draft` | Create an Official Accounts draft |

## Search and history workflow

`accounts` and `articles` are intentionally separate: inspect all account matches, choose the correct `fakeid`, and then list its articles before saving them. A similar account name is never selected automatically.

```bash
# 1. Search Sogou article results (separate from the backend history workflow)
bycli weixin search "AI" --page 1 --limit 5

# 2. Search backend accounts; limit defaults to 10
bycli weixin accounts "前端之神" --limit 10 --auth-source browser -f json

# 3. Preview history for the selected fakeid
bycli weixin articles 'Mzg2NjY2NTcyNg==' \
  --name "前端之神" --limit 20 --max-pages 3 --auth-source browser -f json

# 4. Save the selected account's history; output defaults to ./weixin-articles
bycli weixin save-articles 'Mzg2NjY2NTcyNg==' \
  --name "前端之神" --output ./weixin-articles \
  --limit 20 --max-pages 3 --auth-source browser -f json
```

Command arguments and defaults:

| Command | Arguments |
|---------|-----------|
| `accounts` | required positional `<query>`; `--limit <positive integer>` (default `10`); `--auth-source browser\|env` (default `browser`) |
| `articles` | required positional `<fakeid>`; optional `--name <nickname>`, `--limit <positive integer>`, `--max-pages <positive integer>`; `--auth-source browser\|env` (default `browser`) |
| `save-articles` | required positional `<fakeid>`; optional `--name <nickname>`, `--limit <positive integer>`, `--max-pages <positive integer>`; `--output <directory>` (default `./weixin-articles`); `--auth-source browser\|env` (default `browser`) |

All commands also accept byCLI's common output option, such as `-f table|json|yaml|plain|md|csv`. `--name` is display metadata only; it does not choose or validate an account.

## Login and authentication

The default `--auth-source browser` mode connects through Browser Bridge and reuses Chrome's `mp.weixin.qq.com` session. If the session is not authenticated, byCLI opens the Official Accounts login page, brings it to the foreground, and waits up to 180 seconds for you to scan the QR code (扫码) and finish login. Already-authenticated runs do not deliberately steal focus. `accounts` additionally captures the session's `fingerprint` from a genuine backend account-search request.

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

## Output and partial failures

`accounts` columns are `nickname`, `fakeid`, and `alias`. Missing aliases are `null`.

`articles` columns are `title`, `author`, `digest`, `publishedAt`, and `url`. Missing optional values are `null`; an empty article list is reported explicitly rather than disguised as an authentication success.

`save-articles` columns are `title`, `status`, `stage`, `path`, `error`, and `url`. Successful rows have `status: "saved"`, an absolute Markdown `path`, and null `stage`/`error`. A per-article download or conversion failure produces `status: "failed"`, a `stage`, and a safe error message. This 部分失败 behavior preserves already-written files and continues with the remaining articles. Output-directory creation, permission, or write failures remain command-level errors.

## Existing article and draft commands

```bash
bycli weixin download --url "https://mp.weixin.qq.com/s/xxx" --output ./weixin
bycli weixin download --url "https://mp.weixin.qq.com/s/xxx" --download-images
bycli weixin drafts --limit 5
bycli weixin create-draft --title "周报" --author "byCLI" --summary "本周更新摘要" "这里是正文内容"
```

`download` writes Markdown and, by default, local images below the selected output directory. `create-draft --cover-image` requires Browser Bridge file-upload support.
