# 代码审查报告

**文件**：`dashboard-docs/system/adapter-recorder-system/`
**语言/框架**：Markdown 系统设计、OpenAPI 3.1、JSON Schema 2020-12
**审查日期**：2026-06-23
**审查维度**：安全 · 架构 · 可维护性 · 错误处理 · 性能 · 可读性 · 测试 · 可观测性 · 并发

---

## 执行摘要

整体设计是比较扎实的：分层边界明确，有安全威胁建模、schema-first 契约、请求生命周期语义、脱敏规则、fixture 门禁，以及针对高风险选择的 ADR。剩下不合理的地方主要来自 M5/ADR-0007 之后的设计漂移：high-level 托管路径和 `/v1/*` 路由命名没有在 README、overview、roadmap、OpenAPI 中保持一致。还有两个 schema 层面的问题也建议在把文档视为实现就绪之前修掉：Recorder `InitRequest` 仍暴露可能与 `RankCandidate` 漂移的自由字段；请求结果 payload 仍过于泛化，生成客户端无法强约束。

---

## 问题汇总

| 严重级别 | 数量 |
|----------|------|
| Critical | 0 |
| High | 2 |
| Moderate | 3 |
| Low | 1 |
| **总计** | **6** |

---

## Critical 问题

未发现。

---

## High 问题

### [H-001] · daemon high-level endpoint 已在 prose 中接受，但机器契约中缺失

**行号**：`05-recorder-local-service.md` L24-L31，`07-high-level-services.md` L7-L15，`adr/0007-daemon-high-level-hosting.md` L9-L16，`schemas/high-level.openapi.yaml` L5-L51，`03-contracts-and-versioning.md` L55-L63
**维度**：架构 / 契约
**摘要**：设计说明中写明 `dashboard-be` 会把 init/verify 转发到 daemon endpoint `POST /v1/init` 和 `POST /v1/verify`，但 high-level OpenAPI 仍只定义了 `POST /v1/adapters/init` 和 `POST /v1/adapters/verify`。

**影响**：
contract-first 实现可能生成或测试错误路由。按 `05`/ADR-0007 的开发者会实现 daemon `/v1/init` 和 `/v1/verify`；按 `03` 或 `schemas/high-level.openapi.yaml` 的开发者会调用 `/v1/adapters/init` 和 `/v1/adapters/verify`。因为两组路由都使用 `/v1/*`，这不是无害的命名差异，而是会形成两套 ownership 不清的内部 API。

**建议修复**：
选择下面一种方案，并在所有地方明确：

1. 新增独立的 `daemon-high-level.openapi.yaml`，专门描述 daemon-hosted `/v1/init` 和 `/v1/verify`，并声明 `high-level.openapi.yaml` 只属于可选 standalone wrapper。
2. 如果 daemon endpoint 本来就是同一套 wire API，则把 daemon 路由改成已有 high-level contract 的命名：`/v1/adapters/init`、`/v1/adapters/verify`。
3. 或者把 daemon 路由移出通用 `/v1/*` 命名空间，避免碰撞，例如 `/daemon/high-level/init`。

无论选择哪种，都需要同步更新 `03`、`05`、`07`、ADR-0007 和 CI contract tests。

---

### [H-002] · Recorder `InitRequest` 在 selected-candidate 流程下仍允许自由 endpoint/column 数据

**行号**：`03-contracts-and-versioning.md` L66，`06-recorder-core-engine.md` L75-L77 和 L135-L137，`10-fixtures-and-test-plan.md` L84-L85，`schemas/recorder.openapi.yaml` L447-L487，`schemas/high-level.openapi.yaml` L118-L159
**维度**：契约 / 可维护性
**摘要**：prose 中说明 Recorder init 通过 `selectedCandidateId` 选择之前的 `RankCandidate`，并从 session state 派生 domain/strategy/endpoint；但 Recorder OpenAPI 仍暴露了可选的 `domain`、`strategy`、自由形态的 `endpoint: object` 和 `columns: string[]`。

