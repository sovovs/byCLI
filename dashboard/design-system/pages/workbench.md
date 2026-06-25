# 页面覆盖 · /workbench 录制工作台

> 覆盖优先于 [MASTER.md](../MASTER.md)。本页继承 MASTER 的配色/字体/图表语义,仅声明偏离项。

## 定位

完全吃 MASTER 的 **Data-Dense Dashboard** 定调:信息密度优先、网格布局、最小留白。这是核心操作页。

## 布局

- 三栏:左 Steps 进度(8 步)、中 当前 step 操作区、右 StatePanel(sticky)。
- 顶部 FlowGraph(React-Flow)横向 DAG,高度 ~130px,当前态高亮。
- 容器 `max-width: 1280px`,响应式:`lg` 三栏,`xs/md` 堆叠单列。

## 状态机驱动(05 契约)

- 每个 step 由显式动作驱动,UI 不自动跳转;按钮在 async 期间 loading + disable(uipro `loading-buttons`)。
- Steps 组件 `current` 跟随 SessionState;失败态 `status="error"`。
- 非法转移 → `invalid_state` 就地提示;租约级错误(page_lost 等)→ failed 整页 ErrorRecovery。

## FlowGraph 节点配色(MASTER 图表语义)

| 节点态 | 色值 | 含义 |
| --- | --- | --- |
| 已完成 | `#56d364` | happy path |
| 当前 | `#2dd4bf` | 主色高亮 + 外发光 |
| 未到达 | `#2d3744` | 边框灰 |
| 失败 | `#f47067` | 瓶颈/失败 |

## 候选卡(RankCandidate)

- confidence → Tag 色:高 teal / 中 info 蓝 / 低 warning 琥珀 / 拒绝 error 红。
- score 用环形 Progress;scoreExplanation 正负 delta 用绿/红;rejected 候选禁选(cursor not-allowed)。
- URL 模板、参数映射、字段路径一律 Fira Code(`.code`)。

## 图表

- trace 耗时用 Recharts 横向 Bar,降序 + 数值标签;>250ms 标 warning 琥珀(瓶颈)。
- 复杂图配数据表兜底:CaptureStep 已有 entries 明细表。
