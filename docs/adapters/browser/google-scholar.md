# Google Scholar

**Mode**: 🌐 Public · **Domain**: `scholar.google.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli google-scholar search <query>` | Search Google Scholar papers by keyword |
| `bycli google-scholar cite <query>` | Fetch a citation export for a Scholar search result |
| `bycli google-scholar profile <author>` | Open an author profile and list top papers |

## Usage Examples

```bash
bycli google-scholar search "transformer"
bycli google-scholar search "retrieval augmented generation" --limit 5
bycli google-scholar cite "attention is all you need" --style bibtex
bycli google-scholar profile "Yann LeCun" --limit 5
```

## Notes

- Uses browser DOM extraction over public Google Scholar results
- Availability can vary by region or anti-bot challenges
