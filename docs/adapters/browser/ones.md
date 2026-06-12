# ONES

**Mode**: 🔐 Browser Bridge · **Domain**: `ones.cn` (self-hosted via `ONES_BASE_URL`)

## Commands

| Command | Description |
|---------|-------------|
| `bycli ones login` | Login via Project API (`auth/login`) |
| `bycli ones me` | Current user profile (`users/me`) |
| `bycli ones token-info` | Token/user/team summary (`auth/token_info`) |
| `bycli ones tasks` | Team task list with status/project labels and hours |
| `bycli ones my-tasks` | My tasks (`assign`/`field004`/`owner`/`both`) |
| `bycli ones task` | Task detail by UUID (`team/:team/task/:id/info`) |
| `bycli ones worklog` | Log/backfill hours (GraphQL `addManhour` first, then REST fallbacks) |
| `bycli ones logout` | Logout (`auth/logout`) |

## Usage Examples

```bash
# Required: your ONES base URL
export ONES_BASE_URL=https://your-instance.example.com

# Optional if your deployment requires auth headers
# export ONES_USER_ID=...
# export ONES_AUTH_TOKEN=...

# Login/profile
bycli ones login --email you@company.com --password 'your-password'
bycli ones me
bycli ones token-info

# Task lists
bycli ones tasks <teamUUID> --limit 20
bycli ones tasks <teamUUID> --project <projectUUID> --assign <userUUID>
bycli ones my-tasks <teamUUID> --limit 100
bycli ones my-tasks <teamUUID> --mode both

# Task detail
bycli ones task <taskUUID> --team <teamUUID>

# Worklog: today / backfill
bycli ones worklog <taskUUID> 2 --team <teamUUID>
bycli ones worklog <taskUUID> 1.5 --team <teamUUID> --date 2026-03-23 --note "integration"

bycli ones logout
```

## Prerequisites

- Chrome running and logged into your ONES instance
- [Browser Bridge extension](/guide/browser-bridge) installed
- `ONES_BASE_URL` set to the same origin opened in Chrome

## Notes

- This adapter targets legacy ONES Project API deployments.
- `ONES_TEAM_UUID` can be set to omit `--team` in `tasks` / `my-tasks` / `task`.
- Hours display and input use `ONES_MANHOUR_SCALE` (default `100000`).
