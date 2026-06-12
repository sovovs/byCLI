# Discord

Control the **Discord Desktop App** from the terminal via Chrome DevTools Protocol (CDP).

## Prerequisites

Launch with remote debugging port:
```bash
/Applications/Discord.app/Contents/MacOS/Discord --remote-debugging-port=9232
```

## Setup

```bash
export BYCLI_CDP_ENDPOINT="http://127.0.0.1:9232"
```

## Commands

| Command | Description |
|---------|-------------|
| `bycli discord-app status` | Check CDP connection |
| `bycli discord-app send "message"` | Send a message in the active channel |
| `bycli discord-app read` | Read recent messages |
| `bycli discord-app channels` | List channels in the current server |
| `bycli discord-app servers` | List all joined servers |
| `bycli discord-app search "query"` | Search messages (Cmd+F) |
| `bycli discord-app members` | List online members |
| `bycli discord-app delete MESSAGE_ID` | Delete a message by its ID |
