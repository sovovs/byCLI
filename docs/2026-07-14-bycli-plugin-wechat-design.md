# byCLI 内置 weixin 公众号历史文章能力设计

> **Superseded (2026-07-27):** 本历史设计由 [`docs/superpowers/specs/2026-07-27-wechat-crawler-package-integration-design.md`](./superpowers/specs/2026-07-27-wechat-crawler-package-integration-design.md) 取代。当前实现使用 `@sovovs/wechat-article-crawler` 的 public root API，不 spawn `wechat-crawler` CLI；本文件保留用于记录演进。

## 1. 背景与结论

byCLI 已有 `clis/weixin`，当前提供：

- `weixin search`：通过搜狗微信搜索公众号文章。
- `weixin download`：将单篇微信文章保存为 Markdown。
- `weixin drafts`：列出微信公众号后台草稿。
- `weixin create-draft`：创建微信公众号图文草稿。

本设计直接扩展该内置 adapter，增加微信公众号搜索与历史文章批量处理能力：

```bash
bycli weixin accounts <query>
bycli weixin articles <fakeid>
bycli weixin save-articles <fakeid>
```

最终架构决策：

- 新能力进入 OpenCLI 的 `clis/weixin`，随 `@sovovs/bycli` 默认发布。
- 不创建 `clis/wechat`，不改变现有四个 `weixin` 命令的行为。
- 不再发布或安装 `bycli-plugin-wechat`。
- 通过 `@sovovs/wechat-article-crawler` 的 public root API 使用微信历史文章、分页和安全保存能力；不导入 private `src/*`/`bin/*` 路径，也不 spawn `wechat-crawler` CLI。
- 认证、Browser Bridge 交互、byCLI Markdown 元数据与输出仍由 byCLI 负责；crawler 仅提供可编程 API，不承载 byCLI 的 CLI 参数解析、JSON envelope、退出码或进程边界。
- crawler 默认安全保存要求 Linux；在非 Linux 平台默认 fail-closed。只有显式注入自定义文件系统实现时才作为库集成使用该能力，普通 byCLI CLI 不绕过此平台约束。
- 保留已完成的条件浏览器能力：默认使用浏览器登录，显式 `--auth-source env` 时不连接浏览器。

## 2. 目标与非目标

### 2.1 目标

- 通过微信公众平台 `search_biz` 搜索公众号并返回 `fakeid`。
- 根据明确的 `fakeid` 分页列出公众号历史文章。
- 将历史文章批量保存为 Markdown，并逐篇报告成功或失败。
- 默认复用 Chrome 中的微信公众平台会话；未登录时将登录页置于前台并等待用户完成登录。
- 为 CI 或无浏览器环境保留显式环境变量认证。
- 全链路保护 token、Cookie、fingerprint 和敏感 Cookie 值。
- 复用 byCLI typed errors、格式化输出、浏览器桥和 adapter manifest 机制。

### 2.2 非目标

- 不自动选择名称相似的公众号。
- 不持久化、缓存或刷新微信凭证。
- 不绕过微信权限、登录验证或风控。
- 不改变现有 `weixin search/download/drafts/create-draft` 的命令合同。
- 不保留 crawler CLI 兼容层、stdout envelope 或退出码 0/2/3 映射。
- 不在测试、fixture、trace 或日志中保存真实凭证或微信生产响应。

## 3. 代码结构

新增三个命令入口与一组共享模块：

```text
clis/weixin/
├── search.js                  # 现有：搜狗微信文章搜索
├── download.js                # 现有：单篇文章下载
├── drafts.js                  # 现有：草稿列表
├── create-draft.js            # 现有：创建草稿
├── accounts.js                # 新增：搜索公众号/fakeid
├── articles.js                # 新增：列出历史文章
├── save-articles.js           # 新增：批量保存 Markdown
└── _wechat/
    ├── auth-session.js        # 浏览器/env 凭证解析与登录等待
    ├── fingerprint.js         # 页面内一次性捕获 fingerprint
    ├── search-biz.js          # search_biz 请求与响应校验
    ├── crawler-runtime.js     # crawler public root API 与 byCLI 错误映射
    ├── article-content.js     # 有界正文获取与 Browser Bridge 回退
    ├── markdown.js            # Markdown 构建与安全文件名
    ├── args.js                # 严格参数读取
    └── redact.js              # 文本与结构化值脱敏
```

