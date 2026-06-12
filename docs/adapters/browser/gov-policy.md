# Gov Policy

**Mode**: 🌐 Public · **Domain**: `www.gov.cn` / `sousuo.www.gov.cn`

## Commands

| Command | Description |
|---------|-------------|
| `bycli gov-policy search <query>` | Search policy documents on gov.cn |
| `bycli gov-policy recent` | List the latest State Council policy documents |

## Usage Examples

```bash
bycli gov-policy search "科技创新"
bycli gov-policy recent --limit 10
```

## Notes

- Both commands run in browser mode over public pages
- `search` uses the gov.cn policy search endpoint with `dataTypeId=107`
