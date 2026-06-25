# Code Review Report

**File**: `dashboard-docs/system/adapter-recorder-system/`
**Language/Framework**: Markdown system design, OpenAPI 3.1, JSON Schema 2020-12
**Review Date**: 2026-06-23
**Reviewed Dimensions**: Security · Architecture · Maintainability · Error Handling · Contract · Testing

---

## Executive Summary

这一版明显修掉了上一轮最核心的设计漂移：ADR-0007 已写回 `01/02/11/ADR-0004`，`04` 补了 connection-IP gate，`/recorder/init` 也改成了 select-only。剩下的主要问题集中在新增的 `daemon-high-level.openapi.yaml`：它已经把 daemon `/v1/init`、`/v1/verify` 立成独立契约，但 payload、枚举、CI gate、统一响应/错误 envelope、安全 header 和现有 high-level/recorder contract 还没有完全收齐。

---

## Issue Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 |
| Moderate | 5 |
| Low | 1 |
| **Total** | **8** |

---

## Critical Issues

None found.

---

## High Issues

### [H-001] · `daemon-high-level.openapi.yaml` 的 `/v1/init` payload 不足以承载 `createAdapterDraft`

**Lines**: `schemas/daemon-high-level.openapi.yaml` L14-L30, `schemas/high-level.openapi.yaml` L126-L167, `03-contracts-and-versioning.md` L73, `07-high-level-services.md` L65-L77
**Dimension**: Contract / Architecture
**Summary**: daemon `/v1/init` 只定义了 `name/domain/strategy/browser/writePolicy/responsibleUseAcknowledgedAt`，但 High-Level `InitInput` 和 `createAdapterDraft` 设计还需要 `args`、`endpoint`、`columns`、`report` 等由 selected `RankCandidate` 派生出的草稿输入。

**Impact**:
`/recorder/init` 现在是 select-only，这是正确的；但 Local Service 在选中 candidate 后仍必须把完整的派生草稿输入传给 daemon/main-repo `createAdapterDraft`。当前 daemon schema 没有这些字段，会导致实现者只能生成缺少 endpoint/columns/args 的 adapter 草稿，或者在 schema 外偷偷传字段，重新制造 contract drift。

**Proposed Fix**:
让 `daemon-high-level.openapi.yaml#/v1/init` 复用或镜像 High-Level `InitInput` 的结构，至少包含：

- `args: ArgMapping[]`
- `endpoint: EndpointDescriptor`
- `columns: ColumnDescriptor[]`
- `report`
- `writePolicy`
- `responsibleUseAcknowledgedAt`

如果 daemon endpoint 故意只接收 select-only 输入，则需要明确 daemon 也能访问 recorder session/rank report；但 ADR-0007 当前说 `dashboard-be` forwards only，因此更合理的是让 `dashboard-be` 派生后转发完整 `InitInput`。

---

### [H-002] · daemon contract 的枚举与现有 recorder/high-level contract 不一致

**Lines**: `schemas/daemon-high-level.openapi.yaml` L29 and L67-L68, `schemas/recorder.openapi.yaml` L474-L506, `schemas/high-level.openapi.yaml` L108-L113 and L162-L164
**Dimension**: Contract / Correctness
**Summary**: daemon `/v1/init.writePolicy` 使用 `dry-run`，而 recorder/high-level 使用 `dry_run`；daemon `/v1/verify.fixture` 使用 `ignore|match|update`，而 recorder/high-level 使用 `ignore|use|update|write`。

**Impact**:
`dashboard-be` 转发时必须做隐式翻译，否则合法的 `/recorder/init` dry-run 请求会被 daemon schema 拒绝，合法的 verify fixture policy 也会在 daemon 边界丢失语义。更糟的是，这种翻译没有在设计中声明，后续 contract tests 很容易测一边过、另一边挂。

**Proposed Fix**:
统一枚举命名，优先沿用已有 recorder/high-level contract：

- `writePolicy: dry_run | write`
- `fixture: ignore | use | update | write`
- `trace: off | retain-on-failure | always`

如果确实需要 daemon 使用不同枚举，必须在 `03` 和 `05` 加一张明确的 mapping table，并把 mapping 纳入 contract tests。

---

## Moderate Issues

### [M-001] · 新增 daemon schema 后，治理入口和 CI gate 仍只承认旧的三文件契约

