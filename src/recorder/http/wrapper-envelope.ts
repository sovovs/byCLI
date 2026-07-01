// M9 High-Level HTTP wrapper —— 响应封装(high-level.openapi.yaml:97-216)。
// AcceptedResponse(202)/ RequestStatus(200)wire 形状 + ErrorCode→HTTP status 映射。
// ErrorCode/RecorderError 从 @sovovs/bycli-recorder-core 取(单一 TS 镜像源,Q2 改良 A);
// **STATUS_BY_CODE 是传输关注点,故意留在本传输层、不进 recorder-core**(与 be envelope 各持一份,
// 值同步自 03 章 Error Mapping 表)。schemaVersion 字面量 'high-level.v1'(与 be 的 'recorder.v1' 不同)。
import { randomUUID } from 'node:crypto';
import type { ErrorCode, RecorderError } from '@sovovs/bycli-recorder-core';

export type { ErrorCode, RecorderError };

/** RequestStatus.type(high-level.openapi.yaml:188-190)。 */
export type RequestType = 'analyze' | 'init' | 'verify';

/** RequestStatus.status(high-level.openapi.yaml:191-193);与 runner-port RunStatus 一致。 */
export type RequestStatusValue = 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled';

/** 202 AcceptedResponse(high-level.openapi.yaml:97-109)。 */
export interface AcceptedResponse {
  requestId: string;
  schemaVersion: 'high-level.v1';
  error: RecorderError | null;
}

/** 200 RequestStatus(high-level.openapi.yaml:182-216)。 */
export interface RequestStatus {
  requestId: string;
  type: RequestType;
  status: RequestStatusValue;
  startedAt: number;
  updatedAt: number;
  expiresAt: number | null;
  pollAfterMs: number | null;
  queueReason: 'profile_busy' | 'queue_full' | null;
  // result/progress 在 wire 上是 object|null;TS 边界用 unknown(对齐 be RequestStatus),避免把
  // RecorderReport/VerifySummary/AnalyzeReport 等具名接口赋给 Record<string,unknown> 的 index-signature 摩擦。
  progress: unknown;
  result: unknown;
  error: RecorderError | null;
}

/** 请求 id:req_<16hex>(传输层细节,与 be newRequestId 对齐格式)。 */
export const newRequestId = (): string => `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

export const accepted = (requestId: string, error: RecorderError | null = null): AcceptedResponse => ({
  requestId,
  schemaVersion: 'high-level.v1',
  error,
});

// 03 章 Error Mapping:ErrorCode → HTTP status。未列出兜底 500。**传输关注点,故意留本层(不进 core)**。
// `Record<ErrorCode, number>` 保证新增 code 时编译期 exhaustiveness 压力。⚠️ 值的唯一权威 = 03 章 Error
// Mapping 表;本表必须与 dashboard-be/src/transport/envelope.ts 的 STATUS_BY_CODE **保持值一致**(两份
// 各自传输层持有,边界正确但值会 drift;改一处必同步另一处 + 见 wrapper.test.ts 的关键码钉值测试)。
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_failed: 400,
  invalid_state: 400,
  insufficient_samples: 400,
  navigation_url_forbidden: 400,
  navigation_redirect_requires_interception: 400,
  dns_resolution_failed: 400,
  page_lost: 400,
  csrf_failed: 403,
  auth_failed: 403,
  feature_disabled: 403,
  auth_required: 500,
  responsible_use_required: 400,
  ambiguous_iframe_target: 400,
  request_not_found: 404,
  idempotency_conflict: 409,
  queue_full: 429,
  profile_busy: 429,
  daemon_unavailable: 503,
  extension_disconnected: 503,
  network_error: 503,
  verify_timeout: 504,
  analyze_timeout: 504,
  runner_protocol_error: 500,
  adapter_runtime_error: 500,
  shape_mismatch: 500,
  fixture_mismatch: 500,
  output_truncated: 500,
  temp_store_full: 507,
  config_invalid: 500,
};

export const httpStatusForHighLevel = (code: ErrorCode): number => STATUS_BY_CODE[code] ?? 500;

export const errorBody = (code: ErrorCode, message: string, hint?: string): RecorderError =>
  hint ? { code, message, hint } : { code, message };
