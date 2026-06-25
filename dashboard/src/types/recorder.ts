// Adapter Recorder 契约类型 —— 对齐 docs/adapter-recorder-system/schemas/adapter-recorder.bundle.json ($defs)
// 修改本文件须同步 schema bundle(prose 与 schema 必须一起更新)。

/** 统一响应包(03 · Contracts) */
export interface RequestEnvelope<T = unknown> {
  ok: boolean;
  schemaVersion: 'recorder.v1';
  requestId: string;
  data: T | null;
  error: RecorderError | null;
}

/** 错误码枚举(schema $defs/ErrorCode) */
export type ErrorCode =
  | 'validation_failed'
  | 'invalid_state'
  | 'csrf_failed'
  | 'auth_failed'
  | 'auth_required'
  | 'responsible_use_required'
  | 'network_error'
  | 'insufficient_samples'
  | 'daemon_unavailable'
  | 'extension_disconnected'
  | 'profile_busy'
  | 'queue_full'
  | 'page_lost'
  | 'navigation_url_forbidden'
  | 'navigation_redirect_requires_interception'
  | 'dns_resolution_failed'
  | 'request_not_found'
  | 'idempotency_conflict'
  | 'temp_store_full'
  | 'verify_timeout'
  | 'analyze_timeout'
  | 'adapter_runtime_error'
  | 'runner_protocol_error'
  | 'shape_mismatch'
  | 'fixture_mismatch'
  | 'output_truncated'
  | 'feature_disabled'
  | 'config_invalid';

export interface RecorderError {
  code: ErrorCode;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

/** 会话状态机(05 · State Machine) */
export type SessionState =
  | 'idle'
  | 'health_checked'
  | 'session_bound'
  | 'awaiting_user_login'
  | 'auth_confirmed'
  | 'page_ready'
  | 'capture_a'
  | 'capture_b'
  | 'ranked'
  | 'draft_created'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled';

/** EndpointDescriptor($defs) */
export interface EndpointDescriptor {
  method: string;
  urlTemplate: string;
  host: string;
  pathname: string;
  queryParams?: Record<string, unknown>;
  dynamicParams?: string[];
  excludedParams?: string[];
  requestBodyShape?: {
    type?: 'json' | 'form' | 'text' | 'empty';
    keys?: string[];
  };
  authRequired?: boolean;
}

/** ArgMapping($defs) */
export interface ArgMapping {
  argName: string;
  in: 'query' | 'body' | 'path' | 'header';
  paramName: string;
  valueType?: string;
  evidenceId?: string;
}

/** ResponseShape($defs) */
export interface ResponseShape {
  kind?: 'array' | 'object' | 'scalar' | 'html' | 'unknown';
  itemKeys?: string[];
  count?: number;
  shapeConfidence?: number;
  echoesSeedArg?: boolean;
}

/** ColumnDescriptor($defs) */
export interface ColumnDescriptor {
  name: string;
  path: string;
  type?: string;
}

/** ScoreExplanationItem($defs) */
export interface ScoreExplanationItem {
  signal: string;
  delta: number;
  detail?: string;
}

export type Confidence = 'high' | 'medium' | 'low' | 'rejected';

/** RankCandidate($defs) —— rank 步骤核心输出 */
export interface RankCandidate {
  id: string;
  endpoint: EndpointDescriptor;
  score: number;
  confidence: Confidence;
  reviewRequired: boolean;
  args?: ArgMapping[];
  excludedParams?: string[];
  responseShape?: ResponseShape;
  columns?: ColumnDescriptor[];
  scoreExplanation?: ScoreExplanationItem[];
  risks?: string[];
  evidenceIds?: string[];
}

/** capture 样本里的单条网络条目(精简自 RecorderNetworkEntry,用于 UI 展示) */
export interface NetworkEntry {
  requestId: string;
  method: string;
  url: string;
  host?: string;
  pathname?: string;
  response?: {
    status?: number;
    mime?: string;
    bodyShape?: { kind?: string; itemKeys?: string[] };
  };
  timing?: { startedAt?: number; durationMs?: number };
}

export interface CaptureSample {
  sampleName: 'A' | 'B';
  entries: NetworkEntry[];
}

/** /recorder/health 返回 */
export interface HealthReport {
  localService: 'ok' | 'down';
  daemon: 'ok' | 'down';
  extension: 'ok' | 'disconnected';
  highLevel: 'ok' | 'down';
}

/** RecorderReport(bundle $defs/RecorderReport)—— init 预览/写入产出的报告 */
export interface RecorderReport {
  adapterPath: string;
  reportPath: string;
  warnings?: string[];
  /** ADR-0005 责任声明确认时刻(write 时由客户端写入) */
  responsibleUseAcknowledgedAt: number;
  /** 09 配置快照:发布通道 / 实验 profile / 快照版本(config 驱动的字符串/数值) */
  releaseChannel: string;
  localExperimentProfile: string;
  configSnapshotVersion: number;
}

/** dry-run diff 摘要(daemon /v1/init 响应 dryRun;契约无 unified-diff 字符串) */
export interface DryRunDiff {
  exists: boolean;
  changedLines: number | null;
}

/** init 结果(be /recorder/init 200 同步响应:report + dryRun)——取代旧扁平 AdapterDraft */
export interface InitResult {
  report: RecorderReport;
  dryRun: DryRunDiff;
}

/** verify runner 事件(JSONL) */
export interface VerifyEvent {
  type: 'started' | 'progress' | 'result' | 'error';
  requestId: string;
  stage?: string;
  message?: string;
}

/**
 * verify 结果摘要(bundle $defs/VerifySummary)。
 * 安全设计(M7c redaction):仅返回脱敏后的 shape —— 行数 + 字段**数**(非列名,列名可能是 seed 值),
 * **不含原始行数据**、无 stdout/stderr、trace 仅保留 retained 标志;execute 阶段错误只留安全 code +
 * 固定文案。取代旧 VerifyResult(rows 数组)。
 */
export interface VerifySummary {
  ok: boolean;
  stage?: string;
  /** 命中行数(非行数据) */
  rows?: number;
  /** 产出行的字段数(非列名 —— Codex M7c:列名可能被 adapter 用 seed 值当 key) */
  fieldCount?: number;
  fixture?: { status: string };
  trace?: { retained: boolean };
  error?: { code: ErrorCode; message: string; hint?: string };
}
