# Taobao

**Mode**: 🔐 Browser · **Domain**: `taobao.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli taobao search <query>` | Search Taobao products |
| `bycli taobao detail <id>` | Fetch product details |
| `bycli taobao reviews <id>` | Fetch product reviews |
| `bycli taobao cart` | View cart items |
| `bycli taobao add-cart <id>` | Add a product to cart |

## Usage Examples

```bash
# Search products
bycli taobao search "机械键盘" --limit 5

# Fetch product details
bycli taobao detail 827563850178

# Dry-run add to cart
bycli taobao add-cart 827563850178 --spec "红色 XL" --dry-run
```

## Prerequisites

- Chrome running and logged into taobao.com
- [Browser Bridge extension](/guide/browser-bridge) installed
