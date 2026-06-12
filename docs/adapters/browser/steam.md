# Steam

**Mode**: 🌐 Public · **Domain**: `store.steampowered.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli steam top-sellers` | Top selling games on Steam |
| `bycli steam search <query>` | Search the Steam storefront by name keyword |
| `bycli steam app <id>` | Storefront detail for a single app id (game / DLC / package) |

## Usage Examples

```bash
# Top sellers
bycli steam top-sellers --limit 10

# Free-text search
bycli steam search "portal" --limit 5
bycli steam search "stardew" --limit 5

# App detail (round-trip from search.id)
bycli steam app 620      # Portal 2
bycli steam app 413150   # Stardew Valley

# Different storefront / currency
bycli steam search "portal" --currency cn
bycli steam app 620 --currency jp

# JSON output
bycli steam app 620 -f json
```

## Output Columns

| Command | Columns |
|---------|---------|
| `top-sellers` | (see existing top-sellers row schema) |
| `search` | `rank, id, name, price, currency, metascore, platforms, url` |
| `app` | `id, name, type, isFree, releaseDate, developers, publishers, price, currency, metacritic, recommendations, genres, categories, shortDescription, website, url` |

The `id` column on `search` round-trips into `app` — it's Steam's numeric app id (also visible in the storefront URL `store.steampowered.com/app/<id>/`).

## Notes

- `price` is the storefront's localized final price expressed as a decimal (e.g. `9.99`), not cents. The accompanying `currency` column gives the ISO code.
- `--currency` is a Steam country code (`us`, `cn`, `jp`, `de`, ...). It controls both pricing and regional availability — some apps return `success: false` outside their licensed regions; the adapter raises `EmptyResultError` with a hint when that happens.
- `metascore` / `metacritic` are returned only when Steam has a Metacritic mapping; otherwise they are `null`.
- HTML entities in `name` and `shortDescription` are decoded (e.g. `&quot;` → `"`).

## Prerequisites

- No login required (public APIs `/api/storesearch/` and `/api/appdetails`).
