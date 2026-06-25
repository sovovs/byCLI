// 安全门禁(04 章 Pure localhost HTTP shape)。每个 side-effect 请求按序校验:
// 1) 自定义 header gate X-Recorder:1  2) Origin allowlist  3) X-byCLI-Token  4) CSRF 双重提交(POST)。
// 任一不过返回对应 ErrorCode,由 server 映射 HTTP status。token/csrf 用恒定时间比较。
import type { IncomingMessage } from 'node:http';
import type { ErrorCode } from '../transport/envelope.js';
import { safeEqual, type BootstrapVault } from './bootstrap.js';

export interface GateResult {
  ok: boolean;
  code?: ErrorCode;
  message?: string;
}

const PASS: GateResult = { ok: true };

export interface GateConfig {
  allowedOrigins: readonly string[];
  vault: BootstrapVault;
}

/** 读单个 header(数组取首项)。 */
function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * side-effect 校验链。isStateChanging=true(POST)时额外校验 CSRF 双重提交。
 * 顺序:header gate → origin → token → csrf。先 header 后 origin,贴 04 章威胁模型。
 */
export function checkGates(req: IncomingMessage, cfg: GateConfig, isStateChanging: boolean): GateResult {
  // 1) 自定义 header gate —— 浏览器跨站无法伪造自定义 header
  if (header(req, 'X-Recorder') !== '1') {
    return { ok: false, code: 'auth_failed', message: 'missing X-Recorder header' };
  }
  // 2) Origin allowlist —— 只认自身 UI origin
  const origin = header(req, 'Origin');
  if (origin !== undefined && !cfg.allowedOrigins.includes(origin)) {
    return { ok: false, code: 'auth_failed', message: 'origin not allowed' };
  }
  // 3) 启动随机 token
  const token = header(req, 'X-byCLI-Token');
  if (!token || !safeEqual(token, cfg.vault.token)) {
    return { ok: false, code: 'auth_failed', message: 'invalid token' };
  }
  // 4) CSRF 双重提交(仅 side-effect POST)
  if (isStateChanging) {
    const csrf = header(req, 'X-CSRF-Token');
    if (!csrf || !safeEqual(csrf, cfg.vault.csrfToken)) {
      return { ok: false, code: 'csrf_failed', message: 'invalid csrf token' };
    }
  }
  return PASS;
}
