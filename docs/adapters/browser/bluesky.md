# Bluesky

**Mode**: 🌐 Public · **Domain**: `bsky.app`

## Commands

| Command | Description |
|---------|-------------|
| `bycli bluesky profile` | User profile info |
| `bycli bluesky user` | Recent posts from a user |
| `bycli bluesky trending` | Trending topics |
| `bycli bluesky search` | Search users |
| `bycli bluesky feeds` | Popular feed generators |
| `bycli bluesky followers` | User's followers |
| `bycli bluesky following` | Accounts a user follows |
| `bycli bluesky thread` | Post thread with replies |
| `bycli bluesky starter-packs` | User's starter packs |

## Usage Examples

```bash
# User profile
bycli bluesky profile --handle bsky.app

# Recent posts
bycli bluesky user --handle bsky.app --limit 10

# Trending topics
bycli bluesky trending --limit 10

# Search users
bycli bluesky search --query "AI" --limit 10

# Popular feeds
bycli bluesky feeds --limit 10

# Followers / following
bycli bluesky followers --handle bsky.app --limit 10
bycli bluesky following --handle bsky.app

# Post thread with replies
bycli bluesky thread --uri "at://did:.../app.bsky.feed.post/..."

# Starter packs
bycli bluesky starter-packs --handle bsky.app

# JSON output
bycli bluesky profile --handle bsky.app -f json
```

## Prerequisites

None — all commands use the public Bluesky AT Protocol API, no browser or login required.
