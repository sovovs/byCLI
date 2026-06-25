// Recorder Local Service 客户端接缝(03 契约 + 04 安全模型 + 05 状态机)。
// UI 只依赖 RecorderClient 接口,不关心 transport;mock 与真实 localhost HTTP 都实现它。
// init/verify 在契约上是 202 异步 + GET /recorder/requests/{id} 轮询,但接口层把轮询
// 封装在 HTTP 实现内部,统一返回最终 RequestEnvelope<T>,使 useRecorderSession 与 transport 解耦。
import type {
  CaptureSample,
  HealthReport,
  InitResult,
  RankCandidate,
  RequestEnvelope,
  SessionState,
  VerifySummary,
} from '@/types/recorder';

/** init 写入策略(契约 InitRequest.writePolicy 字面量,连字符) */
export type WritePolicy = 'dry-run' | 'write';

/** bind 模式(05 章 Authentication Session Binding;映射到契约 mode 枚举) */
export type BindMode = 'existing' | 'await_login';

/** bind 返回:awaitingLogin=true 表示进入 awaiting_user_login 分支 */
export interface BindResult {
  sessionId: string;
  contextId: string;
  targetId: string;
  awaitingLogin: boolean;
}

/** be 回的会话推进结果(side-effect 后的状态机快照)。对齐 be handleConfirmAuth/handleCaptureStart
 * 实际响应 {sessionId,state,stateVersion,...}(此前前端类型写的 {authConfirmed}/{capturing} 与 be 漂移)。 */
export interface SessionAdvanceResult {
  sessionId: string;
  state: SessionState;
  stateVersion: number;
}

/**
 * Recorder Local Service 的 UI 侧契约。所有 side-effect 方法对应 03 章 POST endpoint,
 * 返回统一响应包 RequestEnvelope<T>。错误以 envelope.error 回传(不抛),保持与 run() 兼容。
 */
export interface RecorderClient {
  health(): Promise<RequestEnvelope<HealthReport>>;
  bind(mode: BindMode): Promise<RequestEnvelope<BindResult>>;
  confirmAuth(): Promise<RequestEnvelope<SessionAdvanceResult>>;
  navigate(url: string): Promise<RequestEnvelope<{ url: string }>>;
  captureStart(sample: 'A' | 'B'): Promise<RequestEnvelope<SessionAdvanceResult & { sampleName: 'A' | 'B'; started: boolean }>>;
  captureRead(sample: 'A' | 'B'): Promise<RequestEnvelope<CaptureSample>>;
  rank(): Promise<RequestEnvelope<RankCandidate[]>>;
  /**
   * select-only init(契约 InitRequest required: name + writePolicy + selectedCandidateId)。
   * be 端从选定候选服务端派生 domain/strategy/endpoint。dry-run 仅预览(不推进会话);
   * write 提交草稿并推进 ranked→draft_created,write 时必带 responsibleUseAcknowledgedAt(ADR-0005)。
   * be /recorder/init 是同步 200,直接回 InitResult{report,dryRun}(非 202 轮询)。
   */
  init(
    name: string,
    selectedCandidateId: string,
    writePolicy: WritePolicy,
    responsibleUseAcknowledgedAt?: number,
  ): Promise<RequestEnvelope<InitResult>>;
  /** verify(契约 VerifyRequest required: name);202 异步,内部轮询至 terminal 得 VerifySummary。 */
  verify(name: string): Promise<RequestEnvelope<VerifySummary>>;
  cancel(): Promise<RequestEnvelope<{ cancelled: boolean }>>;
}

/**
 * transport 选择(对应 ADR-0001 / 04 章 FEATURE_LOCALHOST_HTTP_UI):
 * - 默认 mock;真实 localhost HTTP 仅当 bootstrap 显式注入开关与 token 时启用。
 * - Electron IPC transport 后续可在此追加分支。
 */
export type RecorderTransport = 'mock' | 'http';

/**
 * bootstrap 配置(04 章 Token Lifecycle):localhost HTTP 形态下,Local Service 在启动时
 * 经 one-time bootstrap(loopback handshake / IPC / 单次 URL)把 token 注入到 sessionStorage,
 * token 只存内存/sessionStorage,绝不落日志。读不到则视为未启用 HTTP transport。
 */
export interface RecorderBootstrap {
  enabled: boolean;
  baseUrl: string;
  /** 对齐 high-level wrapper 的 X-byCLI-Token(04 章 injection) */
  token: string;
  /** CSRF 双重提交 token(SameSite=Strict cookie + header,04 章 CSRF) */
  csrfToken: string;
}

const BOOTSTRAP_KEY = '__bycli_recorder_bootstrap__';

/** 从 sessionStorage 读取 bootstrap(注入点;SSR/无 window 时回落未启用) */
export function readBootstrap(): RecorderBootstrap | null {
  if (typeof window === 'undefined' || !window.sessionStorage) return null;
  try {
    const raw = window.sessionStorage.getItem(BOOTSTRAP_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as Partial<RecorderBootstrap>;
    if (!b.enabled || !b.baseUrl || !b.token) return null;
    return { enabled: true, baseUrl: b.baseUrl, token: b.token, csrfToken: b.csrfToken ?? '' };
  } catch {
    return null;
  }
}

let cached: RecorderClient | null = null;

/**
 * 解析当前应使用的 client。默认 mock;仅当 bootstrap 显式 enabled 且带 token 时切 HTTP
 * (对应 FEATURE_LOCALHOST_HTTP_UI=true 且完成 token 注入)。结果缓存,reset 用于测试/重注入。
 */
export function getRecorderClient(): RecorderClient {
  if (cached) return cached;
  const bootstrap = readBootstrap();
  if (bootstrap) {
    cached = createHttpRecorderClient(bootstrap);
  } else {
    cached = mockRecorder;
  }
  return cached;
}

export function resetRecorderClient(): void {
  cached = null;
}

// 延迟 import 避免循环依赖(mock 与 http 实现各自 import 本文件的类型)。
import { mockRecorder } from './mockRecorder';
import { createHttpRecorderClient } from './httpRecorderClient';

