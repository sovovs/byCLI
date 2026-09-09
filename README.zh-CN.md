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

### Linux 下载 IMA 知识库 PDF

Linux 不需要安装 IMA 桌面客户端。安装 bycli 后，把 npm 包内的
`extension/` 目录加载到 Chrome/Chromium 的开发者模式，启动 daemon，并在浏览器中登录
`ima.qq.com`。Browser Bridge 会复用浏览器会话获取文件地址：

```bash
bycli daemon start
bycli ima download "知识库名称" "文件名.pdf" --output ./downloads -f json
```

全局安装时扩展目录可用 `npm root -g` 定位：
`$(npm root -g)/@sovovs/bycli/extension`。如果浏览器会话需要跨机器提供，可在受控浏览器端
导出完整 `x-ima-cookie` 后设置 `BYCLI_IMA_COOKIE`，下载命令会切换到 Node 直连模式，Linux
主机无需安装 IMA App 或运行 Chrome：

```bash
export BYCLI_IMA_COOKIE='完整的 x-ima-cookie'
bycli ima download "知识库名称" "文件名.pdf" --output ./downloads -f json
```

示例:

```bash
bycli 12306 stations 北京        # 公开命令,无需登录
bycli juejin search bycli        # 掘金搜索
```

### 搜索适配器

当前可用的搜索命令包括:

```bash
bycli baidu search "open cli" --limit 10 --page 1 --site github.com
bycli bing search "open cli" --freshness week --market zh-CN
bycli yandex search "open cli" --lr 213 --sort date
bycli so search "open cli" --type news
bycli sogou search "open cli" --time week --sort date
bycli gitlab search runner --scope issues --order-by updated_at --sort desc
bycli csdn search "node cli" --content-type blog --sort latest
bycli threads search "open cli" --author alice
bycli 52pojie search "open cli" --sort latest
```

这些命令会尽量提供 `--limit`、分页、排序、时间、区域、类型等参数，
并返回包含排名、标题、URL、摘要、结果类型、作者、发布时间、评分和平台专属
`extra` 字段的结构化结果。适配器使用公开页面或当前浏览器会话；遇到登录、验证码
或反爬页面时会返回明确的类型化错误，而不是伪造空结果。

## 许可证

基于 [Apache License 2.0](./LICENSE) 开源。

## 致谢

byCLI 衍生自 jackwener 的 [opencli](https://github.com/jackwener/opencli) 项目,
依据 Apache License 2.0 分发。完整的修改说明与归属信息见 [NOTICE](./NOTICE) 文件。
