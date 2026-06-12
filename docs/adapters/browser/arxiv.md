# arXiv

**Mode**: 🌐 Public · **Domain**: `arxiv.org`

## Commands

| Command | Description |
|---------|-------------|
| `bycli arxiv search <query>` | Search arXiv papers |
| `bycli arxiv paper <id>` | Get arXiv paper details by ID |
| `bycli arxiv recent <category>` | List recent submissions in a category |
| `bycli arxiv author <name>` | List papers by a given author (newest first) |

## Usage Examples

```bash
# Search for papers
bycli arxiv search "transformer attention" --limit 10

# Get full paper details (full abstract, all authors, primary/all categories, pdf url)
bycli arxiv paper 1706.03762

# Newest papers in a category, sorted by submitted date desc
bycli arxiv recent cs.CL --limit 10
bycli arxiv recent math.PR --limit 5

# Newest papers by an author (best-effort fuzzy match — try alternate spellings if empty)
bycli arxiv author "Yoshua Bengio" --limit 20
bycli arxiv author "Y Bengio" --limit 5

# JSON output
bycli arxiv search "LLM" -f json
```

## Output Columns

| Command | Columns |
|---------|---------|
| `paper` | `id, title, authors, published, updated, primary_category, categories, abstract, comment, pdf, url` |
| `search` | `id, title, authors, published, primary_category, url` |
| `recent` | `id, title, authors, published, primary_category, url` |
| `author` | `id, title, authors, published, primary_category, url` |

`paper` returns the full abstract and full author list. `search`/`recent` are list-style outputs that omit the abstract for readability — pipe an id into `paper` for the full record.

## Common Categories

`cs.AI`, `cs.CL`, `cs.LG`, `cs.CV`, `cs.RO`, `stat.ML`, `math.PR`, `math.ST`, `q-bio.NC`, `econ.TH`, `physics.comp-ph`. Full list: <https://arxiv.org/category_taxonomy>.

## Prerequisites

- No browser required — uses public arXiv API
