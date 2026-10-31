# 登录与会话检查

`auth` 提供统一的登录入口。它打开官方登录页，由用户完成扫码、短信或其他验证；命令不代填或提交凭据，不导出 Cookie，也不保存密码或令牌。

```bash
bycli auth sites
bycli auth login zhihu --timeout 300
bycli auth status zhihu -f json
```

目前提供 `weibo`、`zhihu`、`xiaohongshu`、`juejin` 四个配方。平台名不区分大小写。登录等待默认 180 秒，`--timeout` 必须是 30–900 的整数，超出范围会报参数错误。

## 页面与浏览器账号

`auth login` 默认在前台打开并保留登录页。各平台使用独立的持久页面，重复执行同一平台命令会复用已有页面，不会在轮询中反复刷新二维码或跳转验证页。超时返回 `waiting`，页面保留，用户可以继续完成验证后执行 `auth status`。

`auth status` 在独立查询页面打开平台首页；默认查询结束后释放该页面，不改变登录页。即使显式使用 `--site-session persistent`，查询和登录仍使用不同页面。

```bash
# 在指定浏览器 profile 登录，并在同一个 profile 检查
bycli auth login zhihu --profile my-profile --timeout 300
bycli auth status zhihu --profile my-profile -f json

# 有需要时显式使用后台窗口
bycli auth login zhihu --window background
```

默认页面保留由 `siteSession: persistent` 提供，持久模式下 `--keep-tab false` 不会关闭页面。显式指定 `--site-session ephemeral` 时按通用临时页面规则执行，可使用 `--keep-tab true` 保留本次页面，但下次调用不会自动复用它。

如已有页面停在配方范围以外的验证域名，命令会报告 `PAGE_IN_USE`，不自动导航覆盖它。先手动完成验证，或关闭该登录页面后重试。多个保留页面也需要先清理到一个。

## 状态含义

| 状态 | 含义 |
|---|---|
| `logged-in` | 平台账号接口或当前用户模型提供了登录证据 |
| `logged-out` | 平台账号接口或模型明确表示未登录 |
| `unknown` | 页面尚未就绪、模型变化、网络失败、限流或验证中，暂时无法确认 |
| `waiting` | 登录命令在等待时限内没有确认成功；不代表登录失败 |

`status` 的导航失败或探针执行异常返回 `unknown`，不会误报为 `logged-out`。输出的 `reason` 是固定原因码，`identity` 只在确认登录后提供。输出 URL 使用配方配置，不输出实际 SSO 回跳 URL、查询参数或网络错误正文。

Cookie 存在、缺失或是否为 HttpOnly 均不单独决定状态。知乎使用同源账号接口；微博、掘金使用当前用户模型；小红书读取 `__INITIAL_STATE__.user.loggedIn`，公开个人主页的数据不算登录证据。命令不会输出浏览器 Cookie。

## 验证范围与限制

五个配方都有模拟页面、接口和生命周期测试。2026-10-31 对真实账号做过一轮登录验收：微博、小红书走完“未登录 → 扫码 → `logged-in`”的完整往返（身份分别与 `bycli weibo me`、`xiaohongshu creator-profile` 一致），知乎、掘金在已登录状态下确认了登录链路。四条 www 配方因此在 `auth sites` 中标为 `live-validated`。

小红书创作中心（`xiaohongshu-creator`）和 www 是两套独立会话：实测中创作中心已登录时 www 仍报未登录。该配方只验证了已登录路径，登录页在未登录状态下尚未观察，仍标为 `needs-live-validation`。

认证状态只针对选定浏览器 profile 的网页会话，也只代表配方声明的 `surface`。一个面 `logged-in` 不代表另一个面可用，也不保证写入权限或发布账号就绪；发布命令仍会执行自己的账号和内容校验。页面模型不匹配时返回 `unknown`，不会根据猜测宣布成功。

如果此前把旧版 auth 安装在 `~/.bycli/clis/auth/`（或 `BYCLI_CONFIG_DIR/clis/auth/`），用户适配器会覆盖内置同名命令。请先把旧目录备份并移出用户适配器目录，再使用内置版本。可用 `bycli adapter status` 检查覆盖情况。