**影响**：
面向 UI 的 `/recorder/init` contract 可能和 rank 输出漂移。客户端可以提交无法通过 `EndpointDescriptor` 校验的 `endpoint`，或提交不匹配 `ColumnDescriptor` 的 `columns`；而当前测试只要求 `High-Level InitInput.endpoint` 与 rank schema 共享形态。这会削弱整个 `rank -> selectedCandidateId -> init` 不变量。

**建议修复**：
如果 `/recorder/init` 只能选择候选项，应从 Recorder `InitRequest` 中移除 `domain`、`strategy`、`endpoint`、`columns`，全部由服务端派生。如果确实需要 UI 覆盖能力，应显式写明，并绑定：

- `endpoint` 绑定到 `adapter-recorder.bundle.json#/$defs/EndpointDescriptor`
- `columns` 绑定到 `ColumnDescriptor[]`
- 覆盖语义放入一个命名字段，例如 `candidateOverrides`
- 增加 contract tests，证明覆盖不能在不报 validation error 的情况下与 `selectedCandidateId` 矛盾

---

## Moderate 问题

### [M-001] · ADR-0007 已改变托管决策，但 overview/roadmap/ADR 索引仍像旧默认是权威结论

**行号**：`01-system-overview.md` L38-L42，`02-architecture-boundaries.md` L33 和 L69，`11-roadmap-and-acceptance.md` L35-L40，`adr/0004-high-level-module-first.md` L17-L20，`adr/0007-daemon-high-level-hosting.md` L19-L28
**维度**：架构 / 可读性
**摘要**：ADR-0007 已经把 "in-process import" 正确收窄到 main-repo same-process 形态，但入口文档仍写着 Local Service 同进程 import High-Level modules，M5 验收也仍写着 "in-process Local Service integration"。

**影响**：
新的实现者在读到 ADR-0007 之前会先看到互相矛盾的指令。这一点风险尤其高，因为 `dashboard-be` 有一条硬规则：不能 import main-repo `src/`。如果按陈旧 overview 实现，会重新制造 ADR-0007 正在避免的耦合。

**建议修复**：
把 ADR-0004 标记为 "Accepted, amended by ADR-0007 for dashboard-be/daemon hosting"。更新 `01` 的当前默认和 `11` 的 M5 验收，区分：

- same-process main-repo Local Service：可以 import high-level modules
- 独立 `dashboard-be`：只能使用 shared pure package + daemon boundary
- 可选 standalone wrapper：属于独立的 multi-client reuse 路径

同时把 ADR-0007 加入 `02` 的 ADR Required 列表。

---

### [M-002] · Security Model 的 URL policy 小节没有重申 ADR-0006 的 allowlist gate

**行号**：`04-security-model.md` L49-L75，`adr/0006-dns-rebinding-ip-enforcement.md` L24-L31，`11-roadmap-and-acceptance.md` L11-L18
**维度**：安全
**摘要**：核心 Security Model 列出了 parse/canonicalize/DNS/interception 步骤，但 ADR-0006 最强的规则只出现在 ADR/roadmap 中：没有 `strict-ip-enforced` 时，任意导航是不安全的，只能限制在静态、人工维护、强信任 allowlist 内。

**影响**：
只读 `04` 的实现者可能合理地误以为 DNS all-record precheck 加 redirect-before-send interception 已经足以支持任意导航。ADR-0006 明确说这不够，因为除非校验实际连接 IP，否则 DNS rebinding 仍存在 TOCTOU 缺口。

**建议修复**：
在 `04` L75 后直接增加一个简短的 "Connection-IP capability gate" 小节：

- 如果 tier 是 `strict-ip-enforced`，允许通过 URL policy 的任意域名
- 如果 tier 是 `ip-observed-only` 或 `no-ip-observation`，只允许静态、人工维护、强信任 allowlist 条目
- 用户提交域名、通配符、客户可控 CNAME、redirector host 都必须要求 `strict-ip-enforced`

---

