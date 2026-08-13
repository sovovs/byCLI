# Weixin 合集列表与编辑详情设计

日期：2026-08-13

状态：设计已获用户批准，待书面规格复核。

## 背景

微信公众号后台的“内容管理 → 合集”提供合集列表，并允许从每条合集记录进入编辑页查看完整配置。现有 byCLI `weixin` adapter 已能复用 Browser Bridge 中的微信公众号登录态，但尚未提供结构化读取合集及其编辑信息的命令。

本功能新增两个只读命令：第一个列出合集并返回稳定的 `collectionId`；第二个使用该 ID 读取对应编辑页的完整业务信息。二者保持显式串联，避免按名称猜测合集。

## 目标

- 分页读取当前微信公众号账号下的合集列表。
- 为每条列表记录返回可供后续命令使用的稳定 `collectionId`。
- 根据 `collectionId` 读取合集编辑页中的全部稳定业务字段。
- 复用当前浏览器登录态，不持久化 Token、Cookie 或其他临时凭据。
- 对接口和字段进行真实浏览器验证，并用脱敏 fixture 建立回归保护。

## 命令设计

### `bycli weixin collections`

读取合集列表，支持：

- `--limit <n>`：最多返回的合集数，默认 `20`。
- `--max-pages <n>`：最多扫描的列表页数，默认 `5`。

输出列按以下顺序排列：

1. `collectionId`：微信后台用于定位合集编辑记录的稳定 ID。
2. `name`：合集名称。
3. `description`：合集简介；缺失时为 `null`。
4. `coverUrl`：封面地址；缺失时为 `null`。
5. `contentCount`：合集包含的内容数量；接口没有可靠值时为 `null`。
6. `status`：接口或页面提供的稳定状态；没有明确状态时为 `null`。
7. `updatedAt`：可可靠解析的更新时间；缺失时为 `null`。

侦察若发现额外稳定且对定位或判断合集有直接价值的列表字段，可在实现前更新本规格；临时路由参数、Token 和内部调试字段不得输出。

### `bycli weixin collection-detail <collectionId>`

`collectionId` 是必填位置参数，直接使用 `collections` 返回的值，不支持按名称模糊匹配。

输出一行合集详情，列按以下顺序排列：

1. `collectionId`
2. `name`
3. `description`
4. `coverUrl`
5. `status`
6. `updatedAt`
7. `contents`

`contents` 是保持顺序的 JSON 兼容数组。每项仅保留可稳定识别的业务字段，包括内容 ID、标题、封面、排序位置，以及编辑页明确提供的其他只读状态。缺失的可选标量使用 `null`，缺失的内容列表使用空数组；不得用空字符串或 `0` 掩盖未知值。

如果编辑页还提供不属于内容列表的稳定设置，例如展示样式或明确的排序配置，则以一个或多个语义清晰的顶层字段输出，并同步更新 `columns`、文档和 fixture。页面框架状态、埋点数据和鉴权字段不属于业务输出。

## 录制与数据源策略

采用 API 优先、页面状态降级的策略：

1. 用 Browser Bridge 打开微信公众号后台并确认已登录。
2. 进入“内容管理 → 合集”，观察列表加载和打开编辑页时产生的网络请求。
3. 若存在可在同一登录会话中稳定复现的 HTTP/JSON 接口，列表和详情均直接请求该接口。
4. 若列表接口稳定但详情接口依赖无法可靠复现的动态签名，列表仍走 API，详情导航到编辑页后读取页面初始状态。
5. 只有结构化接口和页面状态都不可用时，详情才降级为 DOM 提取；不会把纯 UI 点击作为首选实现。

候选接口必须直接验证为成功响应并包含目标数据。字段映射至少与网页中的一个真实合集逐项核对，不能仅凭字段名称猜测。

## 数据流与模块边界

- `clis/weixin/collections.js` 定义列表命令、参数和最终输出映射。
- `clis/weixin/collection-detail.js` 定义详情命令、参数和最终输出映射。
- `clis/weixin/_wechat/collections.js` 负责列表分页、详情请求或页面状态读取、字段标准化与 ID 校验。
- 现有 `_wechat/auth-session.js` 继续负责从 Browser Bridge 获取当前会话；新模块不自行持久化凭据。

列表命令获取临时会话信息后分页读取记录，按 `limit` 截断并返回。详情命令校验 `collectionId`，读取唯一合集，验证响应中的 ID 与输入一致，再投影为稳定输出。

共享模块不持有跨命令全局状态。请求参数、页面对象和凭据均由调用方显式传入，便于使用 fixture 独立测试解析逻辑。

## 错误处理与安全

- 空白或格式不合法的 `collectionId`、非正整数参数使用 `ArgumentError`。
- 未登录、登录过期或返回登录页使用 `AuthRequiredError`。
- 合集列表为空或指定 ID 不存在使用 `EmptyResultError`。
- 接口异常、响应结构失效、详情 ID 不一致或 DOM 无法可靠解析使用 `CommandExecutionError`。
- 等待页面或接口超时使用 `TimeoutError`。
- 不静默返回空结果，不生成 sentinel 行，也不把未知字段强制写成 `0`。
- 只接受 `https://mp.weixin.qq.com/` 下的导航和请求地址。
- Token、Cookie、fingerprint、用户私有正文及可识别账号的信息不得进入提交的 trace、fixture、测试快照或错误消息。

## 测试与验证

实现采用测试驱动开发，每项行为先写失败测试，再完成最小实现。

单元测试覆盖：

- 单页和多页合集列表解析、分页终止及 `limit` 截断。
- `collectionId`、名称、简介、封面、数量、状态和时间字段映射。
- 可选字段缺失时保持正确的 `null`，不把未知数值写成 `0`。
- 详情响应的 ID 一致性检查。
- 内容数组保持页面顺序，并正确映射内容 ID、标题、封面和排序。
- 非法参数、空列表、合集不存在、鉴权失效和响应结构变更对应正确的 typed error。
- 两个命令的 `columns` 与返回对象字段及顺序完全一致。

集成验证覆盖：

- 运行新增命令的定向测试与全部 `clis/weixin/**/*.test.js`。
- 运行 `bycli validate weixin`、类型检查、构建和 `git diff --check`。
- 使用真实登录浏览器执行 `bycli browser verify weixin/collections`，写入并收紧脱敏 fixture。
- 从列表选择一个 `collectionId` 执行 `bycli browser verify weixin/collection-detail`，写入并收紧脱敏 fixture。
- 肉眼核对同一合集在列表、编辑页和命令输出中的名称、简介、封面、内容数量及内容顺序。

## 文档与站点记忆

- 更新 `docs/adapters/browser/weixin.md`，加入两个命令、参数、输出字段和串联示例。
- 在验证通过且完成肉眼核对后，将脱敏的 endpoint、字段映射、验证规则和本次发现的站点行为写入 `~/.bycli/sites/weixin/`。
- 原始响应样本只能存放于 `~/.bycli/sites/weixin/fixtures/` 或 `/tmp/`，不得提交真实账号数据。

## 非目标

- 不创建、编辑、删除、发布或调整合集。
- 不根据名称自动选择合集。
- 不批量抓取合集内文章正文或统计数据。
- 不绕过微信登录、验证码、风险控制或权限限制。
- 首版不新增环境变量鉴权路径，只支持真实浏览器登录态。
