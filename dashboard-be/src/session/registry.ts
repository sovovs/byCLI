// 内存 session/request registry(05 章 Request Registry + 02 章 RequestRegistryPort)。
// 无持久库(09 章 Data Persistence Boundary);终态 TTL 过期后查询返回 request_not_found。
// 每会话 stateVersion 单调递增 + CAS,保证转移线性化(05 章 linearized transitions)。
import { randomUUID } from 'node:crypto';
import { type SessionState, type SessionAction, canTransition } from './stateMachine.js';

export interface Session {
  sessionId: string;
  contextId: string;
  targetId: string | null;
  profileId: string | null;
  state: SessionState;
  stateVersion: number;
  createdAt: number;
  updatedAt: number;
  /** M3→M4: frozen A/B capture samples (raw entries) read by rank (05:51). */
  samples?: Partial<Record<'A' | 'B', unknown[]>>;
  /** M4→M5b: rank candidates frozen on the session so init can select one by id (H-002). */
  candidates?: Array<{ id: string; [k: string]: unknown }>;
}

export type RequestType = 'analyze' | 'init' | 'verify' | 'capture' | 'rank';
export type RequestStatusValue = 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled';

export interface RequestStatus {
  requestId: string;
  type: RequestType;
  status: RequestStatusValue;
  startedAt: number;
  updatedAt: number;
  expiresAt: number | null;
  pollAfterMs: number | null;
  result: unknown;
  error: unknown;
}

/** Internal request ledger: RequestStatus + be-only fields (never returned to the UI). */
interface RequestRecord extends RequestStatus {
  sessionId: string;
  contextId: string;
  profileId: string | null;
  /** Canonical id used to query the daemon (== requestId; kept for be/daemon id decoupling). */
  daemonRequestId: string;
}

const TERMINAL_REQUEST: RequestStatusValue[] = ['succeeded', 'failed', 'timeout', 'cancelled'];

/** Project the internal record down to the UI-facing RequestStatus (drop be-only fields). */
function projectRequest(rec: RequestRecord): RequestStatus {
  const { sessionId, contextId, profileId, daemonRequestId, ...status } = rec;
  return status;
}

interface IdempotencyRecord {
  payloadHash: string;
  sessionId: string;
}

export class Registry {
  private sessions = new Map<string, Session>();
  private requests = new Map<string, RequestRecord>();
  // 幂等:key = uiSessionId|endpoint|idempotencyKey(03 章 scope)
  private idempotency = new Map<string, IdempotencyRecord>();

  constructor(
    private readonly maxSessions: number,
    private readonly terminalTtlMs: number,
  ) {}

  // ---- session ----

