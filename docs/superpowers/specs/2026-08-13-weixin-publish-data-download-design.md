# Weixin 发表数据明细下载设计

日期：2026-08-13

状态：设计已获用户批准，待书面规格复核。

## 背景

微信公众号后台的“发表记录”列表包含文章标题、发布日期、原文 URL、通知结果，以及阅读、点赞、分享、推荐、留言、划线和转载等实时人数。每条记录还提供“发表数据”入口，进入单篇内容分析页后可通过“下载数据明细”取得 `.xls` 文件。

真实浏览器侦察确认：发表记录由已登录的 `mp.weixin.qq.com` JSON 接口返回，核心列表封装在 `publish_page` 字段中；单篇内容分析页由文章的内部消息 ID、条目序号和发布日期定位；“下载数据明细”是在详情页地址上追加 `download=1` 的直接文件下载，不需要创建或轮询异步导出任务。

## 目标

- 提供一个只读命令，分页获取并结构化输出发表记录，供人和 Agent 检索。
- 提供一个下载命令，根据用户输入的文章标题或原文 URL 匹配唯一发表记录，并下载该文章的数据明细 `.xls`。
- 匹配失败或存在歧义时明确报错，不猜测文章，也不下载错误文件。
- 复用浏览器中的微信公众号登录态，不持久化 Token、Cookie 或 fingerprint。
- 下载完成后返回可验证的文件路径、文件大小和状态。

## 命令设计

### `bycli weixin published`

读取发表记录，支持以下参数：

- `query`：可选的位置参数，按标题或原文 URL 过滤记录。
- `--limit <n>`：最多返回的文章数，默认 `10`。
- `--max-pages <n>`：最多扫描的列表页数，默认 `5`。

每行严格按以下顺序返回字段：

1. `title`：文章标题。
2. `publishedAt`：标准化为 `YYYY-MM-DD` 的发布日期。
3. `url`：公开文章 URL。
4. `notified`：通知成功人数。
5. `failed`：通知失败人数。
6. `reads`：阅读人数。
7. `likes`：点赞人数。
8. `shares`：分享人数。
9. `recommends`：推荐人数。
10. `comments`：留言条数。
11. `underlines`：划线人数。
12. `reprints`：转载次数。

内部解析还保留 `msgid`、`itemIdx` 和 `publishDate`，用于生成发表数据页地址，但这些鉴权或路由细节不作为默认输出列暴露。

### `bycli weixin download-publish-data <query>`

使用与 `published` 相同的列表源查找文章，支持以下参数：

- `query`：必填的位置参数，可为完整文章 URL 或标题文本。
- `--date <YYYY-MM-DD>`：可选发布日期，用于消除同名文章歧义。
- `--output <directory>`：保存目录，默认 `./weixin-publish-data`。
- `--max-pages <n>`：最多扫描的列表页数，默认 `5`。
- `--timeout <seconds>`：等待浏览器下载完成的最长时间，默认 `60`。

成功时返回：

1. `title`
2. `publishedAt`
3. `url`
4. `status`
5. `path`
6. `size`

文件沿用微信响应给出的安全文件名；若目标目录中已有同名文件，则采用不覆盖的唯一文件名。

## 匹配规则

匹配顺序固定且可预测：

1. 规范化 URL 后进行完整 URL 匹配，忽略无关的 fragment 和追踪查询参数。
2. 对标题进行去除首尾空白和连续空白归一化后，执行完整标题匹配。
3. 没有完整匹配时，执行标题包含匹配。
4. 提供 `--date` 时，在上述每一步中同时要求发布日期相同。

任何阶段只得到一条记录即成功。零条记录抛出 `EmptyResultError`，说明扫描页数和查询条件；多条记录抛出 `ArgumentError`，列出有限数量的候选标题、发布日期和 URL，要求用户使用完整 URL 或补充 `--date`。命令不得默认选取第一条或最新一条。

## 数据流

