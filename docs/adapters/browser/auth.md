# Auth（登录与会话检查）

**Mode**: Browser（`sites` 无需浏览器）

`auth` 提供跨平台的官方登录入口与只读会话检查。需要连接 [Browser Bridge](/guide/browser-bridge)，扫码、短信和其他验证由用户完成。命令不代填或提交凭据，不导出 Cookie，也不保存密码或令牌。

## 命令

| 命令 | 用途 |
| --- | --- |
| `bycli auth sites` | 列出平台、会话面、探测方式和验证状态 |
| `bycli auth login <platform> --timeout 300` | 在前台打开并保留登录页，等待用户完成验证 |
| `bycli auth status <platform> -f json` | 使用独立页面检查会话，不打断登录页 |

支持 `weibo`、`zhihu`、`xiaohongshu`、`juejin` 和 `xiaohongshu-creator`。小红书主站与创作中心使用不同会话，需分别检查。登录等待默认 180 秒，范围为 30–900 秒。

```bash
bycli auth login zhihu --timeout 300
bycli auth status zhihu -f json

bycli auth status xiaohongshu -f json
bycli auth status xiaohongshu-creator -f json
```

## 状态与页面生命周期

`logged-in` 表示当前会话面提供登录证据；`logged-out` 表示明确未登录；`unknown` 表示页面、网络或探针暂时无法确认；`waiting` 表示登录等待超时，默认保留页面供用户继续验证。

登录页按平台隔离并默认保留。查询页独立使用，默认在命令结束后释放。使用多个浏览器 profile 时，在登录、查询及后续平台命令中传入相同的 `--profile`。

账号检查不替代发布命令的账号、权限和内容核对。创作中心配方的未登录路径仍需现场验证，具体范围见[登录与会话检查](/guide/authentication)。
