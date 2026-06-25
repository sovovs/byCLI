// 启动随机 token + CSRF token 生成 + 一次性 bootstrap 注入(04 章 Token Lifecycle)。
// token 内存生成、绝不落日志;前端经 bootstrap 端点单次取走,存入 sessionStorage(见前端 readBootstrap)。
// randomToken/safeEqual 现抽进 @sovovs/bycli-recorder-core(transport-crypto),be 与 M9 high-level
// wrapper 共享同一 security-critical 实现(Q2 改良 A);此处 re-export 保持原 import 路径稳定。
import { randomToken, safeEqual } from '@sovovs/bycli-recorder-core';

export { randomToken, safeEqual };

/**
 * 一次性 bootstrap:启动生成 nonce,前端 GET /__bootstrap?nonce=... 单次换取 token+csrfToken,
 * 取走即失效(04 章 one-time bootstrap)。这里用内存单次标记,进程重启即轮换。
 */
export class BootstrapVault {
  readonly token: string;
  readonly csrfToken: string;
  private readonly nonce: string;
  private consumed = false;

  constructor(token: string) {
    this.token = token;
    this.csrfToken = randomToken(24);
    this.nonce = randomToken(18);
  }

  /** 启动时打印给本地 UI 取用的一次性 URL nonce(不打印 token 本身)。 */
  get bootstrapNonce(): string {
    return this.nonce;
  }

  /** 单次换取;nonce 不符或已消费返回 null。 */
  consume(nonce: string): { token: string; csrfToken: string } | null {
    if (this.consumed) return null;
    if (!safeEqual(nonce, this.nonce)) return null;
    this.consumed = true;
    return { token: this.token, csrfToken: this.csrfToken };
  }
}
