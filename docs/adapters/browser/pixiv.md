# Pixiv

**Mode**: 🔐 Browser · **Domain**: `www.pixiv.net`

## Commands

| Command | Description |
|---------|-------------|
| `bycli pixiv ranking` | Daily/weekly/monthly illustration rankings |
| `bycli pixiv search <query>` | Search illustrations by keyword or tag |
| `bycli pixiv user <uid>` | View artist profile info |
| `bycli pixiv illusts <user-id>` | List illustrations by artist |
| `bycli pixiv detail <id>` | View illustration details |
| `bycli pixiv download <illust-id>` | Download original-quality images |

## Output Columns

| Command | Columns |
|---------|---------|
| `ranking` | `rank, title, author, user_id, illust_id, pages, bookmarks, url` |
| `search` | `rank, title, author, user_id, illust_id, pages, bookmarks, tags, url` |
| `illusts` | `rank, title, illust_id, pages, bookmarks, tags, created, url` |
| `user` | `user_id, name, premium, following, illusts, manga, novels, comment, url` |
| `detail` | `illust_id, title, author, type, pages, bookmarks, likes, views, tags, created, url` |

`illust_id` round-trips from `ranking` / `search` / `illusts` into `detail` / `download`. `user_id` round-trips from `ranking` / `search` into `user` / `illusts`.

## Usage Examples

### Ranking

```bash
# Daily rankings (default)
bycli pixiv ranking --limit 10

# Weekly / monthly rankings
bycli pixiv ranking --mode weekly
bycli pixiv ranking --mode monthly

# R18 rankings
bycli pixiv ranking --mode daily_r18
bycli pixiv ranking --mode weekly_r18

# Other modes: rookie, original, male, female
bycli pixiv ranking --mode rookie
```

### Search

```bash
# Search by keyword or tag
bycli pixiv search "初音ミク" --limit 20

# Filter by content rating
bycli pixiv search "風景" --mode safe       # Safe-for-work only
bycli pixiv search "風景" --mode r18        # R18 only
bycli pixiv search "風景" --mode all        # All (default)

# Sort by popularity
bycli pixiv search "VOCALOID" --order popular_d

# All sort options: date_d (newest), date (oldest), popular_d, popular_male_d, popular_female_d

# Pagination
bycli pixiv search "オリジナル" --page 2 --limit 30
```

### User & Illustrations

```bash
# View artist profile
bycli pixiv user 11

# List artist's illustrations (newest first)
bycli pixiv illusts 11 --limit 10

# View illustration details (tags, stats, type)
bycli pixiv detail 12345678
```

### Download

```bash
# Download all images from an illustration
bycli pixiv download 12345678

# Download to a custom directory
bycli pixiv download 12345678 --output ./my-images
```

### Output Formats

```bash
# JSON output
bycli pixiv ranking -f json

# Verbose mode
bycli pixiv search "test" -v
```

## Prerequisites

- Chrome running and **logged into** pixiv.net
- [Browser Bridge extension](/guide/browser-bridge) installed
