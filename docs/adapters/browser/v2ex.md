# V2EX

**Mode**: 🌐 / 🔐 · **Domain**: `v2ex.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli v2ex hot` | Hot topics |
| `bycli v2ex latest` | Latest topics |
| `bycli v2ex topic <id>` | Topic detail |
| `bycli v2ex node <name>` | Topics by node |
| `bycli v2ex user <username>` | Topics by user |
| `bycli v2ex member <username>` | User profile |
| `bycli v2ex replies <id>` | Topic replies |
| `bycli v2ex nodes` | All nodes (sorted by topic count) |
| `bycli v2ex daily` | Daily hot |
| `bycli v2ex me` | My profile (auth required) |
| `bycli v2ex notifications` | My notifications (auth required) |

## Usage Examples

```bash
# Hot topics
bycli v2ex hot --limit 5

# Browse topics in a node
bycli v2ex node python

# View topic replies
bycli v2ex replies 1000

# User's topics
bycli v2ex user Livid

# User profile
bycli v2ex member Livid

# List all nodes
bycli v2ex nodes --limit 10

# JSON output
bycli v2ex hot -f json
```

## Prerequisites

Most commands (`hot`, `latest`, `topic`, `node`, `user`, `member`, `replies`, `nodes`) use the public V2EX API and **require no browser or login**.

For `daily`, `me`, and `notifications`:

- Chrome running and **logged into** v2ex.com
- [Browser Bridge extension](/guide/browser-bridge) installed
