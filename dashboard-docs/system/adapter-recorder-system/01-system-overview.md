# 01 · System Overview

## 一句话结论

Adapter Recorder System 是一个本地录制与 adapter 生成系统:UI 只访问 Recorder Local Service;Local Service 封装 daemon browser bridge、Recorder Domain Engine 和 High-Level Service Modules;verify 执行用户 adapter 时必须通过 async runner 子进程隔离。

## 进程与模块

| 层级 | 组件 | 职责 |
| --- | --- | --- |
| UI | Recorder UI(Electron renderer 或纯网页 localhost UI) | 编排录制、展示候选 endpoint、用户确认、展示报告。 |
| Local | Recorder Local Service(Electron main/Node) | 唯一 UI 入口,持有 token,注入 `X-byCLI`,管理 session/request/page lease。 |
| Domain | Recorder Domain Engine | URL policy、canonical mapping、normalize、rank、diff、state machine。 |
| Daemon | byCLI daemon + Chrome extension | 执行 navigate、exec、network capture、cookies、screenshot 等浏览器动作。 |
| High-Level | analyze/init/verify modules | 站点分析、adapter 草稿生成、结构化 verify。 |
| Runner | verify-runner child process | 执行用户 adapter,输出 JSONL event/result。 |

## UI 通道选择

| 选项 | 默认 | 安全边界 |
| --- | --- | --- |
| Electron IPC | 推荐 | renderer 只通过 contextBridge allowlist 调 main;不开普通浏览器可达 HTTP 入口。 |
| 纯网页 localhost HTTP | 可选(`FEATURE_LOCALHOST_HTTP_UI`) | 必须启用 Origin allowlist、自定义 header gate、CSRF token、POST-only side-effect endpoints、启动随机 token(详见 `04`)。 |

Electron 必须启用 CSP、`contextIsolation`、禁 `nodeIntegration`、禁远程脚本/样式、禁 navigation/window.open、权限请求 default-deny。纯网页形态必须只监听 `127.0.0.1`。

## 端到端流程

1. Health: UI 调 Local Service,检查 daemon、extension、High-Level modules。
2. Bind: Local Service 建 recorder session,绑定 `sessionId/contextId/page targetId`。
3. Navigate: Local Service 对 URL 执行 canonicalization、DNS、request interception 策略,再经 daemon 导航。
4. Capture A/B: 对同一 page lease 串行 start/read 两个样本窗口。
5. Rank: `POST /recorder/rank` 读取 session 内已冻结的 A/B 样本,内部执行 normalize(映射为 `RecorderNetworkEntry`、落 `sourceCompleteness`)/rank/diff,输出候选 `RankCandidate[]`(endpoint、参数映射、score、confidence、risks、scoreExplanation)。normalize 是 rank 的内部步骤,不是独立的顶层流程。
6. Init: 用户经 `selectedCandidateId` 选定候选,High-Level module 生成 adapter 草稿、dry-run diff、报告路径。
7. Verify: async runner 执行 adapter,返回结构化 rows/shape/fixture/error。
8. Done: 清理 raw capture、临时 trace/input.json,保留脱敏报告。

## 当前默认

- High-Level 托管按形态(ADR-0007):**主仓内同进程 Local Service**(CLI/daemon)可 in-process import High-Level modules;**独立进程 `dashboard-be`** 不 import 主仓 src/,经 daemon 边界(浏览器 IO 走 `/command`、FS/子进程走 daemon `/v1/init`、`/v1/verify`);纯 domain 抽 `packages/recorder-core` 共享包。可选独立 HTTP wrapper 后置(多 client 复用)。
- MVP capture 来源默认 daemon extension path;direct CDP 只有补齐 request headers/body parity 后才标记 supported。
- MVP 不提供 localhost 开发放行开关;高风险放行只能作为后续显式确认模式。
- request status 通过 registry 查询,UI 刷新后只能看到脱敏 result。
