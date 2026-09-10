# 浩鲸邮箱（iwhalecloud）

读取 [mail.iwhalecloud.com](https://mail.iwhalecloud.com/) 的邮件列表、完整正文和文件附件。
先在连接 Browser Bridge 的 Chrome/Chromium 中登录邮箱，运行 `bycli doctor` 确认连接正常。
命令复用浏览器登录态，无需在命令行填写密码或导出 Cookie。

## 邮件列表

```bash
bycli iwhalecloud list -f yaml
bycli iwhalecloud list --sort date --order desc --limit 100 -f json
bycli iwhalecloud list --sort size --order desc --limit 20 -f yaml
bycli iwhalecloud list --folder sent --sort sent --order asc -f yaml
bycli iwhalecloud list --offset 100 --limit 100 -f json
```

`--limit` 默认为 20，范围 1–10000，自动以最多 100 封一页读取；`--offset` 从 0 开始。
排序由服务器在分页前执行，不是取出一页后在本地排序。
返回单封邮件，每封的 `emailId` 可直接交给 `read` 和 `download`；网页的对话视图可能合并多封邮件。

| `--sort` | 排序依据 | 省略 `--order` 时 |
|---|---|---|
| `default` | 保留服务器默认顺序，不传排序条件 | 由服务器决定 |
| `date` | 收件时间 | 降序 |
| `from` | 发件人 | 升序 |
| `to` | 收件人显示名称 | 升序 |
| `subject` | 主题 | 升序 |
| `attachments` | 是否含附件 | 有附件优先 |
| `importance` | 重要性 | 高优先 |
| `size` | 邮件大小 | 大优先 |
| `sent` | 发件时间 | 降序 |
| `created` | 创建时间 | 降序 |

除 `default` 外均可指定 `--order asc` 或 `--order desc`。
相同排序值按收件时间降序排列。`default` 表示 API 的默认顺序，不读取或修改网页保存的个人排序偏好；
本次实测默认按最新收件在前。服务器不支持的已读状态、修改时间排序不在选项中。

`--folder` 支持 `inbox`（默认）、`sent`、`drafts`、`trash`、`spam`。
已知自定义文件夹的 OWA FolderId 时，可传 `--folder-id "<FolderId>"`，它优先于 `--folder`。
分页期间若邮箱变化导致重复邮件或偏移停滞，命令会报错，避免悄悄返回不完整数据；请重新查询。

输出包括主题、发件人姓名/地址、收件人显示名称、收件/发件/创建时间、未读状态、附件标识、重要性、大小和 URL。
`date` 为收件时间，`times` 包含 `sentAt`（发件）和 `createdAt`（创建）。
时间保留服务器的 ISO 8601 时区信息，`size` 单位为字节。

## 邮件详情

```bash
bycli iwhalecloud read "<emailId>" -f yaml
bycli iwhalecloud read "<emailId>" --body-type html -f json
```

默认返回文本正文；`--body-type html` 返回 HTML 字符串。详情还包含 `to`、`cc`、`bcc`、
`recipientCounts` 和 `attachments`。每个附件包含 `index`、`attachmentId`、文件名、内容类型、大小、内嵌标识和附件类型。
收件人仅返回当前账号可见的信息；密送字段不可见时为空。
收件人请求上限为 10000，超大型收件人列表可对照 `recipientCounts` 检查。

读取使用 GetItem，不发送“标记已读”或已读回执请求。受保护的邮件若无法取得完整正文会明确报错。
邮件 ID 含 `+`、`/`、`=` 等字符，请始终加引号；移动或删除后的旧 ID 可能失效。

## 附件下载

```bash
# 下载所有非内嵌文件附件
bycli iwhalecloud download "<emailId>" --output ./mail-downloads -f yaml

# 指定详情中的附件序号或 attachmentId
bycli iwhalecloud download "<emailId>" --attachment 1 --output ./mail-downloads -f yaml
bycli iwhalecloud download "<emailId>" --attachment "<attachmentId>" --output ./mail-downloads -f json
```

`--attachment` 默认为 `all`，不包含正文内嵌图片；需要内嵌文件时可显式指定它的序号或 ID。
目前支持 `FileAttachment`，不支持嵌套邮件 `ItemAttachment` 和云引用附件；遇到不支持的类型会提示单独选择文件附件。

`--output` 是目录，默认当前目录。保留中文文件名，清理路径字符，同名文件自动添加编号，不覆盖已有文件。
下载通过已登录的浏览器分块传输，再写入本地，不依赖 Node 对企业证书链的识别，也不关闭证书验证。
输出包含本地绝对路径和实际下载字节数；服务器元数据中的附件大小可能与下载文件不同。
单附件请求超时为 120 秒。中断时删除当前未完成文件，保留已经下载成功的附件，并在错误中说明。

## 验证与实现

2026-09-10 已在本站 Exchange 15.2 环境验证默认排序、9 个字段的双向排序、跨页读取、详情及 PDF 附件下载。
请求通过本站 OWA `service.svc` 的 `FindItem`、`GetItem` 和 `GetFileAttachment` 完成。
`list` 和 `download` 可通过 `bycli browser <session> verify`。`read` 有意返回完整的嵌套收件人和附件对象，
目前会触发该检查器的“最多 12 个顶层字段、嵌套深度最多 1、ID 必须位于顶层”限制；
这不影响命令执行，详情通过适配器单元测试及真实 CLI 读取核验。建议使用 `-f json` 或 `-f yaml` 查看详情，避免表格截断。
排序和分页语义可参阅 Microsoft 的 [SortOrder](https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/sortorder)
与 [FindItem](https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/finditem) 文档；OWA JSON 协议以本站实测为准。
