# YouTube

**Mode**: 🔐 Browser · **Domain**: `youtube.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli youtube search` | Search videos |
| `bycli youtube video` | Get video metadata |
| `bycli youtube transcript` | Get video transcript/subtitles |
| `bycli youtube comments` | Get video comments |
| `bycli youtube channel` | Get channel info and videos |
| `bycli youtube playlist` | Get playlist video list |
| `bycli youtube feed` | Homepage recommended videos |
| `bycli youtube history` | Watch history |
| `bycli youtube watch-later` | Watch Later queue |
| `bycli youtube subscriptions` | List subscribed channels |
| `bycli youtube like` | Like a video |
| `bycli youtube unlike` | Remove like from a video |
| `bycli youtube subscribe` | Subscribe to a channel |
| `bycli youtube unsubscribe` | Unsubscribe from a channel |

## Usage Examples

```bash
# Read commands
bycli youtube feed --limit 10
bycli youtube history --limit 20
bycli youtube watch-later --limit 50
bycli youtube subscriptions --limit 30

# Search and video info
bycli youtube search "rust programming" --limit 5
bycli youtube video "https://www.youtube.com/watch?v=xxx"
bycli youtube transcript "https://www.youtube.com/watch?v=xxx"

# Write commands (requires login)
bycli youtube like "https://www.youtube.com/watch?v=xxx"
bycli youtube unlike "videoId"
bycli youtube subscribe "@ChannelHandle"
bycli youtube unsubscribe "UCxxxxxxxxxxxxxx"
```

## Prerequisites

- Chrome running and **logged into** youtube.com
- [Browser Bridge extension](/guide/browser-bridge) installed
