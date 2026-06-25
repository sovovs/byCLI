# 页面覆盖 · /docs 方案文档

> 覆盖优先于 [MASTER.md](../MASTER.md)。本页**显式偏离** MASTER 的 Data-Dense 定调,改用阅读型布局。

## 定位

阅读型(reading-first),不是数据密集型。文档要好读,不是塞数据。这是 MASTER 之外的主要偏离点。

## 对 MASTER 的偏离

| 维度 | MASTER(Data-Dense) | 本页覆盖 |
| --- | --- | --- |
| 留白 | 最小留白、信息密度优先 | 宽留白,降低信息密度 |
| 行宽 | 不限 | 限 `72ch`(line-length 65–75) |
| 行高 | 表格紧凑 | 正文 `1.7`(body 1.5–1.75) |
| 布局 | 多 widget 网格 | 双栏:左导航树 + 右单列阅读区 |

## 继承 MASTER 的部分

- 配色 token、Fira 字体、暗色基调不变。
- 等宽 `.code` 仍用于路径、契约字段、状态码等。
- 交付自检清单全部适用。

## 布局

- 左侧 `Sider` 宽 280px:按 4 个分组(治理与架构 / 服务与引擎 / 运行与质量 / 决策记录)的模块导航树,`Tree` + showIcon。
- 右侧 `Content`:`article` 限宽 72ch,编号 Tag + 标题 + 摘要 + 关键要点列表 + 源文件路径。
- 选中项主色 teal 高亮;分组节点不可选。

## 注意

- 文档正文以结构化摘要 + 要点呈现(modules.ts),完整正文指向 `docs/adapter-recorder-system/*` 源文件。
- 不引入额外 markdown 渲染依赖,保证 build 稳定。
