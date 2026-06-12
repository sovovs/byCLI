# Codex

Control the **OpenAI Codex Desktop App** headless or headfully via Chrome DevTools Protocol (CDP). Because Codex is built on Electron, byCLI can directly drive its internal UI, automate slash commands, and manipulate its AI agent threads.

## Prerequisites

1. You must have the official OpenAI Codex app installed.
2. Launch it via the terminal and expose the remote debugging port:
   ```bash
   # macOS
   /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9238
   ```

## Setup

```bash
export BYCLI_CDP_ENDPOINT="http://127.0.0.1:9238"
```

## Commands

### Diagnostics
- `bycli codex status`: Checks connection and reads the current active window URL/title.
- `bycli codex dump`: Dumps the full UI DOM and Accessibility tree into `/tmp`.
- `bycli codex screenshot`: Captures DOM + snapshot artifacts of the current window.

### Agent Manipulation
- `bycli codex new`: Simulates `Cmd+N` to start a completely fresh and isolated Git Worktree thread context.
- `bycli codex send "message"`: Robustly finds the active Thread Composer and injects your text.
  - *Pro-tip*: You can trigger internal shortcuts, e.g., `bycli codex send "/review"`.
- `bycli codex ask "message"`: Send + wait + read in one shot.
- `bycli codex read`: Extracts the entire current thread history and AI reasoning logs.
- `bycli codex projects`: List visible sidebar projects and conversations.
- `bycli codex history`: List visible conversation threads grouped by project.
- `bycli codex extract-diff`: Automatically scrapes any visual Patch chunks and Code Diffs.
- `bycli codex model`: Get the currently active AI model.
- `bycli codex export`: Export the current conversation as Markdown.

### Selecting a Project Conversation

`send`, `ask`, and `read` can select a visible sidebar conversation before acting:

```bash
bycli codex projects
bycli codex send "Sync the repo and report blockers" --project stock --conversation "同步各仓库最新代码"
bycli codex ask "Summarize current status" --project bycli --index 2 --timeout 120
bycli codex read --project /Users/youngcan/stock --thread-id local:019df125-bf8b-77f0-ade5-de44670db82d
```

Project selection matches either the project label or path. Conversation selection accepts `--conversation`, `--index`, or `--thread-id`.
