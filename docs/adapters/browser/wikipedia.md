# Wikipedia

**Mode**: 🌐 Public · **Domain**: `wikipedia.org`

## Commands

| Command | Description |
|---------|-------------|
| `bycli wikipedia search` | Search Wikipedia articles |
| `bycli wikipedia summary` | Get Wikipedia article summary |
| `bycli wikipedia random` | Random Wikipedia article |
| `bycli wikipedia trending` | Trending Wikipedia articles |
| `bycli wikipedia page <title>` | Full plain-text article extract (optional paragraph cap) |

## Usage Examples

```bash
# Search articles
bycli wikipedia search "quantum computing" --limit 10

# Get article summary
bycli wikipedia summary "Artificial intelligence"

# Get the full article body (plain text, no silent truncation)
bycli wikipedia page "Transformer (deep learning architecture)"

# Cap to first 3 paragraphs explicitly
bycli wikipedia page "Photosynthesis" --paragraphs 3

# Use with other languages
bycli wikipedia search "人工智能" --lang zh
bycli wikipedia page "人工智能" --lang zh --paragraphs 5

# JSON output
bycli wikipedia search "Rust" -f json
```

## Notes

- `summary` returns the lead-section blurb truncated to 300 chars (legacy convention)
- `page` returns the **complete** plain-text article body. Pass `--paragraphs N` to opt into a cap; default `0` means full article — no silent truncation

## Prerequisites

- No browser required — uses public Wikipedia API
