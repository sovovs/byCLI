# Lobsters

**Mode**: 🌐 Public · **Domain**: `lobste.rs`

## Commands

| Command | Description |
|---------|-------------|
| `bycli lobsters hot` | Hottest stories |
| `bycli lobsters newest` | Latest stories |
| `bycli lobsters active` | Most active discussions |
| `bycli lobsters tag <tag>` | Stories by tag |
| `bycli lobsters domain <domain>` | Stories submitted from a specific source domain |
| `bycli lobsters read <short_id>` | Read a story and its comment tree |

## Usage Examples

```bash
# Quick start
bycli lobsters hot --limit 10

# Filter by tag
bycli lobsters tag rust --limit 5

# Stories from a specific source domain
bycli lobsters domain github.com --limit 10
bycli lobsters domain arxiv.org --limit 5

# Read a specific story (use the short_id surfaced as `id` in any listing)
bycli lobsters read 6cmh6h --limit 25 --depth 2

# JSON output
bycli lobsters hot -f json
```

## Output Columns

| Command | Columns |
|---------|---------|
| `hot` / `newest` / `active` / `tag` | `rank, id, title, score, author, comments, created_at, tags, url` |
| `domain` | `rank, id, title, score, author, comments, created_at, tags, submission_url, comments_url` |
| `read` | `type, author, score, text` (POST + L0/L1/… comments, with `[+N more replies]` stubs) |

`id` is the lobste.rs `short_id` — pipe it into `read` to drill into the discussion.

`domain` returns both `submission_url` (the underlying article URL on the source site) and `comments_url` (the lobste.rs discussion page). The legacy listing commands collapse these into a single `url` (= `comments_url`).

## Prerequisites

None — all commands use the public JSON API, no browser or login required.
