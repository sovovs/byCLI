# Eastmoney

**Mode**: 🔐 Browser · **Domain**: `guba.eastmoney.com`

Access 东方财富 (Eastmoney) stock-market data from the terminal.

## Commands

| Command | Description |
|---------|-------------|
| `bycli eastmoney hot-rank` | 东方财富热股榜 (Eastmoney hot-stock ranking) |

## Usage Examples

```bash
# Top 20 hot stocks (default)
bycli eastmoney hot-rank

# Top 50 hot stocks
bycli eastmoney hot-rank --limit 50

# JSON output
bycli eastmoney hot-rank -f json
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--limit` | `20` | 返回数量 (number of rows to return) |

## Output Columns

`rank` · `symbol` · `name` · `price` · `changePercent` · `heat` · `url`

## Prerequisites

- Chrome extension installed and connected
- Visit `guba.eastmoney.com` once in the browser so cookies are populated