### [M-003] · 请求结果 payload schema 写在 prose 中，但 OpenAPI 无法强制

**行号**：`03-contracts-and-versioning.md` L83-L90，`schemas/recorder.openapi.yaml` L290-L339，`schemas/high-level.openapi.yaml` L160-L190
**维度**：契约 / 可测试性
**摘要**：prose 中按 `type` 绑定 `RequestStatus.result`，但两个 OpenAPI 文件仍把 `result` 留成泛化的 `object | null`；`ApiResponse.data` 也同样是泛化形态。

**影响**：
contract tests 可以捕捉一部分漂移，但生成客户端和 schema validator 不知道 `rank` result 是 `RankCandidate[]`，`analyze` result 是 `AnalyzeReport`，`init` result 是 `RecorderReport`，`verify` result 是 runner summary。这削弱了 "machine-readable contracts first" 原则，把关键兼容性行为推回 prose。

**建议修复**：
增加类型化 response components，例如 `RankStatus`、`AnalyzeStatus`、`InitStatus`、`VerifyStatus`，并用带 `type` const 的 `oneOf` 约束。对 endpoint-specific `ApiResponse.data` 也尽量做同样处理，例如 `/recorder/rank`、`/recorder/analyze`、`/recorder/init`、`/recorder/verify` 的 acceptance envelopes。prose 应作为解释，而不是唯一约束来源。

---

## Low 问题

### [L-001] · 相邻进度文档存在陈旧状态行，与自身后续更新矛盾

**行号**：`dashboard-docs/architecture-relationship.md` L76-L80，L108-L116，L138-L143，L157-L163
**维度**：可维护性 / 文档
**摘要**：relationship doc 的部分表格仍写着 `dashboard-be` navigation 是 `feature_disabled`、M5 未开始，但后续章节和 header 又写着 M3/M4/M5a/M5b/M5c 已落地。

**影响**：
这不在目标设计目录内，但它是相邻入口文档，可能误导围绕 system docs 的规划。

**建议修复**：
把状态表和 milestone 表统一到 header 中的最新状态，或把旧块明确标为历史记录。

---

## 做得好的地方

- 设计有很强的安全基线：默认 Electron IPC、可选 localhost HTTP gates、XSS 约束、raw seed arg 边界、input 文件权限，以及明确的 same-uid 威胁说明。
- 状态机和 strict page lease 规则非常清楚，尤其是禁止 fallback 到其他 tab，以及 per-session 线性化 transition 的要求。
- schema 卫生状况不错：OpenAPI 是 3.1.0，已移除 `nullable`，shared errors 集中在 `adapter-recorder.bundle.json`，runner events 使用统一错误词表。
- fixture/test plan 很实用，覆盖真实故障模式：URL matrix、A/B sample 规则、idempotency、crash recovery、redaction、config reload、runner protocol violations。

---

## 系统性观察

主要系统性问题是 "implementation feedback 之后的决策漂移"。早期文档确立了 module-first/in-process high-level 设计；后来的 ADR-0007 和 M5 实现反馈又引入 daemon-hosted init/verify 以及 pure shared package 抽取。新的决策本身是合理的，但还没有把所有入口文档和 schema 都同步成 canonical path。

第二个模式是有些地方 "prose 强于 schema"。文档反复强调 contract-first 和 machine-readable，但 `RequestStatus.result`、`ApiResponse.data` 和 Recorder `InitRequest` 仍把重要行为约束留在 schema 之外。

---

## 假设与上下文缺口

我审查的是设计包和相邻 relationship docs，没有完整审查实现。如果实现里已经标准化到某一组 `/v1/*` 路由，并且有生成测试在其他地方强制约束，那么 H-001 的严重级别可以下调；但文档仍需要同步，因为当前设计包内部确实存在矛盾。

我把 `dashboard-be` 当作可选 localhost HTTP UI 的目标生产路径来看待，因为周边文档就是这样定位的。如果它现在只是临时实现产物，架构文档应明确说明，并把 daemon-hosting 细节移出 MVP contract path。
