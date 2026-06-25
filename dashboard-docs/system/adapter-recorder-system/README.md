# Adapter Recorder System · Modular Spec

*2026-06-19 · modular system specification*

## 目标

Adapter Recorder System 把用户录制、网络捕获、endpoint 判定、adapter 草稿生成、verify 执行和结果回传统一为一套本地系统设计。系统默认运行在 Electron/Local Service 边界内:UI 不直接访问 daemon,也不持有 daemon/high-level token;Local Service 统一调用 daemon browser bridge、Recorder Domain Engine 和 High-Level Service Modules。

## 模块

| 文件 | 职责 |
| --- | --- |
| `00-tdd-governance.md` | TDD.md 工程治理门禁:可行性、分层、测试、contract、配置、日志、ADR。 |
| `01-system-overview.md` | 系统目标、进程拓扑、UI 通道选择、端到端流程。 |
| `02-architecture-boundaries.md` | 分层架构、依赖方向、ports/adapters、模块边界和 ADR 要求。 |
| `03-contracts-and-versioning.md` | `/recorder/*` 与 `/v1/*` contract、schema version、错误映射、request status。 |
| `04-security-model.md` | CSRF/Origin、Electron XSS、navigation URL policy、token、seedArgs、FS/input.json。 |
| `05-recorder-local-service.md` | Recorder Local Service API、状态机、request registry、strict page lease、daemon client。 |
| `06-recorder-core-engine.md` | Canonical capture schema、Normalize、Rank、Diff、fixtures。 |
| `07-high-level-services.md` | analyze/init/verify service modules、HTTP wrapper、request status。 |
| `08-runner-and-isolation.md` | JSONL runner、子进程隔离、timeout、env allowlist、input.json。 |
| `09-config-observability.md` | RecorderConfig、HighLevelConfig、structured logs、requestId、redaction。 |
| `10-fixtures-and-test-plan.md` | fixture corpus、URL matrix、contract tests、coverage and CI gates。 |
| `11-roadmap-and-acceptance.md` | milestone 顺序、MVP 验收、质量门禁。 |
| `adr/` | 关键设计决策记录。 |
| `schemas/` | 机器可读 API/error schema 草案。 |

## 当前设计结论

- 默认 UI 通道是 Electron IPC;纯网页 localhost UI 是可选形态(`FEATURE_LOCALHOST_HTTP_UI`),必须启用 Origin/header/CSRF 防护 + 启动随机 token(详见 `04`)。
- `/recorder/*` 是 UI 唯一入口;`/v1/*` 分两族(详见 `03` 与 `schemas/daemon-high-level.openapi.yaml`):**daemon high-level endpoints**(`POST /v1/init`、`POST /v1/verify`,dashboard-be 实际转发 FS/子进程能力到此)与**可选 standalone HTTP wrapper**(`high-level.openapi.yaml`,multi-client 复用),两族不可混淆。
- schema-first 是第一个交付物;HTTP 与 IPC 共用 transport-independent contract。
- navigation URL policy 必须先完成 request interception spike;无 request 前拦截能力时,默认 MVP 不允许未知 redirect。
- Recorder 必须使用 strict page lease;page 丢失直接 `page_lost`,不得自动换 tab。
- verify 可短期接触 raw `executionSeedArgs`;report/fixture/status 只能保存 `evidenceSeedArgs` HMAC 摘要。
- 核心 domain/service 覆盖率目标 >= 80%,contract/schema/dependency/config/error tests 全部进入 CI gate。

## 版本策略

本目录作为后续系统设计的主入口。新设计迭代应在本目录中按模块更新,并在 `11-roadmap-and-acceptance.md` 的 changelog 中记录变更。
