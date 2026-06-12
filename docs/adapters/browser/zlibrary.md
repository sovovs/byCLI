# Z-Library

**Mode**: 🔐 Browser · **Domain**: `z-library.im`

## Commands

| Command | Description |
|---------|-------------|
| `bycli zlibrary search <query>` | Search Z-Library books by title, author, ISBN, or keyword |
| `bycli zlibrary info <url>` | Read a Z-Library book page and list available PDF/EPUB download links |

## Usage Examples

```bash
# Search books
bycli zlibrary search "machine learning" --limit 5

# Get book download formats from a result URL
bycli zlibrary info "https://z-library.im/book/..."

# JSON output
bycli zlibrary search "9780131103627" -f json
```

## Prerequisites

- Chrome running and logged in to `z-library.im` if the page requires authentication.
- [Browser Bridge extension](/guide/browser-bridge) installed.
