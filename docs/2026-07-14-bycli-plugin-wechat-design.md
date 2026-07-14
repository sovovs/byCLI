# bycli-plugin-wechat 设计规格

## 1. 背景与目标

本设计将独立的 `wechat-crawler` CLI 接入 byCLI，形成统一的微信公众号搜索、文章列表和 Markdown 保存命令：

```bash
bycli wechat search <query>
bycli wechat list --fakeid <fakeid> --name <nickname>
bycli wechat save --fakeid <fakeid> --name <nickname> --output-dir <directory>
```

集成采用两步式工作流：先通过 `search` 获取并确认公众号的 `fakeid` 与 `nickname`，再显式调用 `list` 或 `save`。该设计避免按名称自动选择同名或相似公众号。

插件默认从用户当前 Chrome 微信公众平台会话自动获取凭证。用户未登录时，插件打开登录页面并等待用户完成扫码或确认登录。CI 或无浏览器环境可以通过显式 `--auth-source env` 使用环境变量。

插件与 crawler 坚持 CLI 边界：通过安全子进程调用 `wechat-crawler`，不导入 crawler 的内部 JavaScript 模块。

## 2. 非目标

- 不自动选择名称相似的公众号。
- 不持久化 token、Cookie 或 fingerprint。
- 不提供长期凭证缓存、凭证刷新服务或凭证加密存储。
- 不改变 `wechat-crawler` 的抓取、HTML 转换或文件覆盖语义。
- 不在自动化测试中使用或保存真实微信公众平台凭证。
- 不绕过微信公众平台权限、风控或访问限制。

## 3. 交付物

本功能包含两个独立但配套的交付物。

### 3.1 byCLI 核心扩展

byCLI 当前使用静态 `browser: true | false` 决定是否在执行命令前连接浏览器。为了让同一命令默认使用浏览器、但在 `--auth-source env` 时完全跳过浏览器，需要增加条件浏览器能力。

插件侧建议注册形式：

```ts
browser: (args) => args['auth-source'] !== 'env'
```

注册声明与 registry 规范化后的运行时结构必须分离。注册 API 可以接受上述条件函数，但不得把函数直接存入或序列化到命令元数据。规范化结构为：

```ts
type NormalizedBrowserRequirement = true | false | 'conditional'

interface NormalizedCommand {
  browser: NormalizedBrowserRequirement
  requiresBrowser?: (args: unknown) => boolean
}
```

条件声明在 registry 阶段规范化为 `browser: 'conditional'` 与内部 `requiresBrowser` 谓词；静态声明只保留布尔值且没有谓词。`requiresBrowser` 是进程内执行细节，不进入 JSON、manifest 或其他对外序列化合同。

要求：

- 现有静态 `browser: true` 和 `browser: false` 行为保持不变。
- Commander 完成参数解析后，由 execution 层求值 `requiresBrowser(args)`；registry 规范化阶段不得提前求值。
- 条件结果为 `true` 时创建浏览器会话并向命令函数提供 `IPage`。
- 条件结果为 `false` 时不连接 daemon、extension 或 Chrome，并向命令函数提供 `null` page。
- 条件命令函数签名为 `(page: IPage | null, args, debug?)`。
- 条件命令仍显示 `--window`、`--site-session` 和 `--keep-tab` 等浏览器选项。
- `bycli list -f json` 和其他命令元数据序列化器只读取规范化后的 `browser`，输出 `true`、`false` 或 `"conditional"`；不得用 `!!cmd.browser`，也不得序列化 `requiresBrowser`。strategy 保持命令声明的 `COOKIE` 或 `INTERCEPT`。
- help 明确说明 `--auth-source env` 不依赖浏览器。

预计涉及：

```text
src/registry.ts
src/execution.ts
src/commanderAdapter.ts
src/help.ts
src/serialization.ts
src/types.ts
src/browser/page.ts
src/browser/cdp.ts
extension/src/protocol.ts
extension/src/background.ts
```

另需同步 CLI 列表输出、plugin manifest/schema、相关类型、snapshot 与回归测试，确保第三态在所有对外元数据路径中含义一致。

