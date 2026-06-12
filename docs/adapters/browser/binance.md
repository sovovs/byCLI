# Binance

Access **Binance** market data from the terminal via the public API (no authentication required).

**Mode**: 🌐 Public · **Domain**: `data-api.binance.vision`

## Commands

| Command | Description |
|---------|-------------|
| `bycli binance price` | Get 24h ticker stats for one symbol |
| `bycli binance prices` | Get latest prices for all symbols |
| `bycli binance ticker` | Get 24h ticker stats for all symbols |
| `bycli binance pairs` | List exchange trading pairs |
| `bycli binance trades` | Get recent trades for one symbol |
| `bycli binance depth` | Get order-book depth for one symbol |
| `bycli binance asks` | Show ask-side depth for one symbol |
| `bycli binance klines` | Get candlestick data |
| `bycli binance top` | Show top movers by volume |
| `bycli binance gainers` | Show top gainers |
| `bycli binance losers` | Show top losers |

## Usage Examples

```bash
# One symbol, 24h stats
bycli binance price BTCUSDT

# Latest prices for all pairs
bycli binance prices

# Recent trades
bycli binance trades BTCUSDT --limit 20

# Order-book depth
bycli binance depth BTCUSDT --limit 20

# 1h candles
bycli binance klines BTCUSDT --interval 1h --limit 50

# JSON output
bycli binance top -f json
```

## Prerequisites

- No browser required — uses Binance public market-data endpoints

## Notes

- Symbols use Binance market format such as `BTCUSDT` or `ETHUSDT`
- Public market-data endpoints can still be rate-limited upstream; retry if you hit transient failures
