// 传输层共享 crypto 原语:启动随机 token + 恒定时间比较。纯 `node:crypto`,无 IO/HTTP/file-writes,
// 合 recorder-core charter(它已用 node:crypto createHmac,verify.ts)。dashboard-be 的安全门禁与
// M9 high-level HTTP wrapper 共享同一实现,消除 security-critical `safeEqual` 的两份副本 drift(Q2 改良 A)。
//
// ⚠️ 作用域纪律(Codex Q2 复核建议):文件名带 "transport" 仅指"传输层共享",**本文件只放纯 crypto
// primitive**(无 `IncomingMessage`/`http`/任何 HTTP 类型)。门禁逻辑(checkWrapperGates / checkGates,
// 绑定 HTTP 类型且 be↔wrapper 语义不同)继续留各自传输层,**不要往 core 塞 HTTP 相关东西**。
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

/** 启动随机 token(base64url)。进程重启即轮换。 */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/**
 * 恒定时间比较,防 token/csrf 比对计时侧信道。先各自 SHA-256 摘要到定长再比 —— 比较时间与
 * 输入长度无关,不因长度不等提前返回而泄漏 secret 长度(M7d · Codex gate 审计 Low)。
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb); // 定长 32B,collision 不可行
}
