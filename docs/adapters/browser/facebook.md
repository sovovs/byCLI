# Facebook

**Mode**: 🔐 Browser · **Domain**: `facebook.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli facebook profile` | Get user/page profile info |
| `bycli facebook notifications` | Get recent notifications with `unread` / `time` / `url` / `notif_id` / `notif_type` |
| `bycli facebook feed` | Get news feed posts |
| `bycli facebook search` | Search people, pages, posts |
| `bycli facebook marketplace-listings` | List your Marketplace seller listings |
| `bycli facebook marketplace-inbox` | List recent Marketplace buyer/seller conversations |

## Usage Examples

```bash
# View a profile
bycli facebook profile zuck

# Get notifications (default 15, max 100)
bycli facebook notifications --limit 10

# News feed
bycli facebook feed --limit 5

# Search
bycli facebook search "OpenAI" --limit 5

# Marketplace seller listings and inbox
bycli facebook marketplace-listings --limit 10
bycli facebook marketplace-inbox --limit 10

# JSON output
bycli facebook profile zuck -f json
```

## Output

### `notifications`

| Column | Type | Notes |
|--------|------|-------|
| `index` | int | 1-based row number across the returned page |
| `unread` | bool | Derived from the explicit `<div>未读</div>` / `<div>Unread</div>` badge child; falls back to the anchor text prefix |
| `text` | string | Notification body text. Read first from the per-row "Mark as read" button's `aria-label` (with the locale prefix stripped) so it does not include the unread badge or trailing time. Full body, **no silent truncation** |
| `time` | string \| null | Time-ago label from the row's `<abbr>`, e.g. `2天` / `5 hrs`. `null` when the abbr is missing — never the legacy `'-'` sentinel |
| `url` | string | Full notification anchor href, including `notif_id` / `notif_t` query params, so callers can follow up |
| `notif_id` | string \| null | `notif_id` query param parsed from `url`; `null` when absent |
| `notif_type` | string \| null | `notif_t` query param (e.g. `onthisday`, `approve_from_another_device`, `group_recommendation`); `null` when absent |

`--limit` accepts a positive integer in `[1, 100]`. Out-of-range or
non-numeric input raises `ArgumentError` upfront — no silent clamp.

If Facebook redirects to a login/checkpoint path (for example
`/login.php`, `/login/identify/`, or `/checkpoint/`; session expired)
the command raises `AuthRequiredError`. An empty notification list after
a successful auth check raises `EmptyResultError` instead of a silent
`[]`.

## Prerequisites

- Chrome running and **logged into** facebook.com
- [Browser Bridge extension](/guide/browser-bridge) installed
