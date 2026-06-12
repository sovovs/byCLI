# byCLI

> 让任意网站或 Electron 应用变成你的命令行工具,AI 驱动。

byCLI 把网站和 Electron 应用变成可组合的命令行工具。它内置大量站点适配器
和浏览器桥接,让你能在终端里驱动真实的已登录会话。

[English](./README.md) | 简体中文

## 安装

```bash
npm install -g @sovovs/bycli
```

## 使用

```bash
bycli list                      # 列出所有可用命令
bycli <site> --help             # 查看某站点的命令
bycli <site> <command> --help   # 查看命令的参数和选项
bycli <site> <command> -f yaml  # 结构化输出(适合 agent)
```

示例:

```bash
bycli 12306 stations 北京        # 公开命令,无需登录
bycli juejin search bycli        # 掘金搜索
```

## 许可证

基于 [Apache License 2.0](./LICENSE) 开源。

## 致谢

byCLI 衍生自 jackwener 的 [opencli](https://github.com/jackwener/opencli) 项目,
依据 Apache License 2.0 分发。完整的修改说明与归属信息见 [NOTICE](./NOTICE) 文件。