1. 使用 Browser Bridge 打开微信公众号后台首页并确认登录态。
2. 从当前页面取得临时会话路由参数，仅在本次进程内使用。
3. 请求发表记录 JSON 接口，分页解析 `publish_page` 中的文章记录和指标。
4. `published` 将解析结果裁剪到 `--limit` 后输出。
5. `download-publish-data` 使用确定性的匹配规则解析唯一文章。
6. 根据匹配记录的内部消息 ID、条目序号和发布日期构造单篇内容分析页 URL。
7. 导航到内容分析页，验证标题和文章标识与匹配记录一致。
8. 定位该页的“下载数据明细”链接，验证链接仍属于 `mp.weixin.qq.com`、参数包含匹配记录标识且 `download=1`。
9. 触发下载并使用 Browser Bridge 下载观察器等待完成。
10. 将完整文件移动到 `--output`，采用独占命名避免覆盖，然后返回结构化结果。

## 模块边界

- `published.js` 只定义列表命令和输出映射。
- `download-publish-data.js` 只定义下载命令、参数和最终结果。
- `_wechat/publish-records.js` 负责分页请求、响应解析、日期与指标标准化、文章匹配和详情 URL 构造。
- `_wechat/publish-download.js` 负责详情页一致性校验、下载链接校验、等待下载和安全移动文件。

共享模块不持有浏览器会话，不读取全局状态；页面对象和参数均由命令显式传入。现有 `articles`、`save-articles`、`download`、`drafts` 和 `create-draft` 行为不变。

## 错误与安全

- 未登录或会话过期时抛出 `AuthRequiredError`。
- 参数格式、负数页数、无效日期和歧义匹配使用 `ArgumentError`。
- 列表为空或找不到文章使用 `EmptyResultError`。
- 接口返回异常、详情页标识不一致、下载链接跨域、下载超时、文件缺失或文件移动失败使用相应的 `CommandExecutionError` 或 `TimeoutError`。
- 不把登录页、HTML 错误页或零字节文件当作成功下载。
- 仅接受 `https://mp.weixin.qq.com/` 下的发表记录、详情和下载地址。
- 错误、trace、fixture 和站点记忆中不得包含真实 Token、Cookie、fingerprint 或用户私有响应正文。
- 输出目录采用规范化绝对路径；创建目录时不覆盖已有文件，不允许文件名逃逸目标目录。

## 测试策略

实现严格采用测试驱动开发：每个行为先写失败测试并确认失败原因正确，再写最小实现。

单元测试覆盖：

- 从脱敏的 `publish_page` fixture 解析单篇、多篇和多图文记录。
- 指标缺失时使用语义正确的 `null`，不把未知值静默写成 `0`。
- URL 完整匹配、标题完整匹配、唯一包含匹配和日期消歧。
- 零匹配与多匹配的 typed error 及候选摘要。
- 详情 URL 和 `download=1` 下载 URL 构造。
- 详情页文章标识不一致、跨域下载链接和零字节文件被拒绝。
- 下载完成后安全移动、同名文件独占命名和结构化结果映射。
- `columns` 与返回对象的字段名及顺序严格一致。

验证流程覆盖：

- 运行新增命令的定向 Vitest 测试。
- 运行全部 `clis/weixin/**/*.test.js`。
- 运行 `bycli validate weixin`、类型检查、构建和 `git diff --check`。
- 使用真实已登录浏览器运行 `bycli browser verify weixin/published` 并生成脱敏 verify fixture；`weixin/download-publish-data` 使用 `--no-fixture --seed-args` 验证，避免把必填的私有文章 URL 或标题持久化。
- 肉眼比对至少一篇文章的标题、发布日期和页面指标，并确认下载文件为非零 `.xls`。

## 非目标

- 不解析或转换 `.xls` 内容为 CSV、JSON 或数据库记录。
- 不批量下载全部文章的数据明细；本设计每次只下载唯一匹配的一篇。
- 不获取超过微信单篇内容分析页所提供的 30 天统计窗口。
- 不修改、删除、发表、置顶或调整文章可见性。
- 不新增环境变量认证路径；首版只使用真实浏览器登录态。
