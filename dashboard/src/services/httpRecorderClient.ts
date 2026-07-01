// localhost HTTP transport 实现(04 章 Pure localhost HTTP shape + 03 章契约/轮询)。
// 安全门禁:X-Recorder:1 自定义 header、X-byCLI-Token、CSRF 双重提交、credentials:include、
// side-effect 一律 POST、Idempotency-Key。init/verify 202 → 内部轮询 GET /recorder/requests/{id}。
// 注意:这是与 dashboard-be 对接的客户端骨架,无后端时不会被 factory 选中(bootstrap 缺失即回落 mock)。
import type {
  CaptureSample,
  ErrorCode,
  HealthReport,
  InitResult,
  NetworkEntry,
  PipelineResult,
  PipelinePrompts,
  RankCandidate,
  RequestEnvelope,
  SaveResult,
  VerifySummary,
} from '@/types/recorder';
import type { BindMode, BindResult, RecorderBootstrap, RecorderClient, RecordingMode, SessionAdvanceResult, WritePolicy } from './recorderClient';

/**
 * be /recorder/capture/read 透传 daemon 原始抓包条目(非契约 RecorderNetworkEntry,见 #8 BE↔契约 gap),
 * 这里仅做 transport→UI 展示映射(rank 在服务端做,展示丢失字段不影响链路)。
 */
function mapRawEntry(e: Record<string, unknown>): NetworkEntry {
  const url = typeof e.url === 'string' ? e.url : '';
  let host: string | undefined;
  let pathname: string | undefined;
  try {
    const u = new URL(url);
    host = u.host;
    pathname = u.pathname;
  } catch {
    /* 非绝对 URL 时跳过 */
  }
  const status = typeof e.responseStatus === 'number' ? e.responseStatus : typeof e.status === 'number' ? e.status : undefined;
  const mime = typeof e.responseContentType === 'string' ? e.responseContentType : typeof e.contentType === 'string' ? e.contentType : undefined;
  return {
    requestId: typeof e.requestId === 'string' ? e.requestId : '',
    method: typeof e.method === 'string' ? e.method : 'GET',
    url,
    host,
    pathname,
    response: status !== undefined || mime !== undefined ? { status, mime } : undefined,
    timing: { startedAt: typeof e.startedAt === 'number' ? e.startedAt : undefined, durationMs: typeof e.durationMs === 'number' ? e.durationMs : undefined },
  };
}

interface RequestStatus<T = unknown> {
  requestId: string;
  type: 'analyze' | 'init' | 'verify' | 'capture' | 'rank' | 'pipeline';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled';
  startedAt: number;
  updatedAt: number;
  expiresAt?: number | null;
  pollAfterMs?: number | null;
  result?: T | null;
  error?: RequestEnvelope['error'];
  /** pipeline 阶段进度(score/generate/verify…),轮询时实时更新。 */
  progress?: Array<{ stage: string; status: 'running' | 'done'; durationMs?: number; detail?: string }>;
}

/** pipeline 阶段进度回调类型(对外导出供 client 签名复用)。 */
export type ProgressPhase = { stage: string; status: 'running' | 'done'; durationMs?: number; detail?: string };

/** mode → 契约枚举(03/05 章 SessionBindRequest.mode) */
const BIND_MODE_MAP: Record<BindMode, string> = {
  existing: 'bind_existing_page',
  await_login: 'create_page_await_user_login',
};

const POLL_FALLBACK_MS = 1000;
const POLL_TIMEOUT_MS = 120_000;

let seq = 0;
const clientRequestId = () => `cli_${Date.now().toString(36)}_${(++seq).toString(36)}`;

function envelopeError(code: ErrorCode, message: string): RequestEnvelope<never> {
  return { ok: false, schemaVersion: 'recorder.v1', requestId: '', data: null, error: { code, message } };
}

