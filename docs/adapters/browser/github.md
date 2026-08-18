# github

**Mode**: 🌐 Public · **Domain**: `api.github.com`

Multi-dimension repository search over the public GitHub REST API. No browser, no login. `GITHUB_TOKEN` (or `GH_TOKEN`) is optional and only raises the rate limit.

## Commands

| Command | Description |
|---------|-------------|
| `bycli github search [query]` | Search repositories by stars, forks, watchers, language, topic and more |
| `bycli github repo <owner/repo>` | Single-repository metadata including the true watch count |

## Usage Examples

```bash
# Free-text search
bycli github search "http client" --limit 10

# Filter by the star dimension (bare number means ">=")
bycli github search cli --stars 20000
bycli github search cli --stars ">50000"
bycli github search cli --stars "1000..5000"

# Fork dimension, plus language and topic
bycli github search --language rust --topic cli --forks ">500" --limit 10

# Watch dimension (client-side; see the note below)
bycli github search --stars ">50000" --sort watchers --scan 50 --limit 10
bycli github search kubernetes --watchers ">=2000" --scan 60

# Show the real watch count without filtering on it
bycli github search --topic devtools --stars ">10000" --with-watchers

# Filter-only search, no keyword needed
bycli github search --language go --stars "10000..40000" --pushed "2026-01-01"

# Recently active, non-archived, MIT-licensed
bycli github search --topic cli --license mit --pushed ">2026-06-01" --sort updated

# Scope free text to the name only (skip readme matches)
bycli github search ripgrep --in name

# Restrict to orgs
bycli github search --owner vercel,facebook --stars ">1000"

# Detail view: full_name from a search row round-trips here
bycli github repo facebook/react
bycli github repo https://github.com/facebook/react

# JSON output
bycli github search cli --stars ">10000" -f json
```

## Output Columns

| Command | Columns |
|---------|---------|
| `search` | `rank, full_name, stars, forks, watchers, language, description, license, topics, open_issues, pushed, url` |
| `repo` | `full_name, stars, forks, watchers, open_issues, language, description, license, topics, homepage, default_branch, archived, is_fork, size_kb, created, pushed, url` |

The `full_name` column from `search` round-trips into `github repo`.

## The three count dimensions

| Dimension | Filter | Sort | Where it's evaluated |
|-----------|--------|------|----------------------|
| Stars | `--stars` | `--sort stars` | Server-side (GitHub `stars:` qualifier) |
| Forks | `--forks` | `--sort forks` | Server-side (GitHub `forks:` qualifier) |
| Watches | `--watchers` | `--sort watchers` | **Client-side** (see below) |

### Why the watch count is different

GitHub's search index has no watcher qualifier. `watchers:` and `followers:` are both aliases for the **star** count, and every `/search/repositories` row reports `watchers_count` as a copy of `stargazers_count`. Verified directly: `repo:sindresorhus/awesome followers:>=9000` matches (stars 497k) while `followers:>=600000` does not, even though its real watch count is ~8.3k.

The true watch count is `subscribers_count`, available only on the repo endpoint. So `--watchers`, `--sort watchers` and `--with-watchers` work by:

1. Fetching a candidate pool of `--scan` repos (default 30, max 100), ranked by stars for `--sort watchers`.
2. Making one extra API call per candidate to read `subscribers_count`.
3. Filtering and sorting locally, then trimming to `--limit`.

Consequences worth knowing:

- **Cost**: one core-API call per scanned repo. Unauthenticated core quota is 60/hr, so `--scan 60` can exhaust it in a single command. Set `GITHUB_TOKEN` to get 5000/hr.
- **Scope**: results come from the top `--scan` star-ranked candidates, not from all of GitHub. A repo with huge watch counts but few stars can fall outside the pool — raise `--scan` to widen it.
- Without any of the three watch flags, the `watchers` column stays empty rather than silently repeating the star count.

## Options

### `search`

| Option | Description |
|--------|-------------|
| `query` (positional) | Free-text keyword. Optional when at least one filter flag is given |
| `--stars` | Star count: `5000` (>=), `">10000"`, `"<500"`, `"1000..5000"`, `"100..*"` |
| `--forks` | Fork count, same syntax as `--stars` |
| `--watchers` | Watch count, same syntax as `--stars` (client-side, costs API calls) |
| `--language` | Primary language, comma-separated for multiple (`rust,go`) |
| `--topic` | Repository topic, comma-separated for multiple (`cli,devtools`) |
| `--license` | License keyword (`mit`, `apache-2.0`) |
| `--size` | Repo size in KB, same syntax as `--stars` |
| `--pushed` | Last push: `2026-01-01` (>=), `">2026-01-01"`, `"2025-01-01..2026-01-01"` |
| `--created` | Creation date, same syntax as `--pushed` |
| `--issues` | Good-first-issue count, same syntax as `--stars` |
| `--owner` | Restrict to owners/orgs, comma-separated |
| `--in` | Scope free text to `name`, `description`, `readme`, `topics` (comma-separated) |
| `--include-forks` | Include forked repos (GitHub excludes them by default) |
| `--include-archived` | Include archived repos (excluded by default) |
| `--sort` | `best-match` (default), `stars`, `forks`, `watchers`, `updated`, `help-wanted-issues` |
| `--order` | `desc` (default) or `asc` |
| `--limit` | Max results, 1–100 (default: 20) |
| `--page` | Result page (default: 1) |
| `--scan` | Candidate pool size for watch-count work, 1–100 (default: 30) |
| `--with-watchers` | Add the real watch count column without filtering on it |

Numeric and date filters accept a bare value (treated as `>=`), a comparison (`>`, `>=`, `<`, `<=`), or a range (`A..B`, `A..*`, `*..B`). Malformed values are rejected before any request is made.

### `repo`

| Option | Description |
|--------|-------------|
| `repo` (positional) | `owner/repo`, or a full `github.com` URL |

## Rate limits

| Endpoint | Unauthenticated | With `GITHUB_TOKEN` |
|----------|-----------------|---------------------|
| Search | 10 req/min | 30 req/min |
| Core (used by `repo` and watch enrichment) | 60 req/hr | 5000 req/hr |

```bash
export GITHUB_TOKEN=ghp_xxx    # or GH_TOKEN
```

A read-only token with no scopes is enough for public repositories. When the quota runs out the adapter reports a `RATE_LIMITED` error with the reset time rather than an opaque HTTP 403.

## Notes

- GitHub's search index never serves past result 1000. `--page` beyond that window is rejected up front with a hint to narrow the query instead.
- Archived repos are excluded by default, which differs from GitHub's own default. Pass `--include-archived` to match the website.
- A search needs a keyword or at least one real filter. `--include-archived` alone is not a filter, since it would match every repository on GitHub.
- `license` is reported as an SPDX id (`MIT`, `Apache-2.0`), which is also what `--license` accepts in lowercase form.
