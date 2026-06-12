# Yuanbao

**Mode**: 🔐 Browser · **Domain**: `yuanbao.tencent.com`

## Commands

| Command | Description |
|---------|-------------|
| `bycli yuanbao ask <prompt>` | Send a prompt to Yuanbao web chat and wait for the reply |
| `bycli yuanbao send <prompt>` | Fire-and-forget: send a prompt without waiting for the reply |
| `bycli yuanbao new` | Start a new Yuanbao conversation |
| `bycli yuanbao status` | Check login state, current session, and current model |
| `bycli yuanbao read` | Read messages in the current Yuanbao conversation |
| `bycli yuanbao history` | List recent conversations from the Yuanbao sidebar |
| `bycli yuanbao detail <id>` | Open a Yuanbao conversation by ID and read its messages |

## Usage Examples

```bash
# Start a fresh chat
bycli yuanbao new

# Basic ask (internet search on by default, deep thinking off by default)
bycli yuanbao ask "你好"

# Wait longer for a longer answer
bycli yuanbao ask "帮我总结这篇文章" --timeout 90

# Disable internet search explicitly
bycli yuanbao ask "你好" --search false

# Enable deep thinking explicitly
bycli yuanbao ask "你好" --think true

# Fire-and-forget send, then read the reply later via `read`
bycli yuanbao send "解释一下量子纠缠"

# Inspect login + current session state
bycli yuanbao status

# Read the visible conversation
bycli yuanbao read

# List recent conversations from the sidebar
bycli yuanbao history --limit 10

# Open a conversation by URL or "<agentId>/<convId>" pair
bycli yuanbao detail "https://yuanbao.tencent.com/chat/naQivTmsDa/b1118732-15ca-42cc-bc9a-e40090ccfb8c"
bycli yuanbao detail "naQivTmsDa/b1118732-15ca-42cc-bc9a-e40090ccfb8c"
```

## Options

### `ask`

| Option | Description |
|--------|-------------|
| `prompt` | Prompt to send (required positional argument) |
| `--timeout` | Max seconds to wait for a reply (default: `60`) |
| `--search` | Enable internet search before sending (default: `true`) |
| `--think` | Enable deep thinking before sending (default: `false`) |

### `send`

| Option | Description |
|--------|-------------|
| `prompt` | Prompt to send (required positional argument) |
| `--new` | Start a new chat before sending (default: `false`) |

### `new`, `status`, `read`

- No options

### `history`

| Option | Description |
|--------|-------------|
| `--limit` | Max conversations to list (default: `20`; capped by sidebar virtual-scroll window) |

### `detail`

| Option | Description |
|--------|-------------|
| `id` | Full `https://yuanbao.tencent.com/chat/<agentId>/<convId>` URL or `<agentId>/<convId>` slash pair (required positional). A bare conv UUID is rejected — Yuanbao requires the agent slug. |

## Behavior

- The adapter targets the Yuanbao consumer web UI and drives the visible Quill composer.
- `ask` aligns the `联网搜索` and `深度思考` buttons to the requested state, sends the prompt, and polls the transcript until it stabilizes.
- `send` returns as soon as the send button has been clicked. Use `read` afterwards to fetch the reply.
- `new` clicks the left-side new-chat trigger and falls back to reloading the Yuanbao homepage if needed.
- `read` and `detail` walk every visible `.agent-chat__list__item--{human,ai}` and convert assistant markdown HTML to markdown.
- `history` reads the rendered sidebar (`.yb-recent-conv-list__item`) — Yuanbao virtualizes long lists, so very large `--limit` values still cap at the visible window.
- `status` surfaces both the human-readable model label (e.g. `Yuanbao`) and the underlying `dt-model-id` (e.g. `hunyuan_gpt_175B_0404`).

## Prerequisites

- Chrome is running
- You are already logged into `yuanbao.tencent.com`
- [Browser Bridge extension](/guide/browser-bridge) is installed

## Caveats

- This adapter drives the Yuanbao web UI, not a public API.
- Yuanbao commands default to persistent site sessions, so consecutive Yuanbao invocations continue in the same Yuanbao page. Pass `--site-session ephemeral` for a one-shot tab.
- Yuanbao chat URLs encode both an agent slug and a conversation UUID (`/chat/<agentId>/<convId>`). `detail` requires both — passing only a UUID is rejected with an actionable error to avoid silently opening a different agent's chat.
- It depends on the current browser session and may fail if Yuanbao shows login, consent, challenge, or other gating UI.
- DOM or product changes on Yuanbao can break composer detection, submit behavior, or transcript extraction.
