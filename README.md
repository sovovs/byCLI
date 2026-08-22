# byCLI

> Make any website or Electron App your CLI. AI-powered.

byCLI turns websites and Electron apps into composable command-line tools.
It ships a large catalog of site adapters and a browser bridge so you can
drive real authenticated sessions from the terminal.

English | [简体中文](./README.zh-CN.md)

## Install

```bash
npm install -g @sovovs/bycli
```

## Usage

```bash
bycli list                      # list every available command
bycli <site> --help             # show a site's commands
bycli <site> <command> --help   # show a command's args and options
bycli <site> <command> -f yaml  # structured output for agents
```

Examples:

```bash
bycli 12306 stations 北京        # public command, no login required
bycli juejin search bycli        # search Juejin
```

### Search adapters

The following public search commands are available:

```bash
bycli baidu search "open cli" --limit 10 --page 1 --site github.com
bycli bing search "open cli" --freshness week --market en-US
bycli yandex search "open cli" --lr 213 --sort date
bycli so search "open cli" --type news
bycli sogou search "open cli" --time week --sort date
bycli gitlab search runner --scope issues --order-by updated_at --sort desc
bycli csdn search "node cli" --content-type blog --sort latest
bycli threads search "open cli" --author alice
bycli 52pojie search "open cli" --sort latest
```

All search commands accept `--limit` and pagination where supported, and return
structured rows including rank, title, URL, snippet, result type, author,
publication time, score, and platform-specific `extra` data. These adapters use
public pages or the active browser session; login prompts, CAPTCHA, and anti-bot
pages are reported as typed errors instead of empty successful results.

## License

Licensed under the [Apache License 2.0](./LICENSE).

## Acknowledgements

byCLI is a derivative work of [opencli](https://github.com/jackwener/opencli)
by jackwener, distributed under the Apache License 2.0. See the [NOTICE](./NOTICE)
file for the full list of modifications and attribution.
