# Toutiao (今日头条)

**Mode**: 🌐 / 🔐

| Command | Mode | Domain | Description |
|---------|------|--------|-------------|
| `bycli toutiao articles` | 🔐 Browser | `mp.toutiao.com` | 头条号创作者后台文章列表及数据（需登录） |
| `bycli toutiao hot` | 🌐 Public | `www.toutiao.com` | 今日头条首页热榜（公开，无需登录） |
| `bycli toutiao search <query>` | 🌐 Public | `www.toutiao.com` | 今日头条公开站内搜索（无需登录） |

## Usage Examples

```bash
# Public hot board (no login)
bycli toutiao hot
bycli toutiao hot --limit 10
bycli toutiao hot -f json

# Public site search (no login)
bycli toutiao search "人工智能"
bycli toutiao search "人工智能" --type information
bycli toutiao search "人工智能" --type video
bycli toutiao search "人工智能" --limit 10
bycli toutiao search "人工智能" --limit 10 -f json

# Creator dashboard articles (logged-in)
bycli toutiao articles
bycli toutiao articles --page 2
bycli toutiao articles --page 1 -f json
```

## Output

### `hot`

| Column | Type | Notes |
|--------|------|-------|
| `rank` | int | 1-based, dense after empty-title rows are dropped |
| `group_id` | string \| null | Topic/cluster id (`ClusterIdStr`, falls back to numeric `ClusterId`) |
| `title` | string | Trending topic title |
| `query` | string | Search keyword (`QueryWord`); falls back to `title` if absent |
| `hot_value` | int \| null | `HotValue` parsed as non-negative number; `null` if missing |
| `label` | string \| null | Hot tag (e.g. 热 / 新 / 沸) when present |
| `url` | string \| null | Topic permalink |
| `image_url` | string \| null | First non-empty image URL (`Image.url` → `Image.url_list[*]`) |

### `articles`

`title` · `date` · `status` · `展现` · `阅读` · `点赞` · `评论`

If a row's stats span has not finished rendering by the time the page text is read, the row still surfaces with `null` stat columns instead of being silently dropped — this masking previously hid creator-backend slow-render bugs.
Login/captcha pages abort with `AuthRequiredError`; browser render failures abort with `CommandExecutionError`.

### `search`

| Column | Type | Notes |
|--------|------|-------|
| `rank` | int | 1-based result rank |
| `title` | string | Search result title |
| `url` | string | Result or article URL |
| `source` | string \| null | Publisher/source name |
| `publish_time` | string \| null | Published or displayed time from the result |
| `summary` | string \| null | Result abstract |
| `image_url` | string \| null | First available result image |
| `like_count` | int \| null | Like/digg count |
| `comment_count` | int \| null | Comment count |
| `share_count` | int \| null | Share/repost/forward count when provided |
| `read_count` | int \| null | Read count when provided |

The public search page is parsed without login. Optional fields that the upstream result does not provide are returned as `null` rather than dropping the result.

`--type` defaults to `synthesis` and accepts `synthesis`, `information`, `video`, `atlas`, `user`, `xiaoshipin`, `weitoutiao`, or `music`.

## Prerequisites

### `hot`
- No login required. Uses the public `hot-event/hot-board` endpoint that powers the homepage hot panel.

### `search`
- No login required. Searches the public Toutiao site search page.

### `articles`
- Chrome running and **logged into** `mp.toutiao.com`
- [Browser Bridge extension](/guide/browser-bridge) installed

## Notes

- `hot` `--limit` accepts integers in `[1, 50]`; out-of-range values raise an `ArgumentError` (no silent clamp).
- `articles` `--page` accepts integers in `[1, 4]`, matching the contributor's verified range on the creator dashboard; out-of-range values raise an `ArgumentError`.
- `search` `--limit` accepts integers in `[1, 50]`; the default is 20 and out-of-range values raise an `ArgumentError`.
