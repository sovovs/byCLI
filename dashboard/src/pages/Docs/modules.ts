// Adapter Recorder System 11 模块元数据 —— 供 Docs 页导航树与阅读区。
// 摘要源自 docs/adapter-recorder-system/README.md 职责表 + 各模块正文提炼。
export interface DocModule {
  id: string; // 文件名(不含扩展名)
  no: string; // 编号
  title: string; // 中文标题
  group: string; // 分组
  summary: string; // 一句话职责
  points: string[]; // 关键要点
  srcPath: string; // 源文件路径
}

const P = 'dashboard-docs/system/adapter-recorder-system';

export const DOC_GROUPS = ['治理与架构', '服务与引擎', '运行与质量', '决策记录'] as const;

export const DOC_MODULES: DocModule[] = [
  {
    id: '00-tdd-governance',
    no: '00',
    title: 'TDD 工程治理',
    group: '治理与架构',
    summary: 'TDD.md 工程治理门禁:可行性、分层、测试、contract、配置、日志、ADR。',
    points: ['每项设计变更须落到对应模块文档', '契约/测试/配置/错误用例进入 CI gate'],
    srcPath: `${P}/00-tdd-governance.md`,
  },
  {
    id: '01-system-overview',
    no: '01',
    title: '系统总览',
    group: '治理与架构',
    summary: '系统目标、进程拓扑、UI 通道选择、端到端流程。',
    points: [
      'UI 只访问 Recorder Local Service,不持有 daemon/high-level token',
      '端到端:Health → Bind → Navigate → Capture A/B → Rank → Init → Verify → Done',
      'verify 必须经 async runner 子进程隔离',
    ],
    srcPath: `${P}/01-system-overview.md`,
  },
  {
    id: '02-architecture-boundaries',
    no: '02',
    title: '架构边界',
    group: '治理与架构',
    summary: '分层架构、依赖方向、ports/adapters、模块边界和 ADR 要求。',
    points: ['六边形架构:Domain 定义 Port,基础设施实现 Adapter', '核心业务代码不直接 import 第三方 SDK/驱动'],
    srcPath: `${P}/02-architecture-boundaries.md`,
  },
  {
    id: '03-contracts-and-versioning',
    no: '03',
    title: '契约与版本',
    group: '服务与引擎',
    summary: '/recorder/* 与 /v1/* contract、schema version、错误映射、request status。',
    points: [
      '统一响应包 { ok, schemaVersion, requestId, data, error }',
      'HTTP 与 IPC 共用同一 schema 源,禁止分叉',
      '字段只增不减;破坏性变更升主版本',
    ],
    srcPath: `${P}/03-contracts-and-versioning.md`,
  },
  {
    id: '04-security-model',
    no: '04',
    title: '安全模型',
    group: '服务与引擎',
    summary: 'CSRF/Origin、Electron XSS、navigation URL policy、token、seedArgs、FS/input.json。',
    points: ['默认 Electron IPC 通道;localhost HTTP 为可选并需 CSRF/Origin 防护', 'report/fixture 只存 evidenceSeedArgs HMAC 摘要'],
    srcPath: `${P}/04-security-model.md`,
  },
  {
    id: '05-recorder-local-service',
    no: '05',
    title: 'Local Service',
    group: '服务与引擎',
    summary: 'Recorder Local Service API、状态机、request registry、strict page lease、daemon client。',
    points: [
      '8 步状态机,每步由显式 endpoint 驱动,无自动跳转',
      '严格 page lease:页面丢失即 page_lost,不自动换 tab',
      '同会话状态转移线性化(mutex / stateVersion CAS)',
    ],
    srcPath: `${P}/05-recorder-local-service.md`,
  },
  {
    id: '06-recorder-core-engine',
    no: '06',
    title: '核心引擎',
    group: '服务与引擎',
    summary: 'Canonical capture schema、Normalize、Rank、Diff、fixtures。',
    points: [
      'normalize 是 rank 的内部步骤,不是独立顶层状态',
      'RankCandidate 与 Init 共用同一 EndpointDescriptor',
      'A/B 配对:method+host+path+mime+bodyShape,再看 key 重叠与时序',
    ],
    srcPath: `${P}/06-recorder-core-engine.md`,
  },
  {
    id: '07-high-level-services',
    no: '07',
    title: 'High-Level 服务',
    group: '服务与引擎',
    summary: 'analyze/init/verify service modules、HTTP wrapper、request status。',
    points: ['analyze 是 in-process async 请求,不需要子进程隔离', 'verify 必须子进程隔离;Local Service 默认同进程 import 模块'],
    srcPath: `${P}/07-high-level-services.md`,
  },
  {
    id: '08-runner-and-isolation',
    no: '08',
    title: 'Runner 与隔离',
    group: '运行与质量',
    summary: 'JSONL runner、子进程隔离、timeout、env allowlist、input.json。',
    points: ['verify-runner 子进程输出 JSONL event/result', 'timeout / env allowlist / input.json 受控'],
    srcPath: `${P}/08-runner-and-isolation.md`,
  },
  {
    id: '09-config-observability',
    no: '09',
    title: '配置与可观测',
    group: '运行与质量',
    summary: 'RecorderConfig、HighLevelConfig、structured logs、requestId、redaction。',
    points: ['结构化日志带 requestId', 'redaction allowlist:禁止 raw seed/token/cookie/body 落日志'],
    srcPath: `${P}/09-config-observability.md`,
  },
  {
    id: '10-fixtures-and-test-plan',
    no: '10',
    title: 'Fixtures 与测试',
    group: '运行与质量',
    summary: 'fixture corpus、URL matrix、contract tests、coverage and CI gates。',
    points: ['核心 domain/service 覆盖率 ≥ 80%', 'contract/schema/dependency/config/error 测试进 CI gate'],
    srcPath: `${P}/10-fixtures-and-test-plan.md`,
  },
  {
    id: '11-roadmap-and-acceptance',
    no: '11',
    title: '路线图与验收',
    group: '运行与质量',
    summary: 'milestone 顺序、MVP 验收、质量门禁。',
    points: ['M1 导航 spike 是唯一实现期硬门禁', 'MVP 验收与质量门禁清单'],
    srcPath: `${P}/11-roadmap-and-acceptance.md`,
  },
  {
    id: 'adr-0001-ui-channel',
    no: 'ADR',
    title: 'ADR 0001 · 默认 UI 通道',
    group: '决策记录',
    summary: '默认 UI 通道为 Electron renderer → preload allowlist → main process。',
    points: ['renderer 永不接触 daemon/high-level token', 'preload 只暴露 typed allowlist 方法;Electron XSS 防护强制'],
    srcPath: `${P}/adr/0001-ui-channel.md`,
  },
];
