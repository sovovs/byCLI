# 微信读书 (WeRead)

**Mode**: 🔐 Browser · **Domain**: `weread.qq.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli weread shelf` | List books on your bookshelf |
| `bycli weread search` | Search books on WeRead |
| `bycli weread book` | View book details |
| `bycli weread ranking` | Book rankings by category |
| `bycli weread notebooks` | List books that have highlights or notes |
| `bycli weread highlights` | List your highlights (underlines) in a book |
| `bycli weread notes` | List your notes (thoughts) on a book |

## Usage Examples

```bash
# View your bookshelf
bycli weread shelf --limit 20

# Search books
bycli weread search "三体"

# View book details
bycli weread book <book-id>

# Book rankings
bycli weread ranking --limit 10

# List books with notes/highlights
bycli weread notebooks

# View highlights for a book
bycli weread highlights <book-id>

# View your notes
bycli weread notes <book-id>

# JSON output
bycli weread shelf -f json
```

## Prerequisites

- Chrome running and **logged into** weread.qq.com
- [Browser Bridge extension](/guide/browser-bridge) installed
