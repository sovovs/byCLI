# 即刻 (Jike)

**Mode**: 🔐 Browser · **Domain**: `web.okjike.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli jike feed` | 即刻首页动态流 |
| `bycli jike search` | 搜索即刻帖子 |
| `bycli jike post` | 帖子详情及评论 |
| `bycli jike topic` | 话题详情 |
| `bycli jike user` | 用户资料 |
| `bycli jike create` | 发布即刻动态 |
| `bycli jike comment` | 评论即刻帖子 |
| `bycli jike like` | 点赞即刻帖子 |
| `bycli jike repost` | 转发即刻帖子 |
| `bycli jike notifications` | 即刻通知 |

## Usage Examples

```bash
# View feed
bycli jike feed --limit 10

# Search posts
bycli jike search "AI" --limit 20

# View post details and comments
bycli jike post <post-id>

# Create a new post
bycli jike create --content "Hello Jike!"

# Like a post
bycli jike like <post-id>

# JSON output
bycli jike feed -f json
```

## Listing Columns

`feed`, `search`, and `user` expose `id` for each post row. Pass that value
directly to `bycli jike post <id>` for the detail view.

## Prerequisites

- Chrome running and **logged into** web.okjike.com
- [Browser Bridge extension](/guide/browser-bridge) installed
