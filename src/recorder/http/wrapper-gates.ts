// M9 High-Level HTTP wrapper —— 门禁(07 · Optional HTTP Wrapper:bind 127.0.0.1 + X-byCLI + 启动随机
// X-byCLI-Token + Origin allowlist,AND 组合)。形态 copy-port 自 dashboard-be/src/security/gates.ts,
// 但裁掉 CSRF 双重提交(M9 无浏览器 UI 调它,OpenAPI security 只有 ByCliHeader + ByCliToken),且 header
// 用 X-byCLI(be 用 X-Recorder)。带 IncomingMessage(HTTP 类型)故留传输层、不进 recorder-core;
// token 比较复用 core 的 safeEqual(security-critical,单源,Q2 改良 A)。
import type { IncomingMessage } from 'node:http';
import { safeEqual } from '@sovovs/bycli-recorder-core';

export interface WrapperGateResult {
  ok: boolean;
  /** 仅 auth_failed(门禁层不区分细分原因,避免给攻击者反馈)。 */
  code?: 'auth_failed';
  message?: string;
}

const PASS: WrapperGateResult = { ok: true };

export interface WrapperGateConfig {
  allowedOrigins: readonly string[];
  token: string;
}

/** 读单个 header(数组取首项)。 */
function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * 门禁校验链(顺序:header → origin → token)。比 daemon /v1/*(仅 X-byCLI presence)强一档 —— 多了
 * 启动随机 token secret 这层。所有端点(含 /health)统一过此链(无契约理由豁免 health)。
 */
export function checkWrapperGates(req: IncomingMessage, cfg: WrapperGateConfig): WrapperGateResult {
  // 1) 自定义 header gate —— 浏览器跨站无法伪造自定义 header(07 · X-byCLI:1)
  if (header(req, 'X-byCLI') !== '1') {
    return { ok: false, code: 'auth_failed', message: 'missing X-byCLI header' };
  }
  // 2) Origin allowlist —— 程序客户端不发 Origin 即放行;浏览器发非白名单 Origin 则拒
  const origin = header(req, 'Origin');
  if (origin !== undefined && !cfg.allowedOrigins.includes(origin)) {
    return { ok: false, code: 'auth_failed', message: 'origin not allowed' };
  }
  // 3) 启动随机 token secret(X-byCLI-Token,恒定时间比较)
  const token = header(req, 'X-byCLI-Token');
  if (!token || !safeEqual(token, cfg.token)) {
    return { ok: false, code: 'auth_failed', message: 'invalid token' };
  }
  return PASS;
}
