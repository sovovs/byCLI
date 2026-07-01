// 内存 session/request registry(05 章 Request Registry + 02 章 RequestRegistryPort)。
// 无持久库(09 章 Data Persistence Boundary);终态 TTL 过期后查询返回 request_not_found。
// 每会话 stateVersion 单调递增 + CAS,保证转移线性化(05 章 linearized transitions)。
import { randomUUID } from 'node:crypto';
import { type SessionState, type SessionAction, canTransition } from './stateMachine.js';
import { type RecordingMode, DEFAULT_RECORDING_MODE } from '@sovovs/bycli-recorder-core';
import type { SynthesisResult } from '../llm/synthesize.js';

export interface Session {
  sessionId: string;
  contextId: string;
  targetId: string | null;
  profileId: string | null;
  state: SessionState;
  stateVersion: number;
  createdAt: number;
  updatedAt: number;
  /** 产品录制形态(应用层策略):tab_projection(投屏,默认)/ embedded_iframe(dashboard 嵌 iframe)。 */
  recordingMode: RecordingMode;
  /** page lease 性质:owned_tab(扩展拥有的录制 tab,投屏)/ bound_dashboard_tab(绑 dashboard 自己的 tab,iframe 模式)/ container_tab(VNC 容器内的 tab)。 */
  leaseKind: 'owned_tab' | 'bound_dashboard_tab' | 'container_tab';
  /** embedded_iframe 模式的目标 iframe URL(bind 时记);captureRead 时作为 targetFrameUrl 下发,扩展据此把噪音过滤到该 iframe。 */
  targetUrl?: string;
  /** vnc 模式:容器宿主映射端口。vncPort=noVNC 画面(前端 iframe 直连);gatewayPort=网关(capture 命令经它反代到容器内 daemon)。 */
  vncPort?: number;
  gatewayPort?: number;
  /** M3→M4: frozen A/B capture samples read by rank (05:51). `entries`=raw network;
   *  `screenshot`=可选页面截图 base64(LLM 合成用,只驻内存不落盘);
   *  `actions`=M-UI-2 用户操作事件(click/input/...,user-action 轨,喂 LLM 时间线用);
   *  `seedEvidence`=dashboard seed 输入派生的 HMAC 证据(deriveEvidenceSeedArgs 产出,**raw seed 绝不落盘**,
   *   M7c),rank 时填进 CaptureSample.seedArgsEvidence 让评分识别 seed→param。 */
  samples?: Partial<Record<'A' | 'B', { entries: unknown[]; screenshot?: string; actions?: unknown[]; seedEvidence?: Record<string, unknown> }>>;
  /** M4→M5b: rank candidates frozen on the session so init can select one by id (H-002). */
  candidates?: Array<{ id: string; [k: string]: unknown }>;
  /** LLM 合成结果缓存(keyed by candidateId):dry-run 生成一次,write 复用同一份
   *  (用户审阅的代码 === 写盘的代码,且不重复调 LLM)。 */
  synthesis?: { candidateId: string; result: SynthesisResult };
  /** N4:pipeline 产出的多脚本草稿(verify 后)+ 0700 草稿目录,供前端展示 + 保存复用。 */
  drafts?: { dir: string; items: Array<{ id: string; [k: string]: unknown }> };
}

export type RequestType = 'analyze' | 'init' | 'verify' | 'capture' | 'rank' | 'pipeline';
export type RequestStatusValue = 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled';

