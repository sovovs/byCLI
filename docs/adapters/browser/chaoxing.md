# 超星学习通 (Chaoxing)

**Mode**: 🔐 Browser · **Domain**: `mooc2-ans.chaoxing.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli chaoxing assignments` | 学习通作业列表 |
| `bycli chaoxing exams` | 学习通考试列表 |

## Usage Examples

```bash
# List all assignments
bycli chaoxing assignments --limit 20

# Filter exams by course name
bycli chaoxing exams --course "高等数学"

# Filter exams by status
bycli chaoxing exams --status ongoing

# JSON output
bycli chaoxing assignments -f json
```

### Options

| Option | Description |
|--------|-------------|
| `--course` | Filter by course name (fuzzy match) |
| `--status` | Filter by status: `all`, `upcoming`, `ongoing`, `finished` |
| `--limit` | Max number of results (default: 20) |

## Prerequisites

- Chrome running and **logged into** mooc2-ans.chaoxing.com
- [Browser Bridge extension](/guide/browser-bridge) installed
