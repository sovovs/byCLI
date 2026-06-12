# HackerNews

**Mode**: 🌐 Public · **Domain**: `news.ycombinator.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli hackernews top` | Hacker News top stories |
| `bycli hackernews new` | Hacker News newest stories |
| `bycli hackernews best` | Hacker News best stories |
| `bycli hackernews ask` | Hacker News Ask HN posts |
| `bycli hackernews show` | Hacker News Show HN posts |
| `bycli hackernews jobs` | Hacker News job postings |
| `bycli hackernews search <query>` | Search Hacker News stories |
| `bycli hackernews user <username>` | Hacker News user profile |
| `bycli hackernews read <id>` | Read a story and its comment tree |

## Usage Examples

```bash
# Top stories
bycli hackernews top --limit 5

# Newest stories
bycli hackernews new --limit 10

# Search stories
bycli hackernews search "machine learning" --limit 5

# User profile
bycli hackernews user pg

# JSON output
bycli hackernews top -f json

# Sort search by date
bycli hackernews search "rust" --sort date

# Read a story and its top comments (id from any listing's `id` column)
bycli hackernews read 47999636 --limit 5 --depth 2
```

## Prerequisites

- No browser required — uses public API
