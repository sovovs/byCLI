# skills · byCLI 技能说明与实现原理

> 讲 `skills/<name>/SKILL.md` 各技能的**用途、工作流、以及依赖的 byCLI 代码**。
> 与 [`adapter-runtime`](../adapter-runtime/)(运行时原理)、[`adapter-recorder-system`](../adapter-recorder-system/)(录制器设计)平级。
> 这些文档描述既有技能+代码,是开发者向讲解,非新设计提案。
> (2026-07-04 从仓库根迁入,保留 git 历史;基线约 2026-06-12;文中 `skills/<name>/...` 指向仓库根 `skills/` 代码目录,路径仍有效。)

## 文档

- [bycli-adapter-author 技能与实现原理](./bycli-adapter-author-skill.md) — `skills/bycli-adapter-author/SKILL.md`:从冷启动到 verify 写 adapter 的 runbook + 依赖实现。
- [bycli-autofix 技能与实现原理](./bycli-autofix-skill.md) — `skills/bycli-autofix/SKILL.md`:修复流程 + 依赖的 trace / adapter source / browser verify 代码。

> 注:仓库根 `skills/` 下还有 `bycli-browser`、`bycli-usage` 等技能,尚无对应原理文档(可后续补)。