### 3.2 独立插件

插件作为独立仓库或项目发布，名称为 `bycli-plugin-wechat`：

```text
bycli-plugin-wechat/
├── bycli-plugin.json
├── package.json
├── search.ts
├── list.ts
├── save.ts
├── src/
│   ├── auth-session.ts
│   ├── search-biz.ts
│   ├── crawler-process.ts
│   ├── output-mappers.ts
│   └── redact.ts
└── test/
    ├── auth-session.test.ts
    ├── search-biz.test.ts
    ├── crawler-process.test.ts
    ├── commands.test.ts
    └── fixtures/
```

`search.ts`、`list.ts`、`save.ts` 是 byCLI 当前扁平插件发现器可见的根入口；认证、HTTP、crawler 和映射实现保持在 `src/`。发布包必须包含构建后的根入口 JavaScript 与其 `dist/` 依赖，不能要求生产 Node.js 直接加载嵌套 TypeScript。

依赖关系：

```json
{
  "dependencies": {
    "wechat-article-crawler": "1.0.0"
  },
  "peerDependencies": {
    "@sovovs/bycli": ">=2.1.0 <3"
  }
}
```

`wechat-article-crawler@1.0.0` 必须在插件发布前可由 npm 安装；若 crawler 协议发生不兼容变化，插件通过新的 minor/major 版本显式升级依赖。不得使用 `latest`、`*` 或未限定的 Git 分支。

## 4. 命令契约

注册元数据固定为：

| 命令 | access | strategy | browser 条件 |
|---|---|---|---|
| `wechat search` | `read` | `INTERCEPT` | `args['auth-source'] !== 'env'` |
| `wechat list` | `read` | `COOKIE` | `args['auth-source'] !== 'env'` |
| `wechat save` | `write` | `COOKIE` | `args['auth-source'] !== 'env'` |

`save` 会写入本地文件，因此必须声明 `access: 'write'`；另外两个命令不改变微信或本地业务数据。

### 4.1 `wechat search`

```bash
bycli wechat search <query> \
  [--limit 10] \
  [--auth-source browser|env] \
  [-f table|json|yaml|plain|md|csv]
```

默认值：

- `auth-source = browser`
- `limit = 10`
- `limit` 必须为正整数；不得静默截断或修正。

该命令只负责搜索和列出候选公众号，不调用 crawler。输出列按顺序为：

```ts
['nickname', 'fakeid', 'alias']
```

每行结构：

```json
{
  "nickname": "前端之神",
  "fakeid": "Mzg2NjY2NTcyNg==",
  "alias": "Sunshine_Lin_God"
}
```

`alias` 缺失时返回 `null`，不用空字符串或 `"-"`。无结果时抛 `EmptyResultError`。

### 4.2 `wechat list`

```bash
bycli wechat list \
  --fakeid <fakeid> \
  --name <nickname> \
  [--limit N] \
  [--max-pages N] \
  [--auth-source browser|env] \
  [-f table|json|yaml|plain|md|csv]
```

插件调用 crawler 并将 `articles` 映射为行。crawler 的 `publicArticle` 原始字段为 `{ title, url, publishedAt, digest, author }`；`output-mapper` 必须显式重排键，不能依赖原对象插入顺序。byCLI 输出列按顺序为：

```ts
['title', 'author', 'digest', 'publishedAt', 'url']
```

字段缺失统一返回 `null`。`publishedAt` 保持 crawler 给出的 ISO 字符串或 `null`。`list` 不包含 `alias`；`alias` 只属于不经过 crawler 的 `search` 命令输出。

插件不暴露 crawler 的 `--output` 参数，因为 byCLI adapter 的 columns 是静态合同，而 crawler 在文件模式下返回不同的确认结构。需要保存结果时，调用者使用 byCLI 格式化输出和 Shell 重定向，例如 `bycli wechat list ... -f json > result.json`。

### 4.3 `wechat save`

```bash
bycli wechat save \
  --fakeid <fakeid> \
  --name <nickname> \
  --output-dir <directory> \
  [--limit N] \
  [--max-pages N] \
  [--auth-source browser|env] \
  [-f table|json|yaml|plain|md|csv]
```

