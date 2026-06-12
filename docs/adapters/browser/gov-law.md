# Gov Law

**Mode**: 🌐 Public · **Domain**: `flk.npc.gov.cn`

## Commands

| Command | Description |
|---------|-------------|
| `bycli gov-law search <query>` | Search the National Laws and Regulations Database |
| `bycli gov-law recent` | List the most recent laws and regulations |

## Usage Examples

```bash
bycli gov-law search "人工智能"
bycli gov-law recent --limit 10
```

## Notes

- Uses the site's Vue Router to navigate the law search SPA
- If the site restructures and Vue Router disappears, the command fails with a descriptive `FRAMEWORK_CHANGED` error
