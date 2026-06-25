# 设计系统 · MASTER —— byCLI Adapter Recorder

> 全局 Source of Truth。具体页面如需偏离,在 `design-system/pages/<page>.md` 写覆盖项;
> 没有页面文件时,一律以本文件为准。
>
> 生成方式:`ui-ux-pro-max` 检索(style / color / typography / chart 域)+ 人工对齐项目现状。
> **唯一权威配色来源是 `dashboard/.umirc.ts` 的 antd token**,本文件向它对齐,二者冲突以 `.umirc.ts` 为准。

## 1. 风格定位

**Data-Dense Dashboard**(数据密集型工作台)
- 多 widget、数据表、KPI 卡、网格布局,**最小留白、最大化信息密度**。
- 性能优先,目标可访问性 WCAG AA。
- **反模式(禁止)**:花哨装饰、营销落地页式 Hero/Pricing/CTA、无筛选的长列表。

## 2. 配色 —— 以 `.umirc.ts` 为准(暗色,GitHub-dark 基调)

| 角色 | Token | 值 | 语义 |
|------|-------|-----|------|
| 主色 | `colorPrimary` | `#2dd4bf` | teal,主操作/选中 |
| 信息 | `colorInfo` | `#58a6ff` | 蓝,链接/提示 |
| 成功 | `colorSuccess` | `#56d364` | run 通过 / happy path |
| 警告 | `colorWarning` | `#f0a868` | 偏离 / 需注意 |
| 错误 | `colorError` | `#f47067` | 失败 / 瓶颈 |
| 页底 | `colorBgBase` | `#0d1117` | 全局背景 |
| 容器 | `colorBgContainer` | `#161b22` | 卡片/表格 |
| 浮层 | `colorBgElevated` | `#1c2330` | 弹窗/下拉 |
| 边框 | `colorBorder` | `#2d3744` | 分隔线 |
| 正文 | `colorText` | `#e6edf3` | 主文本 |
| 次要 | `colorTextSecondary` | `#9da7b3` | 辅助文本 |
| 圆角 | `borderRadius` | `8` | — |

启用 `dark: true`(antd darkAlgorithm)。新增颜色前先确认能否复用以上 token。

## 3. 字体(uipro 命中,采用)

- 正文/UI:**Fira Sans**(`fontSize: 14`)
- 等宽:**Fira Code** —— 专用于 trace、selector、JSON payload、命令、代码列。

```css
@import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Fira+Sans:wght@300;400;500;600;700&display=swap');
```

antd 接入:在 ConfigProvider token 增设 `fontFamily: "'Fira Sans', -apple-system, sans-serif"`、`fontFamilyCode: "'Fira Code', monospace"`(当前 `.umirc.ts` 尚未设置,落地时补)。

## 4. 图表 / 可视化(uipro chart 域,精准命中)

| 场景 | 推荐图表 | 配色语义 | 库 |
|------|---------|---------|-----|
| **录制步骤 / 执行流程(核心)** | Process Map / DAG | happy path `#56d364` 粗线、偏离 `#f0a868` 细线、瓶颈 `#f47067` | React-Flow / Cytoscape |
| trace 耗时趋势 | Line Chart | 主线 `#58a6ff`,多序列区分色,填充 20% | Recharts |
| 步骤耗时对比 | Horizontal Bar | 降序、带数值标签 | Recharts |
| 多维对比 | Radar(轴 ≤ 5–8) | 单组 `#2dd4bf` 20% 填充 | Recharts / ApexCharts |

复杂图必须配数据表兜底(可访问性)。

## 5. 交互效果

- hover tooltip、表格行 hover 高亮、点击放大图表、筛选动画、加载占位。
- antd 映射:`Table` rowHover / `Tooltip` / `Spin` / `Skeleton`。
- 过渡时长 150–300ms;尊重 `prefers-reduced-motion`。

## 6. 交付自检清单

- [ ] 不用 emoji 当图标(用 `@ant-design/icons`)
- [ ] 可点击元素 `cursor: pointer`
- [ ] hover 有明确视觉反馈,过渡 150–300ms
- [ ] 文本对比度 ≥ 4.5:1
- [ ] focus 状态键盘可见
- [ ] 尊重 `prefers-reduced-motion`
- [ ] 响应式断点 375 / 768 / 1024 / 1440px
- [ ] 表单控件有 label;复杂图表配数据表
- [ ] 新配色优先复用 `.umirc.ts` token,不硬编码新色值
