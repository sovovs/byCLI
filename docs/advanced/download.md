# Download Support

byCLI supports downloading images, videos, and articles from supported platforms.

For the separate upload-and-edit workflow that stops before final publication, see [视频发布准备](./video-publish-prepare.md).

## Supported Platforms

| Platform | Content Types | Notes |
|----------|---------------|-------|
| **xiaohongshu** | Images, Videos | Native MP4 download; use `--type video` to exclude covers |
| **sohu** | Article videos | Native MP4 download from Sohu account article pages |
| **youtube** | Videos | yt-dlp + ffmpeg/ffprobe; anonymous by default, optional browser cookies |
| **tiktok** | Videos | yt-dlp + ffmpeg/ffprobe; supports video and vm/vt share URLs |
| **bilibili** | Videos | Requires `yt-dlp` installed |
| **twitter** | Images, Videos | Downloads from user media tab or single tweet |
| **douban** | Images | Downloads poster / still image lists from movie subjects |
| **xiaoyuzhou** | Audio, Transcript | Downloads episode audio and transcript JSON/text with local credentials |
| **zhihu** | Articles (Markdown) | Exports articles with optional image download |
| **weixin** | Articles (Markdown) | Exports WeChat Official Account articles |

## Prerequisites

Xiaohongshu and Sohu account MP4 downloads use byCLI's browser extension and native HTTP downloader. They do not require `yt-dlp` or ffmpeg. Chrome and the connected byCLI extension must be available; the article/note must be accessible in that browser session.

Other streaming-platform adapters, such as Bilibili, require `yt-dlp`:

```bash
# Install yt-dlp
pip install yt-dlp
# or
brew install yt-dlp
```

## Usage Examples

```bash
# Download images/videos from Xiaohongshu note
bycli xiaohongshu download "https://www.xiaohongshu.com/search_result/<id>?xsec_token=..." --output ./xhs
bycli xiaohongshu download "https://xhslink.com/..." --output ./xhs

# Download only one preferred video stream, without the cover
bycli xiaohongshu download "<full-note-URL-with-xsec_token-or-xhslink>" --type video --output ./xhs --keep-tab false

# Download a video embedded in a Sohu account article (mobile links also work)
bycli sohu download "https://m.sohu.com/a/1028743820_121620820" --output ./sohu --keep-tab false

# Download Bilibili video (requires yt-dlp)
bycli bilibili download --bvid BV1xxx --output ./bilibili
bycli bilibili download --bvid BV1xxx --quality 1080p

# Download Twitter media from user
bycli twitter download elonmusk --limit 20 --output ./twitter

# Download single tweet media
bycli twitter download --tweet-url "https://x.com/user/status/123" --output ./twitter

# Download Douban posters / stills
bycli douban download 30382501 --output ./douban

# Download Xiaoyuzhou episode audio
bycli xiaoyuzhou download 69b3b675772ac2295bfc01d0 --output ./xiaoyuzhou

# Download Xiaoyuzhou transcript JSON + text
bycli xiaoyuzhou transcript 69dd0c98e2c8be31551f6a33 --output ./xiaoyuzhou-transcripts

# Export Zhihu article to Markdown
bycli zhihu download "https://zhuanlan.zhihu.com/p/xxx" --output ./zhihu

# Export with local images
bycli zhihu download "https://zhuanlan.zhihu.com/p/xxx" --download-images

# Export WeChat article to Markdown
bycli weixin download --url "https://mp.weixin.qq.com/s/xxx" --output ./weixin
```

`bycli xiaoyuzhou download` and `transcript` require local Xiaoyuzhou credentials in `~/.bycli/xiaoyuzhou.json`.

## Native Xiaohongshu and Sohu video downloads

Both commands accept `--timeout <seconds>` (default 120, range 1–3600). This covers each file transfer, including redirects and body streaming; browser navigation/player loading is separate. Successful results contain `path` and `bytes`. Use `-f json` for machine-readable output and `--keep-tab false` to release the command's browser tab afterward.

Xiaohongshu accepts signed full note URLs or `xhslink.com` short links, rather than bare note IDs. `--type all` is the default; `video` excludes images and `image` excludes videos. Alternative video streams are treated as one video. Browser authentication is used to read the page; site cookies are not exported to media CDNs.