共享模块使用 JavaScript 与 JSDoc，匹配现有 `clis/` 运行和构建方式。每个命令入口只负责注册元数据、读取参数、编排共享模块及返回静态列对应的行；历史文章 API、分页和安全保存通过 `crawler-runtime.js` 调用 crawler package public root API，不在 byCLI 复制实现。

迁移来源：

- 从现有 `bycli-plugin-wechat` 工作成果迁入认证、fingerprint、`search_biz`、参数与脱敏实现及其安全测试。
- 通过 crawler public root API 调用 `wechat-api`、分页与安全保存能力；不导入其 `src/*`/`bin/*` 私有路径。
- 不在 byCLI 中启动 crawler CLI，也不复刻其 envelope 包装、CLI 退出码处理或进程边界。

独立目录 `/Users/lijiahui/Desktop/bycli-plugin-wechat` 仅作为迁移来源保留，不由实施过程自动删除。

## 4. 命令合同

### 4.1 `weixin accounts`

```bash
bycli weixin accounts <query> \
  [--limit 10] \
  [--auth-source browser|env] \
  [-f table|json|yaml|plain|md|csv]
```

注册属性：

```text
access: read
strategy: INTERCEPT
browser: args['auth-source'] !== 'env'
domain: mp.weixin.qq.com
```

默认 `limit=10`、`auth-source=browser`。`limit` 必须是正整数。输出列：

```js
['nickname', 'fakeid', 'alias']
```

`alias` 缺失时为 `null`。返回全部候选，不按相似度自动选择，不默认使用第一项；无结果抛 `EmptyResultError`。

### 4.2 `weixin articles`

```bash
bycli weixin articles <fakeid> \
  [--name <nickname>] \
  [--limit N] \
  [--max-pages N] \
  [--auth-source browser|env] \
  [-f table|json|yaml|plain|md|csv]
```

注册属性：

```text
access: read
strategy: COOKIE
browser: args['auth-source'] !== 'env'
domain: mp.weixin.qq.com
```

`fakeid` 是必填位置参数；`name` 只用于可读元数据，不参与公众号选择。`limit` 与 `max-pages` 若提供必须是正整数，不静默 clamp。输出列：

```js
['title', 'author', 'digest', 'publishedAt', 'url']
```

缺失字段统一为 `null`；无文章抛 `EmptyResultError`。调用者可通过 byCLI 格式化输出和 Shell 重定向保存列表，不额外提供列表 JSON 写盘模式。

### 4.3 `weixin save-articles`

```bash
bycli weixin save-articles <fakeid> \
  [--name <nickname>] \
  [--output ./weixin-articles] \
  [--limit N] \
  [--max-pages N] \
  [--auth-source browser|env] \
  [-f table|json|yaml|plain|md|csv]
```

注册属性：

```text
access: write
strategy: COOKIE
browser: args['auth-source'] !== 'env'
domain: mp.weixin.qq.com
```

默认输出目录为 `./weixin-articles`。输出列：

```js
['title', 'status', 'stage', 'path', 'error', 'url']
```

成功行：

```json
{
  "title": "文章标题",
  "status": "saved",
  "stage": null,
  "path": "/absolute/path/article.md",
  "error": null,
  "url": "https://mp.weixin.qq.com/s/..."
}
```

失败行：

```json
{
  "title": "文章标题",
  "status": "failed",
  "stage": "download",
  "path": null,
  "error": "下载超时",
  "url": "https://mp.weixin.qq.com/s/..."
}
```

单篇正文获取或转换失败不删除已成功文件，命令返回完整成功/失败行。输出目录创建、权限或 Markdown 写盘失败属于命令级错误，立即抛 `CommandExecutionError`；不再模拟 crawler 的 exit 2/3。

## 5. 认证与登录

### 5.1 浏览器模式

默认流程：

```text
连接 byCLI Browser Bridge
  → 复用 mp.weixin.qq.com 页面
  → 检查可信 HTTPS 后台 URL、token 与明确登录 UI
      ├─ 已登录：继续
      └─ 未登录：打开登录页并 focusWindow()
                    → 每 500ms 轮询
                    → 最长等待 180 秒
  → 读取 token 与目标域 Cookie
  → 进入图文编辑场景
  → accounts 安装一次性请求监听器
      → 等待并点击 header 中的“账号名片”入口
      → 等待“插入账号名片”弹窗
      → 在弹窗内输入 query 并触发搜索
      → 捕获真实 search_biz 请求中的 fingerprint
      → 使用当前会话凭证直接请求 search_biz
```