插件消费 crawler 的真实 envelope：成功项位于 `files[]`，形状为 `{ title, url, path }`；失败项位于 `errors[]`，形状为 `{ stage, title, url, message }`。crawler 不直接提供 `status` 或 `error` 字段，`output-mapper` 必须把两个数组合成为统一行。

输出同时表达成功与失败，列按顺序为：

```ts
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

映射规则固定为：

- `files[]`：`status = 'saved'`、`stage = null`、`error = null`，其余字段取同名字段。
- `errors[]`：`status = 'failed'`、`stage = item.stage`、`path = null`、`error = item.message`，其余字段取同名字段。

部分失败保留所有成功文件和失败明细，并保留 crawler 的退出码 `2`。

## 5. 认证与登录流程

### 5.1 浏览器模式

浏览器模式执行以下状态机：

```text
连接 byCLI 浏览器桥
  → 复用或打开 mp.weixin.qq.com 标签页
  → 判断是否已登录
      ├─ 已登录：继续
      └─ 未登录：前台展示登录页
                    → 等待用户扫码/确认
                    → 轮询登录完成信号
  → 进入图文编辑场景
  → 提取 token
  → 读取限定域名的完整 Cookie
  → search 命令额外捕获 fingerprint
```

“已登录”采用可测试的两阶段判定，不依赖单个脆弱 DOM 选择器：

1. **页面预检信号**：当前页面位于 `mp.weixin.qq.com` 的后台 `/cgi-bin/*` 路径，URL 或页面上下文中存在非空 token，且未重定向到登录页。登录二维码、登录表单等 DOM 只作为“明确未登录”的辅助信号，不能单独证明会话有效。
2. **命令级权威信号**：真正的微信业务请求返回 HTTP 成功、可解析 JSON 且 `base_resp.ret === 0`。`search` 以自身 `search_biz` 请求为准；`list/save` 以 crawler 首次 `appmsgpublish` 请求的校验结果为准，不额外发送 `search_biz` 探针。

页面预检不通过时，插件必须将登录页置于前台并等待用户登录；预检通过只允许进入命令执行，不代表最终认证成功。业务请求返回已知的未登录或会话失效响应时抛 `AuthRequiredError`；其他未知的非零 `base_resp.ret` 保留为 `CommandExecutionError`，不得把所有微信业务错误都误判为需要登录。

实现约束：

- Cookie 必须通过 `page.getCookies({ url: 'https://mp.weixin.qq.com/' })` 获取，以包含 HttpOnly Cookie；禁止使用 `document.cookie`。
- Cookie header 由匹配目标 URL、未过期的 cookie 组成，格式为 `name=value; name2=value2`。
- token 从已登录后台页面的 URL、Referer 等页面上下文提取。不得依赖网络捕获输出中的 token，因为 byCLI 会对捕获 URL 的认证参数脱敏。
- `search` 在页面上下文安装一次性请求观察器后触发真实 `search_biz` 搜索。观察器只从请求 URL 提取 fingerprint 值，不保存或返回完整 URL，并在成功、失败或超时后恢复被包装的 `fetch/XMLHttpRequest`。不得依赖 byCLI 的通用 network capture 读取该值，因为 extension 会在跨桥前将 fingerprint 脱敏。fingerprint 必须与 token、Cookie 来自同一次浏览器会话。
- 登录等待默认超时为 180 秒。超时抛 `TimeoutError`，不无限等待。
- byCLI 核心为 `IPage` 增加 `focusWindow()` 能力。浏览器窗口在需要用户登录时由插件调用该能力置于前台；已登录的正常调用不主动抢占焦点，并继续使用用户指定的窗口模式。

### 5.2 环境变量模式

只有显式传入 `--auth-source env` 才使用环境变量：

```text
search: WECHAT_TOKEN + WECHAT_COOKIE + WECHAT_FINGERPRINT
list/save: WECHAT_TOKEN + WECHAT_COOKIE
```

环境变量不完整时整体失败。禁止用浏览器 token 补环境变量 Cookie，或反向混用。

## 6. `search_biz` 调用

浏览器模式优先使用 `page.fetchJson` 从浏览器上下文调用：

```text
GET https://mp.weixin.qq.com/cgi-bin/searchbiz
```

参数包括：

```text
action=search_biz
scene=1
begin=0
count=<limit>
query=<query>
fingerprint=<captured fingerprint>
token=<captured token>
lang=zh_CN
f=json
ajax=1
```

请求需要 `X-Requested-With: XMLHttpRequest` 和正确 Referer。环境变量模式在 Node.js 进程中发起同等请求，并显式设置完整 Cookie header。

响应必须校验：

- HTTP 状态成功。
- JSON 可以解析。
- `base_resp.ret === 0`。
- `list` 为数组。
- 每个输出行包含非空 `nickname` 和 `fakeid`。

`base_resp.ret !== 0` 时按显式维护并由 fixture 覆盖的认证失效 code/message allowlist 分类：以 code 为主，message 只允许精确匹配规范化后的已知值；命中 allowlist 才抛 `AuthRequiredError`，未命中则抛 `CommandExecutionError`。禁止只凭非零 ret 或模糊字符串包含关系统一判为认证失败。

搜索结果不做自动选择，也不默认取第一项。

## 7. crawler 子进程边界

插件将 `wechat-article-crawler` 作为固定版本运行时依赖，并优先解析插件自身 `node_modules/.bin/wechat-crawler`。不依赖用户全局 PATH 中恰好存在同名 binary。

子进程规则：

- 使用 `spawn` 或 `execFile` 参数数组。
- 禁止 `shell: true`。
- `fakeid`、`name`、limit、路径等非敏感值通过参数数组传递。
- token 和 Cookie 只通过子进程 `env` 注入。
- 只为子进程增加 `WECHAT_TOKEN` 和 `WECHAT_COOKIE`；不修改父进程环境。
- stdout 必须是合法 crawler JSON envelope；解析失败视为命令执行错误。
- stderr 是进度和诊断流。默认捕获但不污染 byCLI 结构化 stdout；`--verbose` 时经脱敏后转发。
- stdout 和 stderr 分别设置容量上限；超限时终止子进程。
- 调用超时或用户取消时终止整个子进程组，避免遗留抓取进程。

退出码映射：

| crawler exit | 含义 | 插件行为 |
|---:|---|---|
| 0 | 成功 | 返回映射后的业务行 |
| 1 | 参数、凭证或微信接口整体失败 | 根据结构化错误区分认证失败与执行失败 |
| 2 | 部分文章下载失败 | 返回成功与失败行，并保留 exit 2 |
| 3 | 结果或 Markdown 写盘失败 | 抛 `CommandExecutionError`；错误消息或 hint 明确包含 `wechat-crawler exited with code 3` |

## 8. 错误模型

本设计复用 byCLI `src/errors.ts` 已存在的 CLI typed errors 与退出码，不新增 `ErrorCode`：`ArgumentError/ARGUMENT=2`、`EmptyResultError/EMPTY_RESULT=66`、`BrowserConnectError/BROWSER_CONNECT=69`、`TimeoutError/TIMEOUT=75`、`AuthRequiredError/AUTH_REQUIRED=77`、`CommandExecutionError/COMMAND_EXEC=1`。这些 CLI 错误与 recorder/dashboard/backend envelope 使用的另一套小写 `ErrorCode` 联合类型不是同一合同，因此本次不修改 `adapter-recorder.bundle.json`、`recorder.ts` 或 backend envelope；若实施中确需新增错误类型，必须另行核对并同步全部消费者。

现有 `CommandExecutionError` 没有可承诺的任意 `details` 载荷，因此插件不得依赖或新增 `crawlerExitCode` details；crawler 退出码只进入脱敏后的 message/hint 和测试断言。

| 场景 | byCLI 类型 | exit |
|---|---|---:|
| 参数缺失、格式错误、非正整数 | `ArgumentError` | 2 |
| 搜索没有候选公众号 | `EmptyResultError` | 66 |
| 环境变量凭证缺失 | `AuthRequiredError` | 77 |
| 微信明确返回未登录或会话失效 | `AuthRequiredError` | 77 |
| 用户登录等待超时 | `TimeoutError` | 75 |
| 浏览器桥不可用 | `BrowserConnectError`，提示执行 `bycli doctor` | 69 |
| HTTP、JSON、微信业务响应或 crawler 协议异常 | `CommandExecutionError` | 1 |
| crawler 写盘失败 | `CommandExecutionError` | 1 |

禁止：

- 用空数组表示认证失败或接口变化。
- 返回伪造的错误行代替 typed error。
- 对 limit、maxPages 或 timeout 静默 clamp。
- 用 `"-"`、`"N/A"` 或空字符串代替可空值。

部分失败时，插件函数先返回完整的 saved/failed 行，并设置 `process.exitCode = 2`。byCLI 当前成功渲染路径不会覆盖该值，因此结构化输出仍会完成，而调用方可从退出码识别部分成功；该行为必须由集成测试锁定。

## 9. 安全与脱敏

敏感数据包括：

```text
token
Cookie
fingerprint
slave_sid
data_ticket
bizuin
cert
rand_info
```

安全要求：

- 敏感值只存在于单次命令内存和 crawler 子进程环境中。
- 不写入插件配置、byCLI cache、site memory、fixture、trace、日志、错误 details 或命令输出。
- 插件构造单次命令 secret set：完整 token、fingerprint、完整 Cookie header、每个 Cookie value，以及这些值的 URL 编码形式。错误消息和 verbose stderr 在输出前使用该集合执行原值、URL 编码值和常见 header 形式的二次脱敏。
- crawler 自身当前只按完整 token 与完整 Cookie 做脱敏，范围窄于插件的敏感清单；插件转发 stderr 或包装 crawler 错误时不得假设 crawler 输出已经安全，仍须执行上述二次脱敏。
- 网络 trace 保留前必须删除或替换敏感请求头与参数。
- byCLI 核心的 `src/observation/redaction.ts` 与 extension 的 `extension/src/url-redact.ts` 必须把 `fingerprint` 加入认证参数集合；否则 `search_biz?...&fingerprint=...` 仍可能进入 trace。两处规则及其序列化产物均需回归测试。
- 不把 Cookie 放入进程参数、Shell 命令或调试命令示例。
- 命令结束后释放浏览器 lease；如果是为登录创建的临时标签页，按 byCLI 的 keep-tab 语义决定是否关闭。
- 凭证泄露时，文档提示用户退出微信公众平台并重新登录，使旧会话失效。

## 10. 测试策略

### 10.1 byCLI 核心测试

- 静态 `browser: true/false` 行为不回归。
- 条件函数在参数解析后执行。
- `auth-source=env` 不创建浏览器会话。
- `auth-source=browser` 创建浏览器会话并传入 `IPage`。
- 条件命令的 help 包含浏览器 flags。
- `bycli list -f json` 输出 `browser: "conditional"`。
- 条件谓词不进入 JSON/manifest；静态布尔值和 `"conditional"` 均不被真值强转破坏。
- 条件函数抛错时映射为参数或命令执行错误，不启动 adapter。
- observation 与 extension URL 脱敏均覆盖 `fingerprint` 的原值和 URL 编码值，trace/fixture 中不得出现秘密原文。

### 10.2 插件单元测试

认证：

- 已登录会话直接复用。
- 未登录后成功登录。
- 后台 URL、非空 token、非登录页构成页面预检通过；二维码/登录表单与登录重定向构成预检失败。
- 页面预检通过但首次业务请求认证失效时仍抛 `AuthRequiredError`。
- 登录等待超时。
- Cookie 包含 HttpOnly 字段。
- 过期或非目标域 Cookie 被过滤。
- token 和 fingerprint 正确提取。
- 环境变量缺失。
- 两种来源不会混用。

搜索：

- query URL 编码。
- fingerprint 透传。
- 微信成功响应映射。
- 空结果抛 `EmptyResultError`。
- 已知认证失效 `base_resp.ret/message` 映射为 `AuthRequiredError`，未知非零响应映射为 `CommandExecutionError`。
- 相似名称全部返回，不自动选择。

子进程：

- 使用参数数组且禁用 shell。
- 凭证只进入子进程 env。
- stdout JSON envelope 解析。
- stderr 脱敏。
- crawler 仅脱敏 token/Cookie 后，插件仍能清除 fingerprint、单个 Cookie value 及 URL 编码形式。
- 输出容量上限。
- 超时和取消时终止进程组。
- crawler 退出码 0、1、2、3 的映射；浏览器连接失败保持 `BrowserConnectError`/69。

输出：

- `search/list/save` columns 名称、顺序和返回 key 完全一致。
- 可空字段为 `null`。
- `list` mapper 从 crawler 字段重排为静态列且不生成 `alias`。
- `save` mapper 从 `files[]` 与 `errors[]` 合成 saved/failed 行，`errors[].message` 映射到 `error`，`errors[].stage` 得到保留。
- `save` 部分失败同时包含 saved 和 failed 行。

### 10.3 集成与 E2E

- 安装插件声明的真实 `wechat-crawler` binary，以 mock HTTP 验证 CLI 契约；测试不得访问微信生产接口。
- 本地受控 E2E 验证真实 Chrome 登录、`search_biz` 捕获和 Cookie 读取。
- 浏览器 E2E 不进入普通 CI，不保存真实凭证或原始网络响应。
- verify fixture 只包含脱敏后的合成响应，并设置非空行数、fakeid 格式与核心列断言。

## 11. 验收场景

### 11.1 浏览器搜索

```bash
bycli wechat search 前端之神 -f json
```

未登录时打开登录界面；登录后返回至少包含 `nickname`、`fakeid`、`alias` 的候选行，输出中无凭证。

### 11.2 浏览器抓取列表

```bash
bycli wechat list \
  --fakeid 'Mzg2NjY2NTcyNg==' \
  --name '前端之神' \
  --limit 3 \
  -f json
```

返回不超过 3 篇文章，stdout 是可解析 JSON，进度不污染 stdout。

### 11.3 保存 Markdown

```bash
bycli wechat save \
  --fakeid 'Mzg2NjY2NTcyNg==' \
  --name '前端之神' \
  --output-dir ./articles \
  --limit 3 \
  -f json
```

每篇成功文章生成 Markdown，输出逐条列出状态和绝对路径。

### 11.4 无浏览器环境变量模式

```bash
WECHAT_TOKEN='...' WECHAT_COOKIE='...' \
  bycli wechat list \
  --auth-source env \
  --fakeid 'Mzg2NjY2NTcyNg==' \
  --name '前端之神' \
  --limit 3 \
  -f json
```

命令不连接 daemon 或 Chrome，直接通过 crawler CLI 完成抓取。

### 11.5 部分失败

当一篇文章下载失败而其他文章成功时，已成功 Markdown 保留，输出同时包含 `saved` 与 `failed` 行，进程退出码为 2。

## 12. 实施顺序

1. 先扩展 byCLI observation 与 extension URL 脱敏规则，覆盖 `fingerprint`，并用 trace 回归测试锁定。
2. 建立最小插件骨架与测试 harness，然后定义并测试页面预检、命令级权威登录判据和认证失效 allowlist。
3. 按 crawler 真实 `files[]`/`errors[]` envelope 实现 `save` 合成映射，并补齐 `list` 重排测试。
4. 锁定浏览器桥失败为既有 `BrowserConnectError`/69，不降级为通用执行错误。
5. 移除任意 error details 的实现假设，以脱敏后的 message/hint 表达 crawler exit 3。
6. 在实现和测试中明确复用 CLI typed errors，不改 recorder/dashboard/backend 的另一套 `ErrorCode` 合同。
7. 为 byCLI 增加条件浏览器注册能力，同时把运行时谓词与可序列化的 `browser: 'conditional'` 元数据分离。
8. 在独立的 `bycli-plugin-wechat` 中完成认证、`search_biz`、安全子进程、`list/save` 命令和依赖约束的集成。
9. 完成单元、集成、verify 与受控浏览器 E2E，并编写安装、登录、CI、凭证失效和安全说明。
