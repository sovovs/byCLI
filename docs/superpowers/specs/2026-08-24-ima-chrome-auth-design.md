# ima Chrome 短时认证代理设计

## 目标

让 `bycli ima knowledge <名称或ID> -f json` 通过已登录 Chrome 中的
`ima.qq.com` 页面读取知识库，而不读取 macOS 钥匙串、不解析本地 Cookie 数据库，
也不将 `IMA-TOKEN`、refresh token、`x-ima-cookie` 或 `x-ima-bkn` 写入环境变量、
文件、日志或命令输出。

## 范围

- 完全移除 ima 适配器的 macOS Keychain、`security` 命令和 SQLite Cookie 解密路径。
- Chrome 必须已登录 ima，且存在一个 `https://ima.qq.com/wikis` 或知识库详情标签页。
- 适配器仅允许使用 `knowledge_tab_reader` 的只读知识库列表与内容接口。
- 保持既有 JSON 字段、文件夹递归、分页完整性检查和 URL 规范化行为。

不在范围内：持久保存网页凭据、导出凭据、修改知识库、自动登录 Chrome，或把
浏览器 Cookie 返回给用户/模型。

## 架构

命令入口改为浏览器认证 reader。它向 bycli 的本地浏览器桥请求一个受限的
`ima` 会话：桥创建一个 bycli 自有标签页，导航到已登录 Chrome profile 中的
`https://ima.qq.com/wikis`，监听且仅监听
`/cgi-bin/knowledge_tab_reader/` 的 Fetch/XHR 请求。捕获到页面自身请求中的
`x-ima-cookie` 与 `x-ima-bkn` 后，桥在内存中使用这些头，且在同一个
`ima.qq.com` 页面上下文调用同域只读接口，并仅将业务响应返回给命令。

认证头绝不作为通用 network-capture 数据、CLI 返回值或 JSON 输出的一部分。会话在
命令结束或失败时被清除。

## 数据流

```text
bycli ima knowledge
  -> 创建 bycli 自有的 ima Chrome 标签页（复用已登录 profile）
  -> 捕获一次 ima 页面自身的 reader API 请求
  -> 仅在扩展/本地桥内存保留认证头
  -> 在同源页面请求 get_knowledge_base_list
  -> 在同源页面请求并递归分页 get_knowledge_list
  -> 返回文章业务数据
  -> 输出 JSON，并销毁认证上下文
```

捕获阶段必须由页面的已有数据加载或一次受控刷新触发；若在超时时间内没有出现匹配
请求，命令返回明确的配置错误，提示用户打开已登录的 ima 知识库页面后重试。

## 安全边界

- 仅接受 `https://ima.qq.com` 的标签页和 reader API 路径。
- 只提取 `x-ima-cookie`、`x-ima-bkn`、`extension_version`、`from_browser_ima` 及必要的
  同源请求上下文；不读取或导出全量 Cookie/Local Storage。
- 禁止将认证头传入普通网络录制、trace、错误文本或调试日志。
- 禁止跟随跨域重定向；请求保持 30 秒超时。
- 捕获到的头在命令结束后清零；后续命令必须重新从 Chrome 获取。

## 失败处理

- 未连接浏览器、未找到 ima 标签页或标签页未登录：配置错误，提示打开并登录
  `https://ima.qq.com/wikis`。
- 没有捕获到 reader 请求：配置错误，提示刷新知识库页后重试。
- 捕获的头缺少 `x-ima-cookie` 或 `x-ima-bkn`：配置错误，不发起 API 请求。
- reader API 返回非零状态、分页 cursor 重复或缺失：失败关闭，不返回部分结果。
- Chrome 连接中断、跨域重定向或网络超时：命令执行错误，认证材料立即丢弃。

## 测试与验收

- 单元测试覆盖：可信 ima reader 请求的认证头提取、非 ima/非 reader 请求拒绝、缺失头、
  认证材料不进入任何可序列化结果、请求超时和跨域重定向拒绝。
- 现有知识库递归和 URL 提取测试继续通过，且不再依赖 macOS。
- 在已登录 Chrome 的“企业级AI应用落地实践”页面做真实只读验证：导出 195 篇文章和
  195 个 URL，按 root/四个文件夹的分布与既有结果一致。
