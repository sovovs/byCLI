# Gitee

**Mode**: 🌐 Public (Browser) · **Domain**: `gitee.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli gitee trending` | Recommended open-source projects from Gitee Explore |
| `bycli gitee search` | Search Gitee repositories by keyword |
| `bycli gitee user` | Show user profile panel (nickname, followers, public repos, Gitee index) |

## Usage Examples

```bash
# Explore recommended projects
bycli gitee trending --limit 10

# Search repositories
bycli gitee search bycli --limit 10

# User profile panel
bycli gitee user fu-qingrong

# JSON output
bycli gitee trending --limit 5 -f json
bycli gitee search "ai agent" --limit 5 -f json
bycli gitee user jackwener -f json
```

## Prerequisites

- Chrome running with [Browser Bridge extension](/guide/browser-bridge) installed
- No login required for these public commands
