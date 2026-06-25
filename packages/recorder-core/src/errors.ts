// ErrorCode 单一 TS 镜像源。契约源 = adapter-recorder.bundle.json#/$defs/ErrorCode;此处是该枚举的
// 规范 TS 镜像,dashboard-be transport/envelope 与 M9 high-level HTTP wrapper 共享同一 union,避免第三份
// 副本 drift(Q2 改良 A)。注意:ErrorCode → HTTP status 映射是**传输关注点**,不在此(各传输层各持
// STATUS_BY_CODE,见 dashboard-be/src/transport/envelope.ts 与 src/recorder/http/wrapper-envelope.ts)。
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

/** 统一错误体(契约源 = bundle $defs/Error)。 */
export interface RecorderError {
  code: ErrorCode;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}
