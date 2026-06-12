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

## License

Licensed under the [Apache License 2.0](./LICENSE).

## Acknowledgements

byCLI is a derivative work of [opencli](https://github.com/jackwener/opencli)
by jackwener, distributed under the Apache License 2.0. See the [NOTICE](./NOTICE)
file for the full list of modifications and attribution.
