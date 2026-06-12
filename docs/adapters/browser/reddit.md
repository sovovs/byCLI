# Reddit

**Mode**: 🔐 Browser · **Domain**: `reddit.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli reddit hot` | Hot posts from a subreddit (or frontpage if none) |
| `bycli reddit frontpage` | Frontpage / r/all listing |
| `bycli reddit home` | **Personalized Best feed (requires login)** |
| `bycli reddit popular` | Trending posts on /r/popular |
| `bycli reddit search` | Search posts |
| `bycli reddit subreddit` | Posts from a specific subreddit, with sort and time filters |
| `bycli reddit subreddit-info` | **Subreddit metadata (subscribers, active, NSFW, created, description)** |
| `bycli reddit read` | Read a post thread with comments |
| `bycli reddit user` | View a user profile |
| `bycli reddit user-posts` | A user's submitted posts |
| `bycli reddit user-comments` | A user's comments |
| `bycli reddit whoami` | **Show the currently logged-in Reddit identity** |
| `bycli reddit upvote` | Vote on a post or comment |
| `bycli reddit save` | Save / unsave a post or comment |
| `bycli reddit comment` | Comment on a post |
| `bycli reddit reply` | Reply to a comment |
| `bycli reddit subscribe` | Join / leave a subreddit |
| `bycli reddit subscribed` | List subreddits you are subscribed to |
| `bycli reddit saved` | List your saved items |
| `bycli reddit upvoted` | List your upvoted posts |

## Usage Examples

```bash
# Quick start
bycli reddit hot --limit 5

# Read one subreddit
bycli reddit subreddit python --limit 10

# Subreddit metadata (subscribers / active / NSFW / created / description)
bycli reddit subreddit-info AskReddit

# Personalized Best feed (requires login)
bycli reddit home --limit 10

# Who am I logged in as?
bycli reddit whoami

# Subscribed subreddits (requires login)
bycli reddit subscribed --limit 50

# Read a post thread
bycli reddit read 1abc123 --depth 2

# Read with "more comments" expansion via /api/morechildren.json
bycli reddit read 1abc123 --depth 3 --expand-more --expand-rounds 3

# Comment on a post
bycli reddit comment 1abc123 "Great post"

# Reply to a comment
bycli reddit reply okf3s7u "Thanks for the context"

# JSON output
bycli reddit hot -f json

# Verbose mode
bycli reddit hot -v
```

## Auth-required commands

`whoami`, `home`, `subscribed`, `saved`, `upvoted`, `subscribe`, `upvote`,
`save`, `comment`, and `reply` all require a logged-in `reddit.com` cookie session. When the
session is missing or expired they raise `AuthRequiredError` (exit code 5)
instead of silently returning empty rows.

For `subreddit-info`, missing / banned / private / quarantined subreddits raise
`EmptyResultError` (exit code 6) so the output table never contains a silent
sentinel row.

For `read`, deleted / quarantined / private posts (HTTP 401/403/404 on
`/comments/<id>.json`) also raise `EmptyResultError`. `--expand-more` follows
Reddit's "more comments" stubs by calling `/api/morechildren.json` up to
`--expand-rounds` times (default 2, max 5). If the morechildren endpoint
itself rejects the request with 401/403, that's surfaced as
`AuthRequiredError` because writeable/expand endpoints often require a logged-
in session even though the post listing is public.

## Prerequisites

- Chrome running and **logged into** reddit.com
- [Browser Bridge extension](/guide/browser-bridge) installed