Sohu accepts `sohu.com/a/<article>_<author>` URLs on the main, `www`, or `m` host. It loads the desktop article and associates the body video with its player ID. Independent `tv.sohu.com` page URLs, recommendations, and unrelated resource URLs are not accepted as article inputs. The current command downloads the first supported body video and does not expose quality selection or multi-video batch download.

The native commands require a complete MP4 container with a video track. Structural validation is not a full codec/decode check. HLS/DASH playlists, HTML/login responses, truncated transfers and malformed containers fail explicitly; a failed transfer removes its own temporary file and preserves an existing destination. HLS remuxing and HTTP Range/resume are not implemented. Site access restrictions or player changes can still prevent extraction.

Validate a downloaded file independently with ffprobe/ffmpeg when needed. These tools are only used for verification; the download command uses native HTTP and bounded MP4 structure checks.

## Pipeline Step

The `download` step can be used in pipeline adapters:

::: v-pre
```yaml
pipeline:
  - fetch: https://api.example.com/media
  - download:
      url: ${{ item.imageUrl }}
      dir: ./downloads
      filename: ${{ item.title | sanitize }}.jpg
      concurrency: 5
      skip_existing: true
```
:::

## YouTube and TikTok

```bash
bycli youtube download "https://www.youtube.com/watch?v=jNQXAC9IVRw" --quality 720p --output ./youtube -f json
bycli tiktok download "https://www.tiktok.com/@user/video/1234567890" --output ./tiktok -f json
```

Both run locally without Browser Bridge. Install yt-dlp and ffmpeg/ffprobe first.
YouTube additionally needs yt-dlp-ejs and a supported JS runtime for full support;
these adapters enable Node as a yt-dlp runtime. Optional `--cookies-from-browser
chrome` uses the local browser session. Defaults are anonymous access, `--quality
best`, and `--timeout 600` seconds. Other qualities are `1080p`, `720p`, `480p`
(height ceilings). Unavailable formats fail explicitly. Outputs are merged/remuxed
MP4 files and successful rows include the absolute `path` and `bytes`.

All yt-dlp downloads now use isolated staging, a process deadline (default ten
minutes), zero exit status and an explicit completed-file receipt. A prefix match,
old destination or `.part` file is never accepted as success. On POSIX, timeout
terminates the download process group including ffmpeg, escalating after one second.
The shared media downloader and pipeline forward their timeout to yt-dlp; pipeline
`timeout` is in seconds. Changed output extensions are returned as the actual path.
See the [YouTube](../adapters/browser/youtube.md#video-download) and
[TikTok](../adapters/browser/tiktok.md#video-download) pages for platform limits.

### Live validation — 2026-10-27

Validated on macOS with yt-dlp 2026.08.19, using anonymous access through the
new byCLI commands (not only direct yt-dlp invocation):

| Platform / sample | Selection | Saved bytes | ffprobe result |
| --- | --- | ---: | --- |
| YouTube `jNQXAC9IVRw` | `--quality 480p` | 533915 | 320×240 AV1 + AAC, 19.064 s |
| TikTok `@patroxofficial/video/6742501081818877190` | `--quality best` | 2748647 | 540×960 H.264 + AAC, 27.467 s |

Both commands returned exit 0 and JSON with the actual file path. Both files
passed full `ffmpeg -v error -i FILE -f null -` decoding with exit 0. These samples
prove the tested paths only; authenticated content, other regions, share links,
other quality ceilings, watermark behavior and Windows were not live-validated.
The YouTube height is below the ceiling; this is expected, not an exact-480p promise.
The TikTok sample with a 480p ceiling returned an explicit unavailable-format error.

A real YouTube retry with `--timeout 1` returned exit 1 and a timeout error;
the existing file's SHA-256 stayed
`c523678b1cb3b5302b74c16c7aface30d147901478454d3f6e0153837d2215e6`,
and no staging directory remained. Regression validation covered 29 test files /
341 tests, plus the TypeScript/manifest build. Video artifacts were stored under
`/tmp/bycli-video-live-20261027/` locally, outside the repository.
