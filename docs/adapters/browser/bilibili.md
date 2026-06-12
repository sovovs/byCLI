# Bilibili

**Mode**: 🔐 Browser · **Domain**: `bilibili.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli bilibili hot` | |
| `bycli bilibili search` | |
| `bycli bilibili me` | |
| `bycli bilibili favorite` | Read your first favorite folder, or a specific folder with `--fid` |
| `bycli bilibili history` | |
| `bycli bilibili feed` | Read the following feed, or a specific user's dynamics by uid/name |
| `bycli bilibili feed-detail` | Read one dynamic in detail, including exclusive content |
| `bycli bilibili subtitle` | |
| `bycli bilibili video` | Get one video's metadata (title, author, duration, stats) by BV / URL / b23.tv link |
| `bycli bilibili summary` | Get the official AI video summary and timestamped outline by BV / URL / b23.tv link |
| `bycli bilibili comments` | Read top-level comments, or read replies under a top-level comment with `--parent` |
| `bycli bilibili comment` | Post a top-level comment or reply under a top-level comment (requires `--execute`) |
| `bycli bilibili dynamic` | |
| `bycli bilibili ranking` | |
| `bycli bilibili following` | |
| `bycli bilibili user-videos` | |
| `bycli bilibili download` | |

## Usage Examples

```bash
# Quick start
bycli bilibili hot --limit 5

# Search videos
bycli bilibili search 黑神话 --limit 10

# Read one creator's videos
bycli bilibili user-videos 2 --limit 10

# Read your first favorite folder
bycli bilibili favorite --limit 10

# Read a specific favorite folder
bycli bilibili favorite --fid 123456789 --limit 10

# Read following feed
bycli bilibili feed --limit 10

# Read one user's dynamics by UID
bycli bilibili feed 2 --limit 10

# Read one user's dynamics by username and paginate
bycli bilibili feed 老番茄 --pages 2 --type video

# Read one dynamic in detail
bycli bilibili feed-detail 1234567890123456789

# Fetch subtitles
bycli bilibili subtitle BV1xx411c7mD --lang zh-CN

# Inspect one video's metadata
bycli bilibili video BV1xx411c7mD
bycli bilibili video https://www.bilibili.com/video/BV1xx411c7mD/

# Fetch the official AI summary for a video
bycli bilibili summary BV1xx411c7mD
bycli bilibili summary https://www.bilibili.com/video/BV1xx411c7mD/

# Read comments and a reply thread under a top-level rpid
bycli bilibili comments BV1xx411c7mD --limit 10
bycli bilibili comments BV1xx411c7mD --parent 123456789 --limit 10

# Post a comment or reply. The write only happens with --execute.
bycli bilibili comment BV1xx411c7mD "这条评论来自 byCLI" --execute
bycli bilibili comment BV1xx411c7mD "回复楼主" --parent 123456789 --execute

# JSON output
bycli bilibili hot -f json

# Verbose mode
bycli bilibili hot -v
```

## Prerequisites

- Chrome running and **logged into** bilibili.com
- [Browser Bridge extension](/guide/browser-bridge) installed

## Notes

- `bycli bilibili feed` without `uid` reads your following feed
- `bycli bilibili feed <uid-or-name>` reads a specific user's dynamics
- `bycli bilibili favorite` defaults to the first favorite folder when `--fid` is omitted
- `feed-detail` expects the dynamic ID from a `https://t.bilibili.com/<id>` URL
- `comments` emits `rpid`; pass a top-level row's `rpid` to `comments --parent` to read its reply thread
- `comments --limit` accepts `1..50`; empty comment lists raise `EmptyResultError`
- `comment` is a write command and refuses to post unless `--execute` is passed
- `comment --parent` expects the top-level/root `rpid`; nested reply-to-reply targeting is not inferred
