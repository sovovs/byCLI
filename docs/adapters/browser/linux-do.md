# LINUX DO

**Mode**: 🔐 Browser · **Domain**: `linux.do`

## Commands

| Command | Description |
|---------|-------------|
| `bycli linux-do feed` | Browse topics (site-wide, by tag, or by category) |
| `bycli linux-do categories` | List all categories |
| `bycli linux-do tags` | List popular tags |
| `bycli linux-do search <query>` | Search topics |
| `bycli linux-do topic <id>` | View topic posts |
| `bycli linux-do topic-content <id>` | Read the main topic body as Markdown |
| `bycli linux-do user-topics <username>` | Topics created by a user |
| `bycli linux-do user-posts <username>` | Replies posted by a user |

## feed

Browse topic listings. Defaults to latest topics when called with no arguments.

- Supports filtering by `--tag`, `--category`, or both
- `--tag` accepts tag name, slug, or ID
- `--category` accepts category name, slug, ID, or `Parent / Child` path for sub-categories
- Use `--view` to switch between latest / hot / top

### Basic

```bash
# Latest topics (default)
bycli linux-do feed

# Hot topics
bycli linux-do feed --view hot

# Top topics — default period is weekly
bycli linux-do feed --view top
bycli linux-do feed --view top --period daily
bycli linux-do feed --view top --period monthly

# Sort by views descending
bycli linux-do feed --order views

# Sort by created time ascending
bycli linux-do feed --order created --ascending

# Limit results
bycli linux-do feed --limit 10

# JSON output
bycli linux-do feed -f json
```

### Filter by tag

```bash
# By tag name, slug, or ID — all equivalent
bycli linux-do feed --tag "ChatGPT"
bycli linux-do feed --tag chatgpt
bycli linux-do feed --tag 3

# Tag + hot view
bycli linux-do feed --tag "ChatGPT" --view hot

# Tag + top view with period
bycli linux-do feed --tag "OpenAI" --view top --period monthly
```

### Filter by category

Supports both top-level and sub-categories. Sub-categories auto-resolve their parent path.

```bash
# Top-level category — name, slug, or ID
bycli linux-do feed --category "开发调优"
bycli linux-do feed --category develop
bycli linux-do feed --category 4

# Sub-category
bycli linux-do feed --category "开发调优 / Lv1"
bycli linux-do feed --category "网盘资源"

# Category + hot / top view
bycli linux-do feed --category "开发调优" --view hot
bycli linux-do feed --category "开发调优" --view top --period weekly
```

### Category + tag

Combine `--category` and `--tag` to narrow results within a category.

```bash
bycli linux-do feed --category "开发调优" --tag "ChatGPT"
bycli linux-do feed --category "网盘资源" --tag "OpenAI"
bycli linux-do feed --category 94 --tag 4 --view top --period monthly
```

### Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `--view V` | `latest`, `hot`, `top` | `latest` |
| `--tag VALUE` | Tag name, slug, or ID | — |
| `--category VALUE` | Category name, slug, or ID | — |
| `--limit N` | Number of results | `20` |
| `--order O` | `default`, `created`, `activity`, `views`, `posts`, `category`, `likes`, `op_likes`, `posters` | `default` |
| `--ascending` | Sort ascending instead of descending | off |
| `--period P` | `all`, `daily`, `weekly`, `monthly`, `quarterly`, `yearly` (only with `--view top`) | `weekly` |

Output columns: `title`, `replies`, `created`, `likes`, `views`, `url`

## categories

List forum categories with optional sub-category expansion.

```bash
bycli linux-do categories
bycli linux-do categories --subcategories
bycli linux-do categories --limit 50
```

When `--subcategories` is enabled, sub-categories are rendered as `Parent / Child` so the `name` value can be copied directly into `bycli linux-do feed --category ...`.

Output columns: `name`, `slug`, `id`, `topics`, `description`

## tags

List tags sorted by usage count.

```bash
bycli linux-do tags
bycli linux-do tags --limit 50
```

Output columns: `rank`, `name`, `count`, `url`

## search

Search topics by keyword.

```bash
bycli linux-do search "NixOS"
bycli linux-do search "Docker" --limit 10
bycli linux-do search "Claude" -f json
```

Output columns: `rank`, `title`, `views`, `likes`, `replies`, `url`

## topic

View summarized first-page posts within a topic.

```bash
bycli linux-do topic 1234
bycli linux-do topic 1234 --limit 50
```

Notes:
- `content` is a plain-text summary extracted from each first-page post
- Each summary is truncated to 200 characters
- Use `bycli linux-do topic-content <id>` for the full main post body in Markdown

Output columns: `author`, `content`, `likes`, `created_at`

## topic-content

Read the main topic body as Markdown.

```bash
bycli linux-do topic-content 1234
bycli linux-do topic-content 1234 -f json
```

Notes:
- Default output prints the Markdown body directly for copy/paste or piping into LLMs
- Use `-f json` if you want a machine-readable wrapper

Output columns: `content`

## user-topics

List topics created by a user.

```bash
bycli linux-do user-topics neo
bycli linux-do user-topics neo --limit 10
```

Output columns: `rank`, `title`, `replies`, `created_at`, `likes`, `views`, `url`

## user-posts

List replies posted by a user.

```bash
bycli linux-do user-posts neo
bycli linux-do user-posts neo --limit 10
```

Output columns: `index`, `topic_user`, `topic`, `reply`, `time`, `url`

## Prerequisites

- Chrome running and **logged into** linux.do
- [Browser Bridge extension](/guide/browser-bridge) installed