/** pipeline 阶段进度项(score/generate/verify…):前端轮询展示每阶段是否结束 + 耗时。 */
export interface ProgressPhase {
  stage: string;
  status: 'running' | 'done';
  durationMs?: number;
  detail?: string;
}

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
  /** 阶段进度(pipeline 用);轮询时实时更新,前端据此显示 score✓12s/generate…/verify…。 */
  progress?: ProgressPhase[];
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

  createSession(input: { contextId: string; targetId?: string | null; profileId?: string | null; awaitingLogin: boolean; recordingMode?: RecordingMode; targetUrl?: string; vncPort?: number; gatewayPort?: number }): Session {
    const active = [...this.sessions.values()].filter((s) => !['done', 'failed', 'cancelled'].includes(s.state));
    if (active.length >= this.maxSessions) {
      throw Object.assign(new Error('queue_full'), { code: 'queue_full' as const });
    }
    const now = Date.now();
    const recordingMode = input.recordingMode ?? DEFAULT_RECORDING_MODE;
    const leaseKind = recordingMode === 'vnc' ? 'container_tab'
      : recordingMode === 'embedded_iframe' ? 'bound_dashboard_tab'
      : 'owned_tab';
    const session: Session = {
      sessionId: `rec_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      contextId: input.contextId,
      targetId: input.targetId ?? null,
      profileId: input.profileId ?? null,
      state: input.awaitingLogin ? 'awaiting_user_login' : 'session_bound',
      stateVersion: 1,
      createdAt: now,
      updatedAt: now,
      recordingMode,
      // vnc=容器内 tab;iframe 模式绑 dashboard 自己的 tab(bound);投屏模式用扩展 owned tab。
      leaseKind,
      targetUrl: input.targetUrl,
      vncPort: input.vncPort,
      gatewayPort: input.gatewayPort,
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

  /** vnc 模式:记容器宿主映射端口(vncPort=noVNC 画面,gatewayPort=网关→反代容器内 daemon)。 */
  setVncPorts(sessionId: string, vncPort: number, gatewayPort: number): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.vncPort = vncPort;
    s.gatewayPort = gatewayPort;
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

  /** 冻结一份 capture 样本(M4):capture/read 成功后存进 session,供 rank 读(05:51)。
   *  screenshot 可选(LLM 合成用),只驻内存挂在 session 上、不落盘。
   *  seedEvidence 可选(dashboard seed 输入派生的 HMAC 证据,**raw seed 绝不传入此处**)。 */
  storeSample(sessionId: string, sampleName: 'A' | 'B', entries: unknown[], screenshot?: string, actions?: unknown[], seedEvidence?: Record<string, unknown>): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (!s.samples) s.samples = {};
    s.samples[sampleName] = {
      entries,
      ...(screenshot ? { screenshot } : {}),
      ...(actions && actions.length ? { actions } : {}),
      ...(seedEvidence && Object.keys(seedEvidence).length ? { seedEvidence } : {}),
    };
    s.updatedAt = Date.now();
  }

  /** 读 session 冻结的 A/B 样本(M4 rank / LLM 合成用)。缺失返回 undefined。 */
  getSamples(sessionId: string): Partial<Record<'A' | 'B', { entries: unknown[]; screenshot?: string; actions?: unknown[]; seedEvidence?: Record<string, unknown> }>> | undefined {
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

  /** 全部冻结候选(N4 pipeline 评分用)。 */
  getCandidates(sessionId: string): Array<{ id: string; [k: string]: unknown }> | undefined {
    return this.sessions.get(sessionId)?.candidates;
  }

  /** N4:存 pipeline 草稿(dir + items)。 */
  storeDrafts(sessionId: string, dir: string, items: Array<{ id: string; [k: string]: unknown }>): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.drafts = { dir, items };
    s.updatedAt = Date.now();
  }

  getDrafts(sessionId: string): { dir: string; items: Array<{ id: string; [k: string]: unknown }> } | undefined {
    return this.sessions.get(sessionId)?.drafts;
  }

  /** 缓存某候选的 LLM 合成结果(dry-run 生成,write 复用)。 */
  storeSynthesis(sessionId: string, candidateId: string, result: SynthesisResult): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.synthesis = { candidateId, result };
    s.updatedAt = Date.now();
  }

  /** 读某候选的缓存合成结果;candidateId 不匹配(换了候选)→ undefined,触发重新合成。 */
  getSynthesis(sessionId: string, candidateId: string): SynthesisResult | undefined {
    const syn = this.sessions.get(sessionId)?.synthesis;
    return syn && syn.candidateId === candidateId ? syn.result : undefined;
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

  /** pipeline 阶段进度:stage 开始→push running;结束→标 done+耗时。轮询时前端读 progress 展示。 */
  setPhaseRunning(requestId: string, stage: string): void {
    const rec = this.requests.get(requestId);
    if (!rec || TERMINAL_REQUEST.includes(rec.status)) return;
    rec.progress = rec.progress ?? [];
    if (!rec.progress.some((p) => p.stage === stage)) rec.progress.push({ stage, status: 'running' });
    rec.updatedAt = Date.now();
  }
  setPhaseDone(requestId: string, stage: string, durationMs: number, detail?: string): void {
    const rec = this.requests.get(requestId);
    if (!rec || TERMINAL_REQUEST.includes(rec.status)) return;
    rec.progress = rec.progress ?? [];
    const ph = rec.progress.find((p) => p.stage === stage);
    if (ph) { ph.status = 'done'; ph.durationMs = durationMs; if (detail) ph.detail = detail; }
    else rec.progress.push({ stage, status: 'done', durationMs, ...(detail ? { detail } : {}) });
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