export function createHttpRecorderClient(bootstrap: RecorderBootstrap): RecorderClient {
  const base = bootstrap.baseUrl.replace(/\/$/, '');
  // RecorderClient 接口不带 sessionId(对齐 mock 隐式单会话语义);真实 be 每个 body 要求 sessionId,
  // 故在 client 内部持有 bind 返回的 sessionId,后续 side-effect 自动注入。bind 失败/reset 前为 null。
  let sessionId: string | null = null;

  /** 统一请求:注入 04 门禁 header,返回解析后的 envelope(网络异常映射为 network_error) */
  async function call<T>(
    path: string,
    opts: { method?: 'GET' | 'POST'; body?: unknown; idempotent?: boolean } = {},
  ): Promise<RequestEnvelope<T>> {
    const method = opts.method ?? 'POST';
    const headers: Record<string, string> = {
      // 04 章:自定义 header gate + token + CSRF 双重提交
      'X-Recorder': '1',
      'X-byCLI-Token': bootstrap.token,
    };
    if (bootstrap.csrfToken) headers['X-CSRF-Token'] = bootstrap.csrfToken;
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    // side-effect POST 带幂等键(03 章 Idempotency)
    if (method === 'POST' && opts.idempotent !== false) headers['Idempotency-Key'] = clientRequestId();

    // 自动注入 sessionId:真实 be 每个 side-effect body required sessionId(OpenAPI),
    // 而 RecorderClient 接口不暴露它 → bind 后由 client 持有并补入(已显式给的不覆盖)。
    const body =
      method === 'POST' && sessionId && typeof opts.body === 'object' && opts.body !== null
        ? { sessionId, ...(opts.body as Record<string, unknown>) }
        : opts.body;

    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        // CSRF SameSite=Strict cookie 需要随请求带上
        credentials: 'include',
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      });
      const json = (await res.json()) as RequestEnvelope<T>;
      return json;
    } catch (e) {
      return envelopeError('network_error', e instanceof Error ? e.message : '请求失败') as RequestEnvelope<T>;
    }
  }

  /**
   * 202 异步轮询(03 章):init/verify 返回 requestId 后,轮询 GET /recorder/requests/{id}
   * 至 terminal,再把 result/error 还原成 RequestEnvelope<T>,对上层抹平同步/异步差异。
   */
  async function poll<T>(requestId: string, onProgress?: (phases: ProgressPhase[]) => void): Promise<RequestEnvelope<T>> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const res = await call<RequestStatus<T>>(`/recorder/requests/${encodeURIComponent(requestId)}`, {
        method: 'GET',
      });
      // 状态查询本身失败(如 404 request_not_found)直接透传
      if (!res.ok || res.data === null) return res as unknown as RequestEnvelope<T>;
      const st = res.data as unknown as RequestStatus<T>;
      if (onProgress && st.progress) onProgress(st.progress);
      if (st.status === 'succeeded') {
        return { ok: true, schemaVersion: 'recorder.v1', requestId, data: (st.result ?? null) as T, error: null };
      }
      if (st.status === 'failed' || st.status === 'timeout' || st.status === 'cancelled') {
        return {
          ok: false,
          schemaVersion: 'recorder.v1',
          requestId,
          data: null,
          error: st.error ?? { code: 'adapter_runtime_error', message: `请求 ${st.status}` },
        };
      }
      await new Promise((r) => setTimeout(r, st.pollAfterMs ?? POLL_FALLBACK_MS));
    }
    return envelopeError('verify_timeout', '轮询超时') as RequestEnvelope<T>;
  }

  /** 发起 202 异步请求并轮询到最终结果(onProgress:轮询途中实时回调阶段进度,用于 pipeline 展示)。 */
  async function callAsync<T>(path: string, body: unknown, onProgress?: (phases: ProgressPhase[]) => void): Promise<RequestEnvelope<T>> {
    const accepted = await call<unknown>(path, { body });
    if (!accepted.ok || !accepted.requestId) return accepted as RequestEnvelope<T>;
    return poll<T>(accepted.requestId, onProgress);
  }

  return {
    health: () => call<HealthReport>('/recorder/health', { method: 'GET' }),
    bind: async (mode: BindMode, url?: string, recordingMode?: RecordingMode) => {
      // 不硬编码 contextId:'default'(真扩展常注册在生成的 profile id,如 'xhz62x7b';写死 'default'
      // → daemon profile_disconnected,真扩展实测踩过)。不传 → be 留空 → daemon 单连接回退路由到
      // 唯一连着的扩展。多 profile 选择是后续 UI 工作(届时显式传 contextId)。
      // url:await_login 模式带目标 URL → be 立刻开 byCLI tab 跳该 URL 供用户登录。
      // recordingMode:缺省不传(be 默认 tab_projection 投屏);embedded_iframe 才显式传。
      const res = await call<BindResult>('/recorder/session/bind', {
        body: { mode: BIND_MODE_MAP[mode], ...(url ? { url } : {}), ...(recordingMode ? { recordingMode } : {}) },
      });
      // 捕获 sessionId 供后续 side-effect 自动注入(bind 是会话起点)
      if (res.ok && res.data?.sessionId) sessionId = res.data.sessionId;
      return res;
    },
    confirmAuth: () => call<SessionAdvanceResult>('/recorder/session/confirm-auth', { body: {} }),
    navigate: (url: string) => call<{ url: string }>('/recorder/navigate', { body: { url } }),
    // 契约 CaptureStartRequest required: [sessionId, sampleName, trigger]。UI 即手动触发 → user_manual。
    captureStart: (sample) =>
      call<SessionAdvanceResult & { sampleName: 'A' | 'B'; started: boolean }>('/recorder/capture/start', {
        body: { sampleName: sample, trigger: 'user_manual' },
      }),
    captureRead: async (sample, seed) => {
      const res = await call<{ sampleName?: 'A' | 'B'; entries?: unknown[]; actions?: unknown[]; actionsDropped?: number }>('/recorder/capture/read', { body: { sampleName: sample, ...(seed ? { seed } : {}) } });
      if (!res.ok || res.data === null) return res as unknown as RequestEnvelope<CaptureSample>;
      const raw = Array.isArray(res.data.entries) ? (res.data.entries as Record<string, unknown>[]) : [];
      const actions = Array.isArray(res.data.actions) ? (res.data.actions as CaptureSample['actions']) : undefined;
      return {
        ...res,
        data: {
          sampleName: sample,
          entries: raw.map(mapRawEntry),
          ...(actions && actions.length ? { actions } : {}),
          ...(typeof res.data.actionsDropped === 'number' ? { actionsDropped: res.data.actionsDropped } : {}),
        },
      };
    },
    screenshot: (quality?: number) =>
      call<{ format: string; data: string }>('/recorder/screenshot', { body: quality !== undefined ? { quality } : {} }),
    sendInput: (cdpMethod: string, cdpParams: Record<string, unknown>) =>
      call<{ dispatched: boolean }>('/recorder/input', { body: { cdpMethod, cdpParams } }),
    rank: async () => {      // be 返回 {sessionId,state,stateVersion,candidates};前端只要候选数组(transport 拆包,非隐藏业务模型)。
      const res = await call<{ candidates?: RankCandidate[] }>('/recorder/rank', { body: {} });
      if (!res.ok || res.data === null) return res as unknown as RequestEnvelope<RankCandidate[]>;
      const candidates = Array.isArray(res.data.candidates) ? res.data.candidates : [];
      return { ...res, data: candidates };
    },
    // be /recorder/init 是同步 200,直接回 InitResult{report,dryRun}(不建 request、非 202 轮询)。
    init: (name: string, selectedCandidateId: string, writePolicy: WritePolicy, responsibleUseAcknowledgedAt?: number, llmEgressAcknowledgedAt?: number) => {
      const body: Record<string, unknown> = { name, selectedCandidateId, writePolicy };
      if (responsibleUseAcknowledgedAt !== undefined) body.responsibleUseAcknowledgedAt = responsibleUseAcknowledgedAt;
      if (llmEgressAcknowledgedAt !== undefined) body.llmEgressAcknowledgedAt = llmEgressAcknowledgedAt;
      return call<InitResult>('/recorder/init', { body });
    },
    // verify 是 202 异步:内部轮询 GET /recorder/requests/{id} 至 terminal 得 VerifySummary。
    verify: (name: string) => callAsync<VerifySummary>('/recorder/verify', { name }),
    // N5:pipeline 改 202 异步(score~90s+generate+verify 耗时长);callAsync 轮询到终态,onProgress 实时回阶段耗时。
    pipeline: (llmEgressAcknowledgedAt: number, candidateIds?: string[], onProgress?: (phases: ProgressPhase[]) => void) =>
      callAsync<PipelineResult>('/recorder/pipeline', { llmEgressAcknowledgedAt, ...(candidateIds?.length ? { candidateIds } : {}) }, onProgress),
    pipelinePreview: () => call<{ prompts: PipelinePrompts; sentCandidateIds: string[] }>('/recorder/pipeline/preview', { body: {} }),
    saveAdapter: (draftId: string, source?: string) => {
      const body: Record<string, unknown> = { draftId };
      if (source !== undefined) body.source = source;
      return call<SaveResult>('/recorder/save', { body });
    },
    saveAdapters: (drafts: Array<{ draftId: string; source?: string }>) =>
      call<SaveResult>('/recorder/save', { body: { drafts } }),
    cancel: async () => {
      const res = await call<{ cancelled: boolean }>('/recorder/cancel', { body: { scope: 'session' }, idempotent: false });
      sessionId = null; // 会话结束,清空持有的 sessionId
      return res;
    },
  };
}
