# Hugging Face

**Mode**: 🌐 Public · **Domain**: `huggingface.co`

## Commands

| Command | Description |
|---------|-------------|
| `bycli hf top` | Top upvoted Hugging Face papers |
| `bycli hf paper <arxivId>` | Single paper detail (title / authors / summary / AI keywords / upvotes) |
| `bycli hf models` | Top Hugging Face models (downloads / likes / trending / freshness) |
| `bycli hf datasets` | Top Hugging Face datasets |
| `bycli hf spaces` | Top Hugging Face Spaces (gradio / streamlit / docker / static demos) |

## Usage Examples

```bash
# Today's top papers
bycli hf top --limit 10

# Single paper detail by arXiv id (mirrors HF's paper page)
bycli hf paper 1706.03762         # Attention Is All You Need
bycli hf paper 2005.14165         # GPT-3 paper

# All papers (no limit)
bycli hf top --all

# Specific date
bycli hf top --date 2025-03-01

# Weekly/monthly top papers
bycli hf top --period weekly
bycli hf top --period monthly

# Top models by downloads (default)
bycli hf models --limit 20

# Top text-generation models with name filter
bycli hf models --pipeline text-generation --search llama --sort likes --limit 10

# Top datasets by likes
bycli hf datasets --sort likes --limit 10

# Top Spaces by likes
bycli hf spaces --limit 20

# Filter Spaces by SDK
bycli hf spaces --sdk gradio --search llm --limit 10

# JSON output
bycli hf top -f json
```

### `top` Options

| Option | Description |
|--------|-------------|
| `--limit` | Number of papers (default: 20) |
| `--all` | Return all papers, ignoring limit |
| `--date` | Date in `YYYY-MM-DD` format (defaults to most recent) |
| `--period` | Time period: `daily`, `weekly`, or `monthly` (default: daily) |

Returns paper listing rows with `rank, id, title, upvotes, authors`. The `id` value round-trips into `bycli hf paper <id>`.

### `paper` Options

| Option | Description |
|--------|-------------|
| `id` (positional) | arXiv id (e.g. `1706.03762`, optionally with version suffix `v3`) |

Returns one row with `id, title, authors, publishedAt, upvotes, aiKeywords, summary, aiSummary, url`. The `summary` is the original arXiv abstract; `aiSummary` and `aiKeywords` are HF's AI-generated metadata (may be empty for older or non-curated papers). Returns `EmptyResultError` if HF has no paper page for that id.

### `models` Options

| Option | Description |
|--------|-------------|
| `--sort` | `downloads` / `likes` / `trending` / `created_at` / `last_modified` (default: `downloads`) |
| `--search` | Optional name/owner substring filter (e.g. `llama`, `mistralai/`) |
| `--pipeline` | Pipeline tag filter (e.g. `text-generation`, `image-classification`) |
| `--limit` | Max models (1–100, default: 20) |

### `datasets` Options

| Option | Description |
|--------|-------------|
| `--sort` | Same set as `models` (default: `downloads`) |
| `--search` | Optional name/owner substring filter |
| `--limit` | Max datasets (1–100, default: 20) |

### `spaces` Options

| Option | Description |
|--------|-------------|
| `--sort` | `likes` / `created_at` / `last_modified` (default: `likes`; HF doesn't accept `trending` for spaces) |
| `--search` | Optional name/owner substring filter (e.g. `stability`, `openai/`) |
| `--sdk` | SDK filter: `gradio` / `streamlit` / `docker` / `static` |
| `--limit` | Max spaces (1–100, default: 20) |

Returns rows with `rank, id, author, sdk, likes, tags, lastModified, url`.

## Prerequisites

- No browser required — uses public Hugging Face API
