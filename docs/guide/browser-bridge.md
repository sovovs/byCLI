# Browser Bridge Setup

> **⚠️ Important**: Browser commands reuse your Chrome login session. You must be logged into the target website in Chrome before running commands.

byCLI connects to your browser through a lightweight **Browser Bridge** Chrome Extension + micro-daemon (zero config, auto-start).

## Extension Installation

### Method 1: Download Pre-built Release (Recommended)

1. Go to the GitHub [Releases page](https://github.com/sovovs/byCLI/releases) and download the latest `bycli-extension-v{version}.zip`.
2. Unzip the file and open `chrome://extensions`, enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the unzipped folder.

### Method 2: Load Unpacked Source (For Developers)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` directory from the repository.

## Verification

That's it! The daemon auto-starts when you run any browser command. No tokens, no manual configuration.

```bash
bycli doctor            # Check extension + daemon connectivity
```

## Tab Targeting

Browser commands require an explicit `<session>` positional immediately after `browser`. Use the same session name for a multi-step flow, and use different names to isolate parallel work.

```bash
bycli browser baidu open https://www.baidu.com/
bycli browser baidu tab list
bycli browser baidu tab new https://www.baidu.com/
bycli browser baidu eval --tab <targetId> 'document.title'
bycli browser baidu tab select <targetId>
bycli browser baidu get title
bycli browser baidu tab close <targetId>
```

Key rules:

- `bycli browser <session> open <url>` and `bycli browser <session> tab new [url]` return a `targetId`.
- `bycli browser <session> tab list` prints the `targetId` values of tabs that already exist.
- `--tab <targetId>` routes a single browser command to that specific tab.
- `tab new` creates a new tab but does not change the default browser target.
- `tab select <targetId>` makes that tab the default target for later untargeted `bycli browser ...` commands.
- `tab close <targetId>` removes the tab; if it was the current default target, the stored default is cleared.

## Session Lifecycle

Use a stable session name when you want multiple `bycli browser` commands to keep operating on the same page:

```bash
bycli browser my-session open https://example.com
bycli browser my-session state
bycli browser my-session extract "main"
```

Owned browser sessions use an interactive tab lease with a 10-minute idle timeout. Release it explicitly when done:

```bash
bycli browser my-session close
```

Use `bycli browser <session> bind` when you want to attach byCLI to a Chrome tab you already opened manually. Bound sessions do not have the owned-session idle close timer; they stay attached until `unbind`, tab close, window close, or daemon restart. For owned sessions, use `--window foreground` to watch byCLI work in a visible automation window, or `--window background` to keep that automation window out of the way.

## How It Works

```
┌─────────────┐     WebSocket      ┌──────────────┐     Chrome API     ┌─────────┐
│  bycli    │ ◄──────────────► │  micro-daemon │ ◄──────────────► │  Chrome  │
│  (Node.js)  │    localhost:19825  │  (auto-start) │    Extension       │ Browser  │
└─────────────┘                    └──────────────┘                    └─────────┘
```

The daemon manages the WebSocket connection between your CLI commands and the Chrome extension. The extension executes JavaScript in the context of web pages, with access to the logged-in session.

## Daemon Lifecycle

The daemon auto-starts on first browser command and stays alive persistently.

```bash
bycli daemon stop      # Graceful shutdown
```

The daemon is persistent — it stays alive until you explicitly stop it (`bycli daemon stop`) or uninstall the package.

## Running byCLI from a remote machine

If you need to run `bycli` on a remote server (CI runner, agent host) but keep the browser session on your local machine, see [Remote Orchestration](/guide/remote-orchestration). It walks through the SSH reverse-tunnel pattern so the daemon never leaves localhost.
