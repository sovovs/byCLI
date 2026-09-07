# IMA 原始文件下载设计

## 目标

新增通用命令 `bycli ima download`，从已登录的 IMA 客户端/浏览器会话中获取知识库文件的签名原始地址并下载到本地。首个验收对象为 `trustgraph analyze.pdf`，但接口不限制为 PDF。

## 命令接口

```bash
bycli ima download <knowledgeBase> <file> [--output <path>] [--media-id <id>]
```

- `<knowledgeBase>`：知识库完整名称或 ID。
- `<file>`：文件标题；若指定 `--media-id`，允许省略或用于消歧。
- `--output`：目标文件路径或目录；默认使用当前目录并保留原文件名。
- `--media-id`：按 IMA `mediaId` 精确定位文件。
- 输出包含本地路径、内容类型、字节数、SHA-256；PDF 额外输出页数。

## 数据流

1. 通过现有 IMA reader 认证流程定位知识库及文件条目。
2. 从已登录 IMA 客户端的 PDF/文件查看器页面读取 `originUrl`（或等价的签名源地址）。
3. 校验地址域名和路径属于 IMA 资源域，拒绝不受信任的外部地址。
4. 使用现有下载工具写入目标路径，禁止把摘要、导语或封面预览当作原文件。
5. 校验响应 MIME、文件大小；PDF 使用 PDF 解析器校验页数和文件头。

## 错误与回退

- 无已登录客户端、无法打开查看器或未发现签名地址：返回明确错误 `IMA_ORIGINAL_URL_UNAVAILABLE`，不报告下载完成。
- 文件标题匹配多个条目：要求使用 `--media-id` 精确定位。
- 地址过期或下载失败：返回下载错误，不生成成功产物。
- 非 PDF 文件：执行通用 MIME/大小/哈希校验，跳过页数校验。
- 现有 `ima knowledge` 行为保持不变，仍只返回元数据和节选。

## 测试策略

- 单元测试：文件定位、标题/`mediaId` 消歧、签名 URL 提取、受信域校验、输出路径和校验结果。
- 集成测试：模拟 IMA viewer 页面暴露签名 `originUrl`，下载一个 24 页 PDF fixture，并验证 MIME、大小、哈希和页数。
- 回归测试：确认 `knowledge` 与 `knowledge-list` 输出结构不变；无签名地址时状态为失败而非完成。

## 非目标

- 不修改 IMA 云端文件。
- 不绕过登录、权限或签名校验。
- 不默认下载知识库中的全部文件。
- 不把 IMA 内部 `sourcePath` 直接拼接成未经授权的公网 URL。
