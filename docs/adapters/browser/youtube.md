# YouTube

**Mode**: 🔐 Browser · **Domain**: `youtube.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli youtube search` | Search videos |
| `bycli youtube download` | Download a video to local MP4 using yt-dlp + ffmpeg (no Browser Bridge required) |
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

For browser commands other than `download`:

- Chrome running and **logged into** youtube.com
- [Browser Bridge extension](/guide/browser-bridge) installed

## Video download

```bash
bycli youtube download "https://www.youtube.com/watch?v=jNQXAC9IVRw" --output ./youtube
bycli youtube download jNQXAC9IVRw --quality 720p --timeout 600 -f json
# Only when account access is needed:
bycli youtube download jNQXAC9IVRw --cookies-from-browser chrome
```

This command runs locally without Browser Bridge and defaults to anonymous access.
Install `yt-dlp`, `ffmpeg` and `ffprobe`; full YouTube support also requires
`yt-dlp-ejs` and a supported JS runtime. The adapter enables Node for yt-dlp.
`--quality` accepts `best` (default), `1080p`, `720p`, `480p`; numbered qualities
are height ceilings, not guaranteed exact resolutions. No available format under
the ceiling is an error. Video and audio are merged/remuxed into MP4 without
re-encoding. Cookies do not guarantee access; some formats may require PO Tokens.

`--timeout` is an integer from 1 to 3600 seconds (default 600), covering extraction,
transfer and postprocessing, plus at most a short process-termination grace period.
Live/upcoming streams and playlist batch downloads are out of scope. A watch URL
with a playlist downloads only its video. Results contain `id`, `url`, `status`,
absolute `path`, and `bytes`. Failures raise an error and preserve existing files.
MP4 structure and a video track are checked before saving; this is not a full
decode check. Partial files from failed attempts are removed; resume is not supported.
