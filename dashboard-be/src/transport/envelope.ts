// 统一响应包(03 章 ApiResponse)+ ErrorCode→HTTP status 映射(03 章 Error Mapping 表)。
// envelope 形状与前端 RequestEnvelope / OpenAPI ApiResponse 一致;ErrorCode/RecorderError 现抽进
// @sovovs/bycli-recorder-core(errors.ts)作单一 TS 镜像源,be 与 M9 wrapper 共享同一 union(Q2 改良 A);
// 此处 re-export 保持原 import 路径稳定。**HTTP status 映射是传输关注点,故意留在本传输层,不进 core**。
import { randomUUID } from 'node:crypto';
import type { ErrorCode, RecorderError } from '@sovovs/bycli-recorder-core';

export type { ErrorCode, RecorderError };

export interface ApiResponse<T = unknown> {
  ok: boolean;
  schemaVersion: 'recorder.v1';
  requestId: string;
  data: T | null;
  error: RecorderError | null;
}

export const newRequestId = (): string => `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

export function ok<T>(data: T, requestId = newRequestId()): ApiResponse<T> {
  return { ok: true, schemaVersion: 'recorder.v1', requestId, data, error: null };
}

export function fail(error: RecorderError, requestId = newRequestId()): ApiResponse<never> {
  return { ok: false, schemaVersion: 'recorder.v1', requestId, data: null, error };
}

/** 03 章 Error Mapping:ErrorCode → HTTP status。未列出的兜底 500。 */
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

export const httpStatusFor = (code: ErrorCode): number => STATUS_BY_CODE[code] ?? 500;
