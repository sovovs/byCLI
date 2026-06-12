# Substack

**Mode**: 🌐 Public (search) / 🔐 Browser (feed, publication) · **Domain**: `substack.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli substack feed` | Substack 热门文章 Feed |
| `bycli substack search` | 搜索 Substack 文章和 Newsletter（无需浏览器） |
| `bycli substack publication` | 获取特定 Substack Newsletter 的最新文章 |

## Usage Examples

```bash
# 热门 Feed
bycli substack feed --limit 10

# 按分类浏览
bycli substack feed --category tech --limit 10

# 搜索文章（公开 API，无需浏览器）
bycli substack search "AI"

# 搜索 Newsletter
bycli substack search "technology" --type publications

# 查看特定 Newsletter 的最新文章
bycli substack publication "https://example.substack.com" --limit 10

# JSON output
bycli substack search "AI" -f json
```

## Prerequisites

- `search` command: No login required (public API)
- `feed`, `publication` commands: Chrome with `substack.com` accessible, Browser Bridge extension installed
