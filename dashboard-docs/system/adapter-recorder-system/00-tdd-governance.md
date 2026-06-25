# 00 · TDD Governance

## 原则

所有后续设计迭代必须先对照 `dashboard-docs/TDD.md` 检查。设计文件不能只描述功能,还必须定义可行性验证、分层依赖、测试策略、接口契约、错误语义、配置管理、日志追踪和 ADR。

## 合规门禁

| TDD 维度 | 系统要求 |
| --- | --- |
| 可行性 | 对 request interception、capture parity、JSONL runner、temp HOME/input.json 等硬风险先做 POC/spike。 |
| 可迭代性 | UI/transport、application service、domain engine、infrastructure adapter 分层明确,低耦合迭代。 |
| 可扩展性 | capture provider、high-level transport、verify runner、redaction policy、strategy hint 都通过 port/strategy 扩展。 |
| SOLID | Domain 模块职责单一;新增 transport/provider 不修改核心 ranker;接口按调用者拆分。 |
| 测试覆盖 | core domain/service 单元测试覆盖率目标 >= 80%;外部环境用 mock/fake。 |
| Contract-first | `/recorder/*`、`/v1/*` 和 error schema 必须机器可读并先于实现合入。 |
| 向后兼容 | schema 带 `schemaVersion`;字段默认只增不删不改类型;breaking change 升 major。 |
| 异常处理 | 统一 `DomainError/RunnerError -> HTTP status -> error.code -> caller action` 映射。 |
| 依赖治理 | CI 跑 dependency boundary/circular dependency 检查;Blocker 级问题清零。 |
| 配置管理 | 所有运行配置进入 schema,集中读取、启动校验、非法值返回稳定错误。 |
| 数据一致性 | 临时文件、request registry、trace/cache 有 TTL、原子写、清理与幂等取消策略。 |
| 日志追踪 | `requestId` 贯穿 UI、Local Service、daemon client、high-level module、runner;日志字段 allowlist + redaction。 |
| 团队协作 | 关键设计决策必须有 ADR 或模块内决策记录,说明 Why、备选方案和取舍。 |

## CI Gate

| Gate | 要求 |
| --- | --- |
| unit | URL policy、ranker、schema mapper、request registry、JSONL parser、config parser 覆盖率 >= 80%。 |
| contract | `/recorder/*`、`/v1/*` schema examples 和主要错误场景通过;4 个 schema 文件(`recorder.openapi.yaml`、`high-level.openapi.yaml`、`daemon-high-level.openapi.yaml`、`adapter-recorder.bundle.json`)纳入校验。validator 必须 OpenAPI 3.1 / JSON Schema 2020-12 aware;断言三个 OpenAPI `openapi` 字段为 `3.1.x` 且不含 `nullable`;跨文件 `$ref` 全部指向 `adapter-recorder.bundle.json#/$defs/*`(不得使用裸 `$id` 引用),且能被标准 resolver 解析。 |
| security | CSRF/Origin/header、token redaction、seedArgs HMAC、input.json permission、URL forbidden matrix 通过。 |
| dependency | UI 不直连 daemon/high-level token;Domain 不 import transport/infra;无循环依赖。 |
| lint/typecheck | schema/type drift、unused contract fields、illegal env reads 阻断;ESLint/typescript-eslint 质量规则的 Blocker 级问题清零(等价 Sonar/P3C)。 |
| dependency-hygiene | 锁定依赖版本(lockfile)、统一核心公共依赖版本、CI 阻断冗余/冲突的传递依赖。 |
| docs | 新版本必须更新 changelog、ADR 和模块索引。 |

## Design Review Checklist

- 该设计是否需要 POC/spike。
- 是否新增或变更 schema,是否兼容旧字段。
- 是否新增配置,是否进入 config schema。
- 是否新增 error code,是否进入 error mapping。
- 是否新增模块依赖,是否违反分层。
- 是否新增安全边界,是否有测试矩阵。
- 是否需要 ADR。