页面预检只接受标准 HTTPS `https://mp.weixin.qq.com` origin、`/cgi-bin/` 路径与非空 token；可见登录表单、二维码或登录提示构成未登录信号。预检只是快速判断，真正的业务请求仍必须校验微信响应。

Cookie 必须通过 `page.getCookies({ url: 'https://mp.weixin.qq.com/' })` 获取，以包含 HttpOnly Cookie。只保留未过期且属于 `mp.weixin.qq.com` 或合法子域的 Cookie，拒绝前后缀混淆域名。

需要登录时才要求并调用 `focusWindow()`；已登录命令不主动抢占焦点。轮询使用注入的单调时钟，并在超时边界读取最后一次页面状态后再决定是否超时。超时路径不读取 Cookie。

### 5.2 环境变量模式

只有显式 `--auth-source env` 才使用环境变量：

```text
accounts: WECHAT_TOKEN + WECHAT_COOKIE + WECHAT_FINGERPRINT
articles/save-articles: WECHAT_TOKEN + WECHAT_COOKIE
```

凭证必须来自同一来源且完整，禁止浏览器与环境变量混用。环境变量模式不会连接 daemon、extension 或 Chrome。

## 6. fingerprint 与 `search_biz`

浏览器模式进入公众号图文编辑页后，在页面上下文临时包装 `fetch` 与 `XMLHttpRequest.open`。监听器必须先于任何 UI 交互安装，随后按真实后台流程触发公众号搜索：

```text
查找 header 中可见且文本为“账号名片”的入口
  ├─ 直接可见：点击入口一次
  └─ 不可见：定位包含多个插入功能名称的顶部插入工具栏
              → 点击该工具栏内唯一的省略号入口
              → 等待下拉菜单中出现“账号名片”
              → 点击菜单项一次
  → 等待标题为“插入账号名片”的可见弹窗
  → 只在该弹窗内定位搜索输入框
  → 写入 query 并触发搜索按钮或 Enter
  → 捕获 /cgi-bin/searchbiz 请求
```

自动交互只打开弹窗并执行搜索，不选择搜索结果、不点击“插入”，因此不修改或保存草稿。选择器必须以 header、顶部插入工具栏、其下拉菜单和“插入账号名片”弹窗为可信作用域，不使用无作用域的全局“搜索”按钮或输入框。

顶部插入工具栏必须通过同一可见容器中至少三个稳定功能标签识别，例如“图片”“视频”“音频”“超链接”“小程序”“模板”“投票”“搜索”“地理位置”；只允许点击该容器内唯一的省略号/“更多”入口。正文格式工具栏不包含这些插入功能标签，即使同样存在省略号也不得点击。下拉菜单出现后，只点击其中唯一且文本严格等于“账号名片”的菜单项。若无法唯一识别插入工具栏、省略号或菜单项，则不进行猜测，进入前台手动开窗兜底。

页面动态渲染时，在统一超时预算内等待入口与弹窗。若自动等待后仍找不到“账号名片”入口，则将窗口置前并等待用户手动打开“插入账号名片”弹窗；检测到弹窗后自动填写并继续。入口和弹窗均未在超时前出现时抛 `TimeoutError`；弹窗已出现但缺少唯一搜索输入框时抛 `CommandExecutionError`，明确报告页面结构变化。

监听器只保存匹配 `/cgi-bin/searchbiz` 请求中的 `fingerprint` 参数：

- 不保存或返回完整请求 URL。
- 成功、失败或超时均恢复原函数并删除临时属性。
- fingerprint 与 token、Cookie 必须来自同一浏览器会话。

`search_biz` 请求包含：

```text
action=search_biz
scene=1
begin=0
count=<limit>
query=<query>
fingerprint=<fingerprint>
token=<token>
lang=zh_CN
f=json
ajax=1
```

捕获 fingerprint 后不复用 UI 搜索结果，而是使用统一 transport 再请求一次 `search_biz`，以保持 `limit`、响应校验和错误映射一致。浏览器模式使用 `page.fetchJson`；环境变量模式使用 Node `fetch` 并设置 Cookie、Referer 与 `X-Requested-With`。Referer 必须根据当前 token 动态生成，包含图文编辑页参数 `type=10`、`token=<token>` 与 `lang=zh_CN`，不得使用缺少 token 的静态 Referer。响应要求 HTTP 成功、JSON 可解析、`base_resp.ret===0`、`list` 为数组、每项包含非空 `nickname` 与 `fakeid`。

