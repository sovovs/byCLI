# 今日头条公开站内搜索设计

## 目标

为 `toutiao` 适配器增加公开站内搜索命令 `bycli toutiao search <query>`，无需登录即可获取今日头条搜索结果，并尽可能保留上游返回的内容与互动指标。

## 方案

搜索命令直接请求今日头条公开搜索接口，避免依赖浏览器和登录态。适配器负责：

- 校验并编码搜索关键词；
- 支持 `--limit` 参数，范围为 1–50，默认返回 20 条；
- 将上游结果归一化为稳定字段；
- 上游缺失或无法解析的字段返回 `null`，不因单个字段缺失丢弃结果；
- 对 HTTP、JSON、上游错误和空结果返回现有 byCLI 类型化错误。

## 输出字段

至少包含以下字段：

`rank`、`title`、`url`、`source`、`publish_time`、`summary`、`image_url`、`like_count`、`comment_count`、`share_count`、`read_count`。

字段名称保持 snake_case，并对数字字段统一输出非负整数或 `null`。链接字段优先使用结果详情链接；相对链接需要补全为绝对 URL。

## 测试与文档

- 在 `clis/toutiao/toutiao.test.js` 增加搜索结果映射、数量限制、注册表形状和错误边界测试；
- 在 `clis/toutiao/search.js` 实现命令，复用或扩展 `utils.js` 的解析辅助函数；
- 更新 `docs/adapters/browser/toutiao.md` 和适配器索引，加入命令示例、参数与字段说明；
- 运行今日头条适配器测试、类型检查和 manifest 构建，确保新命令进入 `cli-manifest.json`。

## 非目标

本次不增加登录态搜索、不实现搜索结果分页、不修改现有 `hot` 与 `articles` 命令行为。
