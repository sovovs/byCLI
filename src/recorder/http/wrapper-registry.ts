// M9 High-Level HTTP wrapper —— 自有 request registry(覆盖 analyze/init/verify 三类型)。
// 形态镜像 dashboard-be/src/session/registry.ts 的 **request-record 半**,但不要 session 状态机
// (wrapper 无 recorder session 概念)。它是 RequestStatus 的唯一权威:daemon 的 runner registry
// (getRunStatus)是 verify-only 且无 type/时间字段,无法满足 high-level.openapi RequestStatus;
// analyze/init 在 daemon 根本无 registry。verify 仅经 `runnerId` 代理 runner 的 live status。
// 无持久库(09 Data Persistence Boundary);终态 TTL 过期后查询返回 undefined → 404(request_not_found)。
import type {
  RequestType,
  RequestStatusValue,
  RequestStatus,
  RecorderError,
} from './wrapper-envelope.js';

const TERMINAL: readonly RequestStatusValue[] = ['succeeded', 'failed', 'timeout', 'cancelled'];

/** 内部记录:RequestStatus + wrapper-only 字段(投影掉再返给客户端)。 */
interface WrapperRequestRecord extends RequestStatus {
  /** 查询 daemon runner 用的 canonical id(== requestId;保留以解耦 wrapper↔runner id)。 */
  runnerId: string;
}

function project(rec: WrapperRequestRecord): RequestStatus {
  const { runnerId: _runnerId, ...status } = rec;
  return status;
}

export interface WrapperRegistryOptions {
  /** 终态 RequestStatus TTL(过期 → getRequest 返 undefined)。 */
  terminalTtlMs: number;
  /** RequestStatus.pollAfterMs 默认提示。 */
  pollAfterMs: number;
  /** 可注入时钟(测试 TTL 用,仿 session-keys.ts)。 */
  now?: () => number;
}

export class WrapperRegistry {
  private requests = new Map<string, WrapperRequestRecord>();
  private readonly now: () => number;

  constructor(private readonly opts: WrapperRegistryOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** 铸一条 in-flight 记录。init 同步跑完会立刻 finalize;verify/analyze 留 running 待轮询/后台收尾。 */
  createRequest(input: {
    requestId: string;
    type: RequestType;
    runnerId?: string;
    status?: RequestStatusValue;
  }): RequestStatus {
    const t = this.now();
    const rec: WrapperRequestRecord = {
      requestId: input.requestId,
      type: input.type,
      status: input.status ?? 'running',
      startedAt: t,
      updatedAt: t,
      expiresAt: null,
      pollAfterMs: this.opts.pollAfterMs,
      queueReason: null,
      progress: null,
      result: null,
      error: null,
      runnerId: input.runnerId ?? input.requestId,
    };
    this.requests.set(input.requestId, rec);
    return project(rec);
  }

  /** 合并一条非终态 status/result/error/queueReason 更新;终态记录不可变。 */
  updateRequest(
    requestId: string,
    patch: { status?: RequestStatusValue; result?: unknown; error?: RecorderError; queueReason?: 'profile_busy' | 'queue_full' | null },
  ): void {
    const rec = this.requests.get(requestId);
    if (!rec) return;
    if (TERMINAL.includes(rec.status)) return;
    if (patch.status) rec.status = patch.status;
    if (patch.result !== undefined) rec.result = patch.result;
    if (patch.error !== undefined) rec.error = patch.error;
    if (patch.queueReason !== undefined) rec.queueReason = patch.queueReason;
    rec.updatedAt = this.now();
  }

  /** 置终态 + 武装 TTL(终态过期 → getRequest 返 undefined → 404)。已终态则幂等 no-op。 */
  finalizeRequest(
    requestId: string,
    patch: { status: 'succeeded' | 'failed' | 'timeout' | 'cancelled'; result?: unknown; error?: RecorderError },
  ): void {
    const rec = this.requests.get(requestId);
    if (!rec) return;
    if (TERMINAL.includes(rec.status)) return;
    rec.status = patch.status;
    if (patch.result !== undefined) rec.result = patch.result;
    if (patch.error !== undefined) rec.error = patch.error;
    const t = this.now();
    rec.updatedAt = t;
    rec.expiresAt = t + this.opts.terminalTtlMs;
  }

  /** 面向客户端的 RequestStatus(TTL 校验,wrapper-only 字段投影掉)。 */
  getRequest(id: string): RequestStatus | undefined {
    const rec = this.getRecord(id);
    return rec ? project(rec) : undefined;
  }

  /** 内部记录(含 runnerId;handler 用,不返客户端)。TTL 过期即删并返 undefined。 */
  getRecord(id: string): WrapperRequestRecord | undefined {
    const r = this.requests.get(id);
    if (!r) return undefined;
    if (r.expiresAt !== null && this.now() > r.expiresAt) {
      this.requests.delete(id);
      return undefined; // TTL 过期 → request_not_found
    }
    return r;
  }

  /**
   * 周期清理:删除所有已过 TTL 的终态记录(getRecord 只在"被访问"时删,abandoned 的终态记录否则常驻
   * 内存)。non-terminal 记录 expiresAt=null,绝不被清。返回清理条数。
   */
  sweepExpired(): number {
    const t = this.now();
    let removed = 0;
    for (const [id, rec] of this.requests) {
      if (rec.expiresAt !== null && t > rec.expiresAt) {
        this.requests.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