认证失效只按 fixture 覆盖的 ret/message allowlist 映射为 `AuthRequiredError`；未知非零响应为 `CommandExecutionError`。

## 7. 历史文章与保存流程

`articles` 和 `save-articles` 直接调用迁入的微信 API 模块：

```text
fakeid + token + Cookie
  → 请求 appmsgpublish 分页接口
  → 校验 HTTP/JSON/base_resp
  → 解析文章
  → 按 URL/文章标识去重
  → 应用 max-pages 与 limit
```

第一页业务响应是认证权威信号：已知凭证失效抛 `AuthRequiredError`，未知接口错误抛 `CommandExecutionError`。分页停止条件由返回数量、总数、下一页能力、`max-pages` 与 `limit` 共同决定，禁止无限翻页。

`save-articles` 对每篇文章先使用 Node `fetch` 获取正文；浏览器认证模式下，若 Node 请求因 HTTP、重定向或微信验证页而失败，则自动通过当前 Browser Bridge 页面导航至受信任的文章 URL，取得有大小上限的页面 HTML，再进入既有 Markdown 转换和安全写盘流程。环境变量模式保持 Node-only，不隐式连接浏览器。浏览器回退复用现有 `weixin download` 已验证的页面加载模式，但 adapter 之间不互相调用。

文件名必须清除路径分隔符、控制字符和平台非法字符；所有目标路径必须位于解析后的输出目录内。重复标题使用稳定后缀避免同次批量保存互相覆盖。输出返回绝对路径。

## 8. 错误模型

本功能只复用 byCLI 现有 typed errors，不新增 `ErrorCode`：

| 场景 | 错误类型 | exit |
|---|---|---:|
| 参数缺失、格式错误、非正整数 | `ArgumentError` | 2 |
| 搜索无公众号或文章列表为空 | `EmptyResultError` | 66 |
| 环境变量缺失、明确未登录或凭证失效 | `AuthRequiredError` | 77 |
| Browser Bridge 或必要浏览器能力不可用 | `BrowserConnectError` | 69 |
| 登录或 fingerprint 捕获超时 | `TimeoutError` | 75 |
| HTTP、JSON、未知微信响应、页面结构或写盘失败 | `CommandExecutionError` | 1 |

禁止用空数组掩盖认证或协议错误，禁止返回伪造错误行替代命令级 typed error，禁止用 `"-"`、`"N/A"` 或空字符串替代可空值。

## 9. 安全与脱敏

敏感数据包括完整 token、Cookie、fingerprint，以及 `slave_sid`、`data_ticket`、`bizuin`、`cert`、`rand_info` 等 Cookie 值。

要求：

- 敏感值只存在于单次命令内存，不进入 argv、配置、cache、site memory、fixture、trace、日志或输出。
- secret set 包含完整 token、完整 Cookie、fingerprint、各 Cookie value 及 URI 编码变体。
- percent escape 的十六进制大小写不影响匹配，但原始字面字符保持大小写敏感。
- 替换必须单次扫描，生成的脱敏标记不得再次被扫描或放大。
- 短低熵值只在完整独立值或明确的 Cookie/header/query/key 上下文脱敏，不能破坏普通文本。
- 结构化值投影不得执行 getter、函数、`toJSON` 或自定义 inspect；不得保留任意可执行原型；循环可序列化，反射失败时 fail closed。
- secret 数组复制、过滤、冻结或 JSON 重建后不得因对象身份丢失 Cookie 关联。
- 含敏感描述的 Symbol key 必须安全投影，`util.inspect` 不得泄漏。
- byCLI observation 和 extension URL redaction 继续覆盖 `fingerprint`。

## 10. 测试策略

### 10.1 共享模块

