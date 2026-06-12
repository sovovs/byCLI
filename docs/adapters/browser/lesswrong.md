# LessWrong

**Mode**: Public · **Domain**: `www.lesswrong.com`

Rationality community and AI alignment research forum.

## Commands

| Command | Description |
|---------|-------------|
| `bycli lesswrong curated` | Editor's picks |
| `bycli lesswrong frontpage` | Algorithmic frontpage feed |
| `bycli lesswrong new` | Latest posts |
| `bycli lesswrong top` | Top rated (all time) |
| `bycli lesswrong top-week` | Top rated this week |
| `bycli lesswrong top-month` | Top rated this month |
| `bycli lesswrong top-year` | Top rated this year |
| `bycli lesswrong read` | Read full post by URL or ID |
| `bycli lesswrong comments` | Top comments on a post |
| `bycli lesswrong user` | User profile |
| `bycli lesswrong user-posts` | List a user's posts |
| `bycli lesswrong tag` | Posts by tag |
| `bycli lesswrong tags` | List popular tags |
| `bycli lesswrong sequences` | Post collections |
| `bycli lesswrong shortform` | Quick takes |

## Usage Examples

```bash
# Browse curated posts
bycli lesswrong curated --limit 5

# Top posts this week
bycli lesswrong top-week --limit 10

# Read a specific post
bycli lesswrong read CzoiqGzpShprcv2Jd
bycli lesswrong read https://www.lesswrong.com/posts/xxx/slug

# Posts tagged "AI"
bycli lesswrong tag ai --limit 5

# User profile and posts
bycli lesswrong user zvi
bycli lesswrong user-posts zvi --limit 5

# Comments on a post
bycli lesswrong comments CzoiqGzpShprcv2Jd --limit 10

# JSON output
bycli lesswrong curated -f json
```

## Prerequisites

- No browser required — uses public LessWrong GraphQL API