  createSession(input: { contextId: string; targetId?: string | null; profileId?: string | null; awaitingLogin: boolean }): Session {
    const active = [...this.sessions.values()].filter((s) => !['done', 'failed', 'cancelled'].includes(s.state));
    if (active.length >= this.maxSessions) {
      throw Object.assign(new Error('queue_full'), { code: 'queue_full' as const });
    }
    const now = Date.now();
    const session: Session = {
      sessionId: `rec_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      contextId: input.contextId,
      targetId: input.targetId ?? null,
      profileId: input.profileId ?? null,
      state: input.awaitingLogin ? 'awaiting_user_login' : 'session_bound',
      stateVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * 校验并推进状态(CAS:expectedVersion 必须等于当前 stateVersion)。
   * 非法转移返回 {ok:false, reason:'invalid_state'};版本冲突返回 'queue_full'。
   */
  advance(
    sessionId: string,
    action: SessionAction,
    next: SessionState,
    expectedVersion: number,
  ): { ok: true; session: Session } | { ok: false; reason: 'invalid_state' | 'queue_full' | 'request_not_found' } {
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, reason: 'request_not_found' };
    if (s.stateVersion !== expectedVersion) return { ok: false, reason: 'queue_full' };
    if (!canTransition(s.state, action)) return { ok: false, reason: 'invalid_state' };
    s.state = next;
    s.stateVersion += 1;
    s.updatedAt = Date.now();
    return { ok: true, session: s };
  }

  /** 记录 page ownership(M3):navigate 成功后把 daemon 返回的 page identity 绑到 session。 */
  setPage(sessionId: string, targetId: string | null): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.targetId = targetId;
    s.updatedAt = Date.now();
  }

  /** 异常租约丢失 fail-fast(M3):stale page / daemon 不可达 → 会话落 failed,不重试。 */
  markFailed(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.state = 'failed';
    s.stateVersion += 1;
    s.updatedAt = Date.now();
  }

  /** verify 终态推进(轮询线程无 stateVersion,不走 CAS):仅从 verifying → done|failed(05:63)。 */
  settleVerify(sessionId: string, ok: boolean): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.state !== 'verifying') return;
    s.state = ok ? 'done' : 'failed';
    s.stateVersion += 1;
    s.updatedAt = Date.now();
  }

  /** 冻结一份 capture 样本(M4):capture/read 成功后存进 session,供 rank 读(05:51)。 */
  storeSample(sessionId: string, sampleName: 'A' | 'B', entries: unknown[]): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (!s.samples) s.samples = {};
    s.samples[sampleName] = entries;
    s.updatedAt = Date.now();
  }

  /** 读 session 冻结的 A/B 样本(M4 rank 用)。缺失返回 undefined。 */
  getSamples(sessionId: string): Partial<Record<'A' | 'B', unknown[]>> | undefined {
    return this.sessions.get(sessionId)?.samples;
  }

  /** Freeze rank candidates on the session (H-002): init selects one by id. */
  storeCandidates(sessionId: string, candidates: Array<{ id: string; [k: string]: unknown }>): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.candidates = candidates;
    s.updatedAt = Date.now();
  }

  /** Look up a frozen rank candidate by id (H-002 · init derivation). */
  getCandidate(sessionId: string, candidateId: string): { id: string; [k: string]: unknown } | undefined {
    return this.sessions.get(sessionId)?.candidates?.find((c) => c.id === candidateId);
  }

  // ---- request status ----

  /** Create an in-flight request record (verify/analyze async lifecycle, 05 Request Registry). */
  createRequest(input: {
    requestId: string;
    type: RequestType;
    sessionId: string;
    contextId: string;
    profileId: string | null;
    daemonRequestId?: string;
    pollAfterMs?: number | null;
  }): RequestStatus {
    const now = Date.now();
    const rec: RequestRecord = {
      requestId: input.requestId,
      type: input.type,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      expiresAt: null,
      pollAfterMs: input.pollAfterMs ?? null,
      result: null,
      error: null,
      sessionId: input.sessionId,
      contextId: input.contextId,
      profileId: input.profileId,
      daemonRequestId: input.daemonRequestId ?? input.requestId,
    };
    this.requests.set(input.requestId, rec);
    return projectRequest(rec);
  }

  /** Merge a non-terminal status/result/error update; terminal records are immutable. */
  updateRequest(requestId: string, patch: { status?: RequestStatusValue; result?: unknown; error?: unknown }): void {
    const rec = this.requests.get(requestId);
    if (!rec) return;
    if (TERMINAL_REQUEST.includes(rec.status)) return;
    if (patch.status) rec.status = patch.status;
    if (patch.result !== undefined) rec.result = patch.result;
    if (patch.error !== undefined) rec.error = patch.error;
    rec.updatedAt = Date.now();
  }

  /** Set a terminal status + arm the TTL (terminal status expires → request_not_found). */
  finalizeRequest(requestId: string, patch: { status: 'succeeded' | 'failed' | 'timeout' | 'cancelled'; result?: unknown; error?: unknown }): void {
    const rec = this.requests.get(requestId);
    if (!rec) return;
    rec.status = patch.status;
    if (patch.result !== undefined) rec.result = patch.result;
    if (patch.error !== undefined) rec.error = patch.error;
    rec.updatedAt = Date.now();
    rec.expiresAt = Date.now() + this.terminalTtlMs;
  }

  /** UI-facing status (TTL-checked, internal ledger fields projected out). */
  getRequest(id: string): RequestStatus | undefined {
    const rec = this.getRequestRecord(id);
    return rec ? projectRequest(rec) : undefined;
  }

  /** Internal record incl. sessionId/daemonRequestId (be handler use; not for UI). */
  getRequestRecord(id: string): RequestRecord | undefined {
    const r = this.requests.get(id);
    if (!r) return undefined;
    if (r.expiresAt !== null && Date.now() > r.expiresAt) {
      this.requests.delete(id);
      return undefined; // TTL 过期 → request_not_found
    }
    return r;
  }

  // ---- idempotency(03 章)----

  /** 返回已有记录(命中且 payload 一致),或 'conflict'(同 key 不同 payload),或 null(新键)。 */
  checkIdempotency(scope: string, payloadHash: string): IdempotencyRecord | 'conflict' | null {
    const rec = this.idempotency.get(scope);
    if (!rec) return null;
    return rec.payloadHash === payloadHash ? rec : 'conflict';
  }

  recordIdempotency(scope: string, payloadHash: string, sessionId: string): void {
    this.idempotency.set(scope, { payloadHash, sessionId });
  }

  /** cancel:幂等清理会话(05 章 any→cancelled)。 */
  cancelSession(sessionId: string): Session | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    if (!['done', 'failed', 'cancelled'].includes(s.state)) {
      s.state = 'cancelled';
      s.stateVersion += 1;
      s.updatedAt = Date.now();
    }
    return s;
  }

  /** Cancel all sessions (lifecycle reset; used by tests to reset the active count). */
  cancelAll(): void {
    for (const id of [...this.sessions.keys()]) this.cancelSession(id);
  }
}
