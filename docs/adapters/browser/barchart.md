# Barchart

**Mode**: 🔐 Browser · **Domain**: `barchart.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli barchart quote` | Stock quote with price, volume, and key metrics |
| `bycli barchart options` | Options chain with greeks, IV, volume, and open interest |
| `bycli barchart greeks` | Options greeks overview (IV, delta, gamma, theta, vega) |
| `bycli barchart flow` | Unusual options activity / options flow |

## Usage Examples

```bash
# Get stock quote
bycli barchart quote AAPL

# View options chain
bycli barchart options TSLA

# Options greeks overview
bycli barchart greeks NVDA

# Unusual options flow
bycli barchart flow --limit 20 -f json
```

## Prerequisites

- Chrome running and able to open `barchart.com`
- [Browser Bridge extension](/guide/browser-bridge) installed