**Lines**: `00-tdd-governance.md` L30, `README.md` L25-L36, `dashboard-docs/README.md` L48-L55, `dashboard-docs/architecture-relationship.md` L102-L106, `03-contracts-and-versioning.md` L7-L13
**Dimension**: Testing / Maintainability
**Summary**: 设计现在有第四个机器契约 `daemon-high-level.openapi.yaml`，但 `00` 的 contract gate 仍写“3 个 schema 文件”和“两个 OpenAPI”，schema version table 也没有 `daemon-high-level.v1`。

**Impact**:
最容易出错的新增 daemon 契约可能不会进入 CI 校验，也不会被版本策略覆盖。这样 H-001/H-002 这类 drift 即使存在，也可能不被 contract gate 捕获。

**Proposed Fix**:
把治理入口全部同步为四个 schema 文件：

- `recorder.openapi.yaml`
- `high-level.openapi.yaml`
- `daemon-high-level.openapi.yaml`
- `adapter-recorder.bundle.json`

同时在 `03` Schema Versioning 中加入 `Daemon High-Level Endpoints | daemon-high-level.v1`，并在 `00` contract gate 中断言三个 OpenAPI 都是 `3.1.x` 且无 `nullable`。

---

### [M-002] · Verify status 当前仍绑定到内部 runner data，和后面的 `VerifySummary` TODO 自相矛盾

**Lines**: `03-contracts-and-versioning.md` L92-L100, `schemas/adapter-recorder.bundle.json` L291-L318
**Dimension**: Security / Contract
**Summary**: `03` 先说 `verify` result 绑定到 `RunnerResultEvent.data summary`，随后 TODO 又说未来必须新增 redacted `VerifySummary`，并且 status-facing shape 不能引用 `RunnerResultEvent.data`。

**Impact**:
当前 MVP 兜底仍把绑定口径留在 `RunnerResultEvent.data`，而该内部 runner data 允许 `trace.path`。这和同一段中的“Result 只含 trace retained flag / 不暴露 raw trace”约束相冲突。即使未来 TODO 正确，当前实现期仍可能把内部 runner shape 泄到 status/report 边界。

**Proposed Fix**:
不要等到 M6 才命名边界。现在就至少在 bundle 中增加最小 `VerifySummary` `$def`，只包含稳定的红线字段，例如 `stage/rows/rowShape/fixture.status/trace.retained/trace.truncated/errorCode`，明确禁止 `trace.path`。M6 可以扩展该 summary，但 status-facing contract 不应再指向 `RunnerResultEvent.data`。

---

### [M-003] · daemon high-level responses 没有统一 envelope、schemaVersion 和 shared Error body

**Lines**: `schemas/daemon-high-level.openapi.yaml` L31-L53 and L69-L87, `03-contracts-and-versioning.md` L43-L53 and L103-L105
**Dimension**: Contract / Error Handling
**Summary**: daemon `/v1/init`、`/v1/verify` 的成功响应只有 `{ ok, data }`，没有 `schemaVersion`；400/401/500 只有 description，没有绑定 shared `adapter-recorder.bundle.json#/$defs/Error`。

**Impact**:
如果 `daemon-high-level.openapi.yaml` 是一等机器契约，客户端无法稳定解析 daemon high-level error，也无法通过 `schemaVersion` 做兼容判断。这和 `03` 的统一响应/统一错误原则相冲突：Recorder/High-Level 错误都应使用同一个 shared `Error` schema，不能只在 description 里写 `validation_failed` / `runner_protocol_error`。

**Proposed Fix**:
给 daemon high-level contract 增加自己的统一 envelope，例如 `DaemonHighLevelResponse`：

- `ok`
- `schemaVersion: daemon-high-level.v1`
- `requestId`（verify accepted / async request 时必需）
- `data`
- `error: adapter-recorder.bundle.json#/$defs/Error | null`

同时给 400/401/403/500/503 等错误响应都绑定该 envelope 或 shared `Error` schema；不要只写 description。

---

### [M-004] · `X-byCLI` gate 只存在于 prose，OpenAPI 没有机器化安全要求

**Lines**: `schemas/daemon-high-level.openapi.yaml` L5-L12, `05-recorder-local-service.md` L31 and L170-L172, `07-high-level-services.md` L150-L157
**Dimension**: Security / Contract
**Summary**: daemon schema 描述了所有路由都 gated by `X-byCLI`，但 OpenAPI 中没有 `components.securitySchemes`、全局 `security`，也没有 required header parameter。

