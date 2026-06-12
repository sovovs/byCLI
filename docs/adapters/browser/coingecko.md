# CoinGecko

Access **CoinGecko** crypto market data from the terminal via the public API (no authentication required).

**Mode**: 🌐 Public · **Domain**: `api.coingecko.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli coingecko top` | Top coins by market cap |
| `bycli coingecko coin <id>` | Single coin's market detail (price / supply / ATH / homepage) |
| `bycli coingecko trending` | Top trending coins on CoinGecko in the last 24h |
| `bycli coingecko exchanges` | Top exchanges ranked by trust score / 24h BTC volume |
| `bycli coingecko categories` | Crypto sector categories (DeFi / Layer1 / Memes / …) with market cap |
| `bycli coingecko derivatives` | Top crypto derivative (perpetual / futures) markets by 24h volume |
| `bycli coingecko global` | Aggregate market totals: total cap, volume, BTC/ETH dominance |

## Usage Examples

```bash
# Top 10 coins in USD (default)
bycli coingecko top

# Top 5 coins priced in CNY
bycli coingecko top --currency cny --limit 5

# Top 50 coins in EUR
bycli coingecko top --currency eur --limit 50

# Single coin detail (slug from `top` or coingecko URL)
bycli coingecko coin bitcoin
bycli coingecko coin ethereum --currency cny

# Trending in the last 24h (search-volume based)
bycli coingecko trending

# Top exchanges (trust score, 24h BTC volume)
bycli coingecko exchanges --limit 20

# Crypto sector categories (default sort: market_cap_desc)
bycli coingecko categories --limit 10
bycli coingecko categories --sort market_cap_change_24h_desc --limit 10

# Top derivative tickers (perpetuals + futures, sorted by 24h USD volume)
bycli coingecko derivatives --limit 20

# Filter derivatives by symbol substring (BTC pairs only)
bycli coingecko derivatives --symbol BTC --limit 10

# Aggregate market totals (BTC dominance, total cap, etc.)
bycli coingecko global
bycli coingecko global --currency cny

# JSON output
bycli coingecko top -f json
```

## Options

### `top`

| Option | Description |
|--------|-------------|
| `--currency` | Quote currency (`usd` / `cny` / `eur` / `jpy` / etc., default: `usd`) |
| `--limit` | Number of coins to return (1–250, default: 10) |

### `coin`

| Option | Description |
|--------|-------------|
| `id` (positional) | CoinGecko coin slug (lowercase, e.g. `bitcoin`, `ethereum`, `solana`) |
| `--currency` | Quote currency (default: `usd`) |

### `trending`

No arguments — returns the current top-7 trending list.

### `exchanges`

| Option | Description |
|--------|-------------|
| `--limit` | Number of exchanges to return (1–250, default: 20) |

### `categories`

| Option | Description |
|--------|-------------|
| `--sort` | One of `market_cap_desc` (default), `market_cap_asc`, `name_desc`, `name_asc`, `market_cap_change_24h_desc`, `market_cap_change_24h_asc` |
| `--limit` | Number of categories to return (1–100, default: 20) |

### `derivatives`

| Option | Description |
|--------|-------------|
| `--limit` | Max rows to return (1–500, default: 20) |
| `--symbol` | Optional symbol substring filter (e.g. `BTC`, `ETHUSDT`) — also matches the `index_id` field |

### `global`

| Option | Description |
|--------|-------------|
| `--currency` | Quote currency for total market cap / volume (default: `usd`) |

## Output Columns

| Command | Columns |
|---------|---------|
| `top` | `rank, symbol, name, price, change24hPct, marketCap, volume24h, high24h, low24h` |
| `coin` | `id, symbol, name, rank, price, marketCap, volume24h, change24hPct, change7dPct, change30dPct, ath, athDate, atl, atlDate, circulatingSupply, totalSupply, maxSupply, genesisDate, homepage` |
| `trending` | `rank, id, symbol, name, marketCapRank, priceBtc, thumb` |
| `exchanges` | `rank, id, name, trustScore, volume24hBtc, country, yearEstablished, url` |
| `categories` | `rank, id, name, marketCap, volume24h, marketCapChange24hPct, top3Coins` |
| `derivatives` | `rank, market, symbol, indexId, contractType, price, change24hPct, fundingRate, openInterestUsd, volume24hUsd, expired` |
| `global` | `currency, totalMarketCap, totalVolume24h, marketCapChange24hPct, btcDominancePct, ethDominancePct, activeCryptocurrencies, markets, ongoingIcos, updatedAt` |

## Prerequisites

- No browser required — uses CoinGecko's public market-data endpoint

## Notes

- The public endpoint is rate-limited; retry briefly if you hit transient `HTTP 429` responses
- All numeric values are denominated in the selected `--currency`; `coin` fails fast if CoinGecko returns no market fields for that currency
- `change24hPct` is a raw percent (e.g. `2.34` means `+2.34%`), not a fraction
- `--limit` is validated upfront and rejected with `ArgumentError` if non-positive or above 250 (the CoinGecko `per_page` upper bound) — no silent clamp
