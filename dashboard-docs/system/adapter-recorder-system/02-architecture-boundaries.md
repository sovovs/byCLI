# 02 · Architecture Boundaries

## 分层

```
UI / IPC / HTTP Adapter
  -> Recorder Application Service
  -> Domain Engine(URL policy / normalize / rank / diff / state machine)
  -> Infrastructure Adapters(daemon client / high-level client / temp store / logger)

CLI / HTTP Wrapper / Local Service Adapter
  -> High-Level Application Service
  -> Domain Services(analyze report / draft generation / fixture validation / error classification)
  -> Infrastructure Adapters(Page / runner subprocess / filesystem / registry / logger)
```

## 依赖规则

| 规则 | 要求 |
| --- | --- |
| UI 不持 token | UI 不保存 daemon/high-level token,不直连 daemon/high-level HTTP wrapper。 |
| Domain 纯净 | Domain Engine 不 import Electron、HTTP server、daemon client、filesystem writer、runner。 |
| Application 编排 | Application Service 可组合 domain 与 infra,但不能把 raw token/raw seedArgs 放入 UI-facing response。 |
| Infra 实现 port | daemon client、runner、filesystem、logger、registry 都是 adapter,不得反向调用 UI/domain 全局状态。 |
| No circular deps | CI 必须阻断循环依赖。 |

## Ports

| Port | 方法 | Adapter |
| --- | --- | --- |
| `BrowserBridgePort` | `health`, `navigate`, `captureStart`, `captureRead`, `exec`, `cookies` | daemon HTTP client |
| `CaptureProviderPort` | `start`, `read`, `capabilities` | daemon extension capture, optional direct CDP |
| `HighLevelPort` | `analyze`, `init`, `verify`, `getRequestStatus`, `cancel` | in-process modules, optional HTTP wrapper |
| `TempStorePort` | `writeRedacted`, `cleanup`, `ttlSweep` | local filesystem temp store |
| `RequestRegistryPort` | `create`, `update`, `get`, `cancel`, `expire` | in-memory registry with TTL |
| `ConfigPort` | `load`, `validate`, `reload`, `snapshot` | env/config schema parser |

`ConfigPort` semantics: `load` reads env into a candidate config; `validate` checks it against the config schema (see `09`); `reload` re-runs load+validate and, on success, atomically swaps a versioned snapshot (failure keeps the current snapshot and surfaces `config_invalid`); `snapshot` returns the current immutable versioned snapshot. In-flight work holds the snapshot it started with; new work reads the latest. Concurrent `reload` calls are serialized (single-flight) and the swap is a version compare-and-set, so a slower reload can never overwrite a newer snapshot; a failed reload never advances the version. `reload` may never widen the redaction allowlist or any security boundary.

## Module Responsibilities

| Module | Owns | Does not own |
| --- | --- | --- |
| Recorder Application Service | session/page lease, request registry, orchestration | rank scoring internals, runner subprocess details |
| URL Policy Domain | URL parse/canonicalize/DNS/mockable policy decisions | browser navigation side effects |
| Core Engine | canonical capture, normalize, rank, diff, scoreExplanation | file writes, HTTP handlers |
| High-Level Application Service | analyze/init/verify orchestration | UI state, recorder capture window |
| Runner Infra | child process lifecycle, JSONL parsing, timeout/cancel | adapter business logic |

**Shared domain package (`packages/recorder-core`, M4+).** The pure, IO-free domain logic of Core Engine and the deterministic sub-pieces of the High-Level modules are physically extracted into the npm-workspace package `@sovovs/bycli-recorder-core` (rank canonical/normalize/pairing/score, `analyzeSite`, init template/validation/provenance/dry-run, verify seedArgs-HMAC / runner-event parsing). Both the main repo and the independent `dashboard-be` process import it — this is how `dashboard-be` reuses domain logic without importing main-repo `src/` (its hard rule). The package contains **no IO** (no Page, no FS, no HTTP, no child process); anything touching IO stays in the main-repo modules/daemon. This is a code-layer artifact and is distinct from the **wire contract** source of truth, which remains `system/schemas/` — the package mirrors those `$defs` as hand-written types, it does not replace them.

## Dependency Checks

Use ESLint boundaries, dependency-cruiser, madge or equivalent:

- Block imports from domain modules to transport/infra modules.
- Block UI imports of daemon client, high-level token, runner, filesystem temp store.
- Block high-level HTTP wrapper imports from recorder UI.
- Block circular dependencies across application/domain/infra layers.

## ADR Required

Each decision needs an ADR **or** a module decision record (with Why / alternatives / trade-offs) in the owning chapter:

- UI channel default(Electron IPC vs localhost HTTP). — ADR 0001
- Request interception implementation. — ADR 0002
- DNS rebinding / connection-IP enforcement tier. — ADR 0006
- Capture provider support matrix. — `01`/`06`
- High-Level modules in-process vs HTTP wrapper. — ADR 0004
- Daemon high-level hosting + capability-boundary split (analyze via /command, init/verify via daemon /v1/*). — ADR 0007
- JSONL runner and process isolation. — `08`
- `executionSeedArgs` / `evidenceSeedArgs` split. — ADR 0003
- Schema major version upgrades. — `03`
- Responsible use boundary. — ADR 0005
- Authentication session binding model. — `05` Authentication Session Binding
- Crash recovery / startup reap of orphan runners and temp data. — `05` Crash Recovery And Startup Reap
- Temp store capacity / watermark policy. — `05`/`09` Temp Store Pressure Policy
- Idempotency keys for side-effect POSTs. — `03` Idempotency
