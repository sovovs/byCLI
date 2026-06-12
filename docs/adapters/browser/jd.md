# JD.com

**Mode**: 🔐 Browser · **Domain**: `item.jd.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli jd item <sku>` | Fetch product details (price, shop, specs, AVIF images) |

## Usage Examples

```bash
# Get product details by SKU
bycli jd item 100291143898

# Limit returned AVIF images
bycli jd item 100291143898 --images 5

# JSON output
bycli jd item 100291143898 -f json
```

## Prerequisites

- Chrome running and **logged into** jd.com
- [Browser Bridge extension](/guide/browser-bridge) installed
