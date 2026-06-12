# Bloomberg

**Mode**: 🌐 / 🔐 Mixed · **Domains**: `feeds.bloomberg.com`, `www.bloomberg.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli bloomberg main` | Bloomberg homepage top stories from RSS |
| `bycli bloomberg markets` | Bloomberg Markets top stories from RSS |
| `bycli bloomberg economics` | Bloomberg Economics top stories from RSS |
| `bycli bloomberg industries` | Bloomberg Industries top stories from RSS |
| `bycli bloomberg tech` | Bloomberg Tech top stories from RSS |
| `bycli bloomberg politics` | Bloomberg Politics top stories from RSS |
| `bycli bloomberg businessweek` | Bloomberg Businessweek top stories from RSS |
| `bycli bloomberg opinions` | Bloomberg Opinion top stories from RSS |
| `bycli bloomberg feeds` | List the RSS feed aliases used by the adapter |
| `bycli bloomberg news <link>` | Read a standard Bloomberg story/article page and return title, summary, media links, and article text |

## What works today

- RSS-backed listing commands work without a browser:
  - `main`
  - `markets`
  - `economics`
  - `industries`
  - `tech`
  - `politics`
  - `businessweek`
  - `opinions`
  - `feeds`
- `bloomberg news` works on standard Bloomberg story/article pages that expose `#__NEXT_DATA__` and are accessible to your current Chrome session.

## Current limitations

- Audio pages and some other non-standard Bloomberg URLs may fail.
- Some Bloomberg pages can return bot-protection or access-gated responses instead of article data.
- This adapter is for data retrieval/extraction only. It does **not** bypass Bloomberg paywall, login, entitlement, or other access checks.

## Usage Examples

```bash
# List supported RSS feed aliases
bycli bloomberg feeds

# Fetch Bloomberg homepage headlines
bycli bloomberg main --limit 5

# Fetch a section feed as JSON
bycli bloomberg tech --limit 3 -f json

# Read a standard article page
bycli bloomberg news https://www.bloomberg.com/news/articles/2026-03-19/example -f json

# Relative article paths also work
bycli bloomberg news /news/articles/2026-03-19/example
```

## Prerequisites

- RSS commands do not require Chrome.
- `bloomberg news` requires:
  - Chrome running
  - a Chrome session that can already access the target Bloomberg article page
  - the [Browser Bridge extension](/guide/browser-bridge)

## Notes

- RSS commands support `--limit` with a maximum of 20 items.
- If `bloomberg news` fails on a page from RSS, try a different standard story/article link first; not every Bloomberg URL in feeds is a normal article page.