**Impact**:
生成客户端、contract tests 和安全门禁检查无法从机器契约得知 `X-byCLI` 是必需 header。实现者可能只按路径和 payload 实现，漏掉 daemon high-level surface 的同等 gate，尤其是这两个 endpoint 涉及 FS 写和 runner/子进程能力。

**Proposed Fix**:
在 `daemon-high-level.openapi.yaml` 增加机器化安全约束，例如：

```yaml
components:
  securitySchemes:
    ByCLIHeader:
      type: apiKey
      in: header
      name: X-byCLI
security:
  - ByCLIHeader: []
```

如果还需要 startup token，也应明确 daemon high-level surface 是否复用 `X-byCLI-Token`，还是仅使用 daemon 既有 `X-byCLI` gate。

---

### [M-005] · `/v1/init` 的 responsible-use required 条件没有 schema 强制，错误码也偏离语义

**Lines**: `schemas/daemon-high-level.openapi.yaml` L29-L30 and L50-L53, `schemas/high-level.openapi.yaml` L129-L139 and L162-L167, `schemas/recorder.openapi.yaml` L454-L464, `07-high-level-services.md` L92
**Dimension**: Contract / Correctness
**Summary**: daemon `/v1/init` 只在 description 中写 `responsibleUseAcknowledgedAt` required when `writePolicy=write`，没有像 recorder/high-level schema 那样用 `if/then` 条件强制；缺失时还标成 `401 auth_required`。

**Impact**:
responsible-use gate 是写入 adapter/report 前的产品/合规确认，不是目标站登录态缺失。把它标成 `auth_required` 会让 UI 给出错误恢复动作（提示用户重新登录/绑定），而不是提示授权确认。因为条件没有进入 schema，contract tests 也不一定能挡住漏传确认时间戳的 write 请求。

**Proposed Fix**:
在 daemon `/v1/init` request schema 中复制 recorder/high-level 的 conditional-required：

- `if writePolicy == write`
- `then required: [responsibleUseAcknowledgedAt]`
- `responsibleUseAcknowledgedAt` 必须是 non-null integer

错误码建议使用 `validation_failed`，或新增明确的 responsible-use error code（如果产品希望 UI 区分展示），但不要复用 `auth_required`。

---

## Low Issues

### [L-001] · `README.md` 的当前结论仍用旧 `/v1/*` 描述，容易误读

**Lines**: `README.md` L28-L36
**Dimension**: Documentation
**Summary**: 入口 README 仍写 `/v1/*` 是 High-Level module 或可选 HTTP wrapper 的内部 contract，没有提新增的 daemon `/v1/init`、`/v1/verify` 与 optional standalone wrapper 是两个 distinct `/v1/*` families。

**Impact**:
这不是新的架构 bug，因为 `03` 已经说清楚了；但 README 是主入口，读者容易先形成旧心智模型。

**Proposed Fix**:
在“当前设计结论”中补一句：`/v1/*` 现在分为 optional standalone wrapper 与 daemon high-level endpoints 两族，具体以 `03` 和 `schemas/daemon-high-level.openapi.yaml` 为准。

---

## What's Working Well

- 上一轮 H-001 的核心方向已经补上：新增了 `daemon-high-level.openapi.yaml`，并在 `03`/`high-level.openapi.yaml` 中明确两族 `/v1/*` 不可混淆。
- 上一轮 H-002 基本关闭：Recorder `InitRequest` 已改为 select-only，移除了自由 `endpoint/columns`，并加了 `additionalProperties: false`。
- ADR-0007 的 hosting split 已同步回 `01`、`11`、ADR-0004 和 `02` 的 ADR list。
- `04` 新增的 connection-IP capability gate 把 ADR-0006 的安全限制放回了 Security Model 主入口，这是正确的。

---

## Systemic Observations

这次修改方向是对的，但新增独立 daemon 契约后，需要把它当作一等 contract，而不是对上一轮问题的旁注。只要它进入了 `/v1/*` 命名空间，就必须拥有完整 schema version、CI gate、枚举一致性、payload parity、统一 error/envelope 和机器化安全 gate。

---

## Assumptions and Context Gaps

我审查的是设计文档和 schema，没有审查 `dashboard-be` / daemon 实现代码。如果实现中已经有显式字段映射和额外 contract tests，H-001/H-002 的运行风险会降低；但设计文档仍需要同步，因为当前机器契约本身还不一致。
