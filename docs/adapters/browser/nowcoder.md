# 牛客网 (Nowcoder)

**Mode**: 🌐 / 🔐 · **Domain**: `nowcoder.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli nowcoder hot` | Hot search ranking |
| `bycli nowcoder trending` | Trending posts |
| `bycli nowcoder topics` | Hot discussion topics |
| `bycli nowcoder recommend` | Recommended feed |
| `bycli nowcoder creators` | Top content creators leaderboard |
| `bycli nowcoder companies` | Hot companies for interview prep |
| `bycli nowcoder jobs` | Career category listing |
| `bycli nowcoder search <query>` | Full-text search (type: all/post/question/user/job) |
| `bycli nowcoder suggest <query>` | Search suggestions |
| `bycli nowcoder experience` | Interview experience posts |
| `bycli nowcoder referral` | Internal referral posts |
| `bycli nowcoder salary` | Salary disclosure posts |
| `bycli nowcoder papers` | Interview question bank by company & job |
| `bycli nowcoder practice` | Categorized practice questions with progress |
| `bycli nowcoder notifications` | Unread message summary |
| `bycli nowcoder detail <id>` | Post detail view (supports ID / UUID / URL) |

## Usage Examples

```bash
# Hot search ranking
bycli nowcoder hot --limit 10

# Search for interview experiences
bycli nowcoder search "bilibili" --type post --limit 5

# Search suggestions
bycli nowcoder suggest "java"

# Browse interview experience posts
bycli nowcoder experience --limit 10

# View a specific post detail (using UUID from list commands)
bycli nowcoder detail 2b6b64d4adb34ea3838e832ae4447ab1

# Interview question bank for Java at Huawei
bycli nowcoder papers --job 11002 --company 239

# Practice questions for software development
bycli nowcoder practice --job 11226 --limit 10

# Hot companies for C++ positions
bycli nowcoder companies --job 11003

# JSON output
bycli nowcoder trending -f json

# Verbose mode
bycli nowcoder hot -v
```

## Prerequisites

- **Public commands** (hot, trending, topics, recommend, creators, companies, jobs): No login required
- **Cookie commands** (all others): Chrome running and **logged into** nowcoder.com, [Browser Bridge extension](/guide/browser-bridge) installed
