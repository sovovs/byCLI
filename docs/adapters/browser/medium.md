# Medium

**Mode**: 🌗 Mixed · **Domain**: `medium.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli medium feed` | Get hot Medium posts, optionally scoped to a topic |
| `bycli medium search` | Search Medium posts by keyword |
| `bycli medium user` | Get recent articles by a user |
| `bycli medium tag <tag>` | Latest articles for a Medium tag (public RSS, no browser) |

## Usage Examples

```bash
# Get the general Medium feed
bycli medium feed --limit 10

# Search posts by keyword
bycli medium search ai

# Get articles by a user
bycli medium user @username

# Topic feed as JSON
bycli medium feed --topic programming -f json

# Latest articles for a tag (public RSS — fastest, no browser)
bycli medium tag programming --limit 10
bycli medium tag artificial-intelligence --limit 20
```

## `tag` columns

`rank, title, author, description, categories, published, url`

- `description` is the full RSS `<description>` (no silent truncation; pipe through `head` if you want a preview).
- `categories` is comma-joined Medium tags from each item's `<category>` blocks.
- `published` is the original `pubDate` ISO string when available.

## Prerequisites

- `bycli medium search` and `bycli medium tag` can run without a browser (the latter parses `medium.com/feed/tag/<tag>` RSS)
- `bycli medium feed` and `bycli medium user` require Browser Bridge access to `medium.com`