- 环境变量凭证完整性与来源隔离。
- 已登录复用、未登录扫码、focus、边界登录成功与超时。
- HTTPS origin、恶意域名、过期 Cookie 与 HttpOnly Cookie。
- 登录 UI DOM 回调真实执行，覆盖二维码、可见性和登录文本。
- fingerprint 监听器先于交互安装，只捕获参数值并在所有路径恢复页面函数。
- 自动点击 header“账号名片”、等待“插入账号名片”弹窗、弹窗作用域输入与搜索触发。
- “账号名片”隐藏时识别顶部插入工具栏、点击其省略号并选择唯一菜单项；页面存在多个省略号时不得误点正文格式工具栏。
- 延迟渲染、自动入口缺失后的手动开窗继续、超时，以及不选择结果/不点击“插入”。
- `search_biz` URL、动态 token Referer、headers、browser/env transport 与响应分类。
- 微信文章分页、去重、limit/max-pages 和停止条件。
- Markdown 转换、文件名清理、重复标题、写盘失败与逐篇部分失败。
- 脱敏的编码变体、短值上下文、线性复杂度、对象投影与日志安全。

### 10.2 命令合同

- 三个新命令的 site/name/access/strategy/browser/domain、参数和静态列。
- `accounts` 不自动选择相似名称。
- `articles` 缺失字段为 `null`，不输出 `alias`。
- `save-articles` 同时返回 saved/failed 行，失败 message 映射到 `error`。
- `save-articles --auth-source browser` 的 Node 下载失败时自动使用浏览器页面回退；验证页、非文章最终 URL 与超大 HTML 均被拒绝。
- `--auth-source env` 不创建浏览器会话。
- 现有四个 `weixin` 命令的注册、参数和行为回归。

### 10.3 集成与验收

- 所有网络测试使用合成 fixture 和注入 transport，不访问微信生产接口。
- manifest/build 验证三个命令进入 `cli-manifest.json`，条件 browser 序列化为 `"conditional"`。
- 全量 typecheck、unit、security、build、docs 与 manifest 测试通过。
- `package.json` 与 lockfile 声明 `@sovovs/wechat-article-crawler` 的兼容范围并验证 public root API；不依赖独立插件。
- 本地受控浏览器 E2E 可验证真实登录、fingerprint 与搜索，但不进入普通 CI，也不保留真实网络数据。

## 11. 验收示例

```bash
bycli weixin accounts 前端之神 -f json
```

返回全部候选公众号及 `fakeid`；未登录时等待用户完成登录。

```bash
bycli weixin articles 'Mzg2NjY2NTcyNg==' \
  --name 前端之神 \
  --limit 3 \
  -f json
```

返回不超过三篇文章，stdout 是无凭证的可解析 JSON。

```bash
bycli weixin save-articles 'Mzg2NjY2NTcyNg==' \
  --name 前端之神 \
  --output ./articles \
  --limit 3 \
  -f json
```

成功文章生成 Markdown，输出逐篇列出状态和绝对路径；单篇失败不删除其他成功文件。

```bash
WECHAT_TOKEN='...' WECHAT_COOKIE='...' \
  bycli weixin articles 'Mzg2NjY2NTcyNg==' \
  --auth-source env \
  --limit 3 \
  -f json
```

命令不连接浏览器，直接调用内置微信 API 模块。

## 12. 实施顺序

1. 结束独立插件后续实施，以其已通过复核的认证、参数与脱敏代码作为迁移输入。
2. 将认证、fingerprint、`search_biz`、参数和脱敏模块迁入 `clis/weixin/_wechat`，转换为现有 JS/JSDoc 风格并保留测试。
3. 接入 crawler public root API 的微信 API、分页与保存能力，不 spawn CLI，不携带 envelope、子进程或退出码假设。
4. 抽取并复用现有 `weixin download` 的正文下载能力，避免双份 DOM 解析。
5. 注册 `accounts`、`articles`、`save-articles`，锁定参数、条件浏览器与输出列合同。
6. 补齐共享模块、命令、现有 weixin 回归、manifest、security 和集成测试。
7. 保持 crawler 依赖在 public root API 合同内，清理独立插件陈旧文档，完成全量构建与受控 E2E。

## 13. 兼容与发布

- 条件浏览器能力要求 byCLI 核心版本至少为 2.1.0；本设计直接在已包含该能力的 OpenCLI 分支实施。
- 三个命令作为内置 adapter 随下一版 `@sovovs/bycli` 发布，不单独发布 npm 包，也不需要 `bycli plugin install`。
- 现有 `weixin` 命令保持兼容；新增命令不会占用或改变 `weixin search`。
- 若微信接口发生变化，通过 OpenCLI adapter 更新统一发布，不再维护 crawler 与插件之间的版本矩阵。
