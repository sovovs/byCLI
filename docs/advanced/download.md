# Download Support

byCLI supports downloading images, videos, and articles from supported platforms.

## Supported Platforms

| Platform | Content Types | Notes |
|----------|---------------|-------|
| **xiaohongshu** | Images, Videos | Downloads all media from a note |
| **bilibili** | Videos | Requires `yt-dlp` installed |
| **twitter** | Images, Videos | Downloads from user media tab or single tweet |
| **douban** | Images | Downloads poster / still image lists from movie subjects |
| **xiaoyuzhou** | Audio, Transcript | Downloads episode audio and transcript JSON/text with local credentials |
| **zhihu** | Articles (Markdown) | Exports articles with optional image download |
| **weixin** | Articles (Markdown) | Exports WeChat Official Account articles |

## Prerequisites

For video downloads from streaming platforms, install `yt-dlp`:

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
