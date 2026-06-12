# Twitter / X

**Mode**: 🔐 Browser · **Domain**: `twitter.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli twitter trending` | |
| `bycli twitter bookmarks` | |
| `bycli twitter profile` | |
| `bycli twitter search` | |
| `bycli twitter timeline` | |
| `bycli twitter thread` | |
| `bycli twitter following` | |
| `bycli twitter followers` | |
| `bycli twitter notifications` | |
| `bycli twitter device-follow` | Read the /i/timeline device-follow notification stream (tweets aggregated under a bell-icon "new posts from @userA and N others" notification) |
| `bycli twitter post` | |
| `bycli twitter reply` | |
| `bycli twitter delete` | |
| `bycli twitter like` | |
| `bycli twitter likes` | |
| `bycli twitter lists` | |
| `bycli twitter list-tweets` | |
| `bycli twitter list-create` | Create a Twitter/X list via GraphQL and return the created list id |
| `bycli twitter list-add` | |
| `bycli twitter list-remove` | |
| `bycli twitter article` | |
| `bycli twitter follow` | |
| `bycli twitter unfollow` | |
| `bycli twitter bookmark` | |
| `bycli twitter unbookmark` | |
| `bycli twitter block` | |
| `bycli twitter unblock` | |
| `bycli twitter hide-reply` | |
| `bycli twitter download` | Download media from a profile via GraphQL UserMedia pagination, or from one tweet URL |
| `bycli twitter accept` | |
| `bycli twitter reply-dm` | |
| `bycli twitter unlike` | |
| `bycli twitter retweet` | |
| `bycli twitter unretweet` | |
| `bycli twitter quote` | |

## Usage Examples

```bash
# Quick start
bycli twitter trending --limit 5

# Search top tweets (default)
bycli twitter search "react 19"

# Search latest/live tweets
bycli twitter search "react 19" --filter live

# Get following/followers list (supports large limits)
bycli twitter following @elonmusk --limit 200
bycli twitter followers @elonmusk --limit 100

# Download profile media with cursor pagination
bycli twitter download @elonmusk --limit 50 --output ./twitter-media

# Download media from a single tweet
bycli twitter download --tweet-url https://x.com/jack/status/20 --output ./twitter-media

# Create a list and then manage members (requires login)
bycli twitter list-create "AI research" --description "Papers and labs" --mode private
bycli twitter list-add 123456789 alice
bycli twitter list-remove 123456789 alice

# Write actions (require login). Idempotent — calling twice is safe.
bycli twitter like https://x.com/jack/status/20
bycli twitter unlike https://x.com/jack/status/20
bycli twitter retweet https://x.com/jack/status/20
bycli twitter unretweet https://x.com/jack/status/20
bycli twitter quote https://x.com/jack/status/20 "great take"

# JSON output
bycli twitter trending -f json

# Verbose mode
bycli twitter trending -v
```

## Prerequisites

- Chrome running and **logged into** twitter.com
- [Browser Bridge extension](/guide/browser-bridge) installed
