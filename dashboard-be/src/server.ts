// Recorder Local Service —— localhost HTTP server(M2 shell)。
// 仅监听 127.0.0.1;side-effect 经 04 章门禁;navigate/capture/rank/init/verify 占位 feature_disabled。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { loadConfig, ConfigInvalidError, type RecorderConfig } from './config.js';
import { BootstrapVault } from './security/bootstrap.js';
import { checkGates } from './security/gates.js';
import { createDaemonBridge, type DaemonBridge } from './transport/daemonBridge.js';
import { createVncOrchestrator, type VncOrchestrator } from './transport/vncOrchestrator.js';
import { createStaticServer, resolveFrameSrc, type StaticServer } from './static.js';
import { createLogger, type Logger, type LogLevel } from './logger.js';
import { createMetrics, type Metrics } from './metrics.js';
import { createConfigPort, type ConfigPort } from './config-port.js';
import { Registry } from './session/registry.js';
import { type SessionState, canTransition, isLeaseLossCode } from './session/stateMachine.js';
import { rankSamples, analyzeSite, resolveSeedParams, deriveEvidenceSeedArgs, DEFAULT_SCORING_PROFILE, type CaptureSample, type PageSignals, type AdapterRef, type RankCandidate, type RecordingMode } from '@sovovs/bycli-recorder-core';
import { createSynthesizer, type Synthesizer } from './llm/synthesize.js';
import { createScorer, buildScorePrompt, selectCandidatesForLlm, type Scorer } from './llm/score.js';
import { makeStructureAwareResponsePreview } from './llm/responseSummary.js';
import { createGenerator, buildGenPrompt, type Generator } from './llm/generate.js';
import { runPipeline, runScore, runGenerate, type PipelineDraft } from './llm/pipeline.js';
import { cleanupDraftDir } from './llm/draft-store.js';
import { meetsExpectation, type VerifySummaryLike, type VerifyOutcome } from './llm/verify-expectation.js';
import {
  ok,
  fail,
  httpStatusFor,
  newRequestId,
  type ApiResponse,
  type ErrorCode,
} from './transport/envelope.js';

interface Ctx {
  cfg: RecorderConfig;
  vault: BootstrapVault;
  daemon: DaemonBridge;
  registry: Registry;
  staticServer: StaticServer | null;
  logger: Logger;
  metrics: Metrics;
  /** Hot-reloadable config snapshot (M8d). `cfg` stays the pinned startup config (gates/ports/
   * registry); read `config.current()` for hot fields (scoringProfile / featureFlags / poll). */
  config: ConfigPort;
  /** LLM 合成器(MVP):dry-run 时把 A/B 痕迹+截图喂模型生成 adapter func/columns。
   *  flag off / 无 key → synthesize 永远返回 null(退回空模板)。测试可整体替换。 */
  synthesizer: Synthesizer;
  /** N4 verify-then-save 流水线:LLM 评分器 + 多脚本生成器(无 key → 返回 null)。测试可替换。 */
  scorer: Scorer;
  generator: Generator;
  /** VNC 录制模式:容器编排(podman run/rm + readiness)。无 podman/镜像时 start 抛错 → bind 报 daemon_unavailable。 */
  vnc: VncOrchestrator;
  /** vnc 会话的 per-gatewayPort daemon bridge 缓存(指向容器网关,反代到容器内 daemon)。 */
  vncBridges: Map<number, DaemonBridge>;
}

/** 取该 session 应使用的 daemon bridge:vnc 模式 → 指向容器网关的 bridge(按 gatewayPort 缓存);否则本机 daemon。
 *  采集类命令(bind/capture/screenshot/input/ui-capture)用它;合成类(/v1/* rank/init/verify)始终走本机 ctx.daemon。 */
function daemonFor(ctx: Ctx, session: { recordingMode: RecordingMode; gatewayPort?: number }): DaemonBridge {
  if (session.recordingMode !== 'vnc' || !session.gatewayPort) return ctx.daemon;
  let b = ctx.vncBridges.get(session.gatewayPort);
  if (!b) { b = createDaemonBridge({ host: '127.0.0.1', port: session.gatewayPort }); ctx.vncBridges.set(session.gatewayPort, b); }
  return b;
}

// LLM scorer/generator onError 收到的既可能是 Error(超时/网络/解析),也可能是**结构化观测对象**
// (如 score.ts 的 { kind:'score_prompt_degraded', chars, candidates, degraded })。旧写法
// `String(err?.message || err)` 对无 message 的对象落到 String(obj) = "[object Object]",
// 日志里根本看不出发生了什么。这里统一序列化成可读字符串:
//   - Error → message(+ cause 若有)
//   - 结构化对象 → JSON.stringify(丢失 message 也能看到 kind/字段)
//   - 其它 → String()
function stringifyLlmError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause != null ? `${err.message} (cause: ${stringifyLlmError(cause)})` : err.message;
  }
  if (err && typeof err === 'object') {
    // 有 message 字段的类 Error 对象优先取 message;否则整体 JSON 化(含 kind 等诊断字段)。
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

const json = (res: ServerResponse, status: number, body: ApiResponse | object): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // 04 章:不回 Access-Control-Allow-Headers(no-CORS);明确不放行跨源
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
};

const sendFail = (res: ServerResponse, code: ErrorCode, message: string, requestId?: string): void => {
  (res as ServerResponse & { __errorCode?: ErrorCode }).__errorCode = code; // for the finish-logger + metrics
  json(res, httpStatusFor(code), fail({ code, message }, requestId));
};

async function readJson(req: IncomingMessage, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new Error('payload too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

const payloadHash = (body: unknown): string =>
  createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex').slice(0, 32);

// All recorder endpoints are wired (M3 navigate/capture, M4 rank, M5a analyze,
// M5b init, M5c verify). verify forwards to daemon /v1/verify, which since M6 runs
// the real child-process runner (runner_protocol_error now signals an actual fault).
const GATED_ROUTES = new Set<string>([]);

// Terminal request-status values (05 Request Registry): cached + stop polling.
const TERMINAL_REQUEST_STATUS = new Set<string>(['succeeded', 'failed', 'timeout', 'cancelled']);

// ---- handlers ----

async function handleHealth(ctx: Ctx, res: ServerResponse): Promise<void> {
  // N5 兜底:LLM 是否可用(开关 + key),前端据此在 ranked 选 pipeline 流程 vs 手动回退。不泄 key。
  const llmSynthesis = ctx.cfg.LLM_SYNTHESIS_ENABLED && !!ctx.cfg.LLM_API_KEY;
  const status = await ctx.daemon.status();
  if (status === null) {
    // daemon 不可达:health 仍 200 返回降级态(不 fail,UI 据此引导启动)
    json(res, 200, ok({ localService: 'ok', daemon: 'down', extension: 'disconnected', highLevel: 'down', llmSynthesis }));
    return;
  }
  json(
    res,
    200,
    ok({
      localService: 'ok',
      daemon: 'ok',
      extension: status.extensionConnected ? 'ok' : 'disconnected',
      highLevel: 'ok',
      llmSynthesis,
    }),
  );
}

async function handleBind(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const mode = body.mode;
  // contextId 不写死 'default':client 不传时留空,daemon 用单连接回退路由到唯一连着的扩展。
  // 真扩展常注册在生成的 profile id(如 'xhz62x7b'),写死 'default' 会 profile_disconnected
  // (真扩展实测发现)。多 profile 场景由 UI 显式传 contextId。
  const contextId = typeof body.contextId === 'string' ? body.contextId : '';
  if (mode !== 'bind_existing_page' && mode !== 'create_page_await_user_login' && mode !== 'bind_existing_context') {
    return sendFail(res, 'validation_failed', 'invalid bind mode');
  }
  // 录制形态(应用层策略):缺省 tab_projection(投屏);embedded_iframe(dashboard 嵌 iframe)受
  // FEATURE_EMBEDDED_IFRAME_RECORDING gate——flag off 时请求它直接 feature_disabled(不建会话)。
  const rawRecordingMode = body.recordingMode;
  if (rawRecordingMode !== undefined && rawRecordingMode !== 'tab_projection' && rawRecordingMode !== 'embedded_iframe' && rawRecordingMode !== 'vnc') {
    return sendFail(res, 'validation_failed', 'invalid recordingMode');
  }
  const recordingMode: RecordingMode = rawRecordingMode === 'embedded_iframe' ? 'embedded_iframe'
    : rawRecordingMode === 'vnc' ? 'vnc'
    : 'tab_projection';
  if (recordingMode === 'embedded_iframe' && !ctx.cfg.featureFlags.FEATURE_EMBEDDED_IFRAME_RECORDING) {
    return sendFail(res, 'feature_disabled', 'embedded iframe recording is disabled');
  }
  if (recordingMode === 'vnc' && !ctx.cfg.featureFlags.FEATURE_VNC_RECORDING) {
    return sendFail(res, 'feature_disabled', 'vnc recording is disabled');
  }
  // 单会话模型:bind / 新建即「开新一轮录制」,先取消所有既有会话清空活跃槽,再建新会话。
  // 否则被放弃的旧会话(未走到 done/failed/cancelled)会占满 RECORDER_MAX_ACTIVE_SESSIONS,
  // 下次 bind 撞 createSession 的 queue_full(「cannot create session」)。语义=放弃上一轮录制。
  // vnc 模式:顺带回收所有旧容器(podman rm -f),避免容器泄漏。best-effort,不阻断。
  await ctx.vnc.stopAll().catch(() => {});
  ctx.registry.cancelAll();
  const url = typeof body.url === 'string' ? body.url : '';
  let session;
  try {
    session = ctx.registry.createSession({
      contextId,
      targetId: typeof body.targetId === 'string' ? body.targetId : null,
      profileId: typeof body.profileId === 'string' ? body.profileId : null,
      awaitingLogin: mode === 'create_page_await_user_login',
      recordingMode,
      // embedded_iframe 模式记目标 URL,captureRead 时作为 targetFrameUrl 让扩展过滤噪音。
      targetUrl: recordingMode === 'embedded_iframe' && url ? url : undefined,
    });
  } catch (e) {
    const code = (e as { code?: ErrorCode }).code ?? 'validation_failed';
    return sendFail(res, code, 'cannot create session');
  }
  // vnc 路径:同机起容器 → 记端口 → 返回 vncUrl。**不 bind**(与 tab_projection 一致):
  // bind 会建 borrowed lease 占用容器初始 tab,而 A/B 录制走 `tabs op:new` 需 owned lease,二者冲突
  // (扩展报 "bound to a user tab; tab new/select/close requires an owned byCLI session")。
  // 故 vnc 也走 tab_projection 路径:bind 不碰 daemon,真正录制 tab 由「开始 A/B 录制」的 navigate 新开(owned)。
  let vncUrl: string | undefined;
  if (recordingMode === 'vnc') {
    try {
      const c = await ctx.vnc.start(session.sessionId);
      ctx.registry.setVncPorts(session.sessionId, c.vncPort, c.gatewayPort);
      // 前端 iframe 直连容器宿主映射的 noVNC 端口(同机回环);autoconnect+scale 由前端拼。
      vncUrl = `http://127.0.0.1:${c.vncPort}/vnc.html`;
    } catch (e) {
      ctx.registry.markFailed(session.sessionId);
      ctx.logger.warn('recorder.vnc.start_failed', { sessionId: session.sessionId, status: 'error', stage: String((e as Error).message || e) });
      return sendFail(res, 'daemon_unavailable', 'failed to start vnc container (check podman + bycli-verify image)');
    }
  }
  // 等待登录路径:立刻 `tabs op:new` 开一个**独立 byCLI tab** 并导航到目标 URL,供用户在该 tab 登录
  // (page lease = 新 tab 的 targetId)。登录后 confirmAuth 直接进 page_ready 复用此 tab(见 handleConfirmAuth),
  // 不重新导航、不刷掉登录后的页面。daemon/扩展不可用时静默跳过(会话仍 awaiting_user_login,可重试)。
  if (mode === 'create_page_await_user_login' && url) {
    const r = await ctx.daemon.command({ action: 'tabs', op: 'new', url, session: session.sessionId, surface: 'browser', contextId: session.contextId });
    if (r.ok) {
      const data = (r.data ?? {}) as { page?: string };
      const page = r.page ?? (typeof data.page === 'string' ? data.page : undefined);
      if (typeof page === 'string') ctx.registry.setPage(session.sessionId, page);
    }
  }
  // embedded_iframe 路径:绑 dashboard 自己的当前聚焦 tab(bind_existing_page)拿其 targetId 作 bound page lease。
  // 不开新 tab、不导航(iframe src 由前端设)。绑成功即拿到 lease,后续 captureStart 直接对该 tab 开 capture。
  // daemon/扩展不可用时静默跳过(会话仍 session_bound,前端可重试);绑不到 → 后续 capture 报 page_lost。
  if (recordingMode === 'embedded_iframe') {
    const r = await ctx.daemon.command({ action: 'bind', session: session.sessionId, surface: 'browser', contextId: session.contextId });
    if (r.ok) {
      const data = (r.data ?? {}) as { page?: string };
      const page = r.page ?? (typeof data.page === 'string' ? data.page : undefined);
      if (typeof page === 'string') ctx.registry.setPage(session.sessionId, page);
    }
  }
  json(res, 200, ok({
    sessionId: session.sessionId,
    contextId: session.contextId,
    targetId: session.targetId,
    awaitingLogin: session.state === 'awaiting_user_login',
    stateVersion: session.stateVersion,
    ...(vncUrl ? { vncUrl } : {}),
  }));
}

function handleConfirmAuth(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): void {
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string') return sendFail(res, 'validation_failed', 'sessionId required');
  const s = ctx.registry.getSession(sessionId);
  if (!s) return sendFail(res, 'request_not_found', 'session not found');
  // 登录确认后直接进 page_ready:bind(await_login) 已开 tab 并存 targetId(见 handleBind),用户在该 tab
  // 登录后,此处复用同一 tab 进入采集态,不再 navigate(避免刷掉登录后的页面)。confirmAuth 仅允许从
  // awaiting_user_login 触发(stateMachine),故等价 awaiting_user_login → page_ready。
  const r = ctx.registry.advance(sessionId, 'confirmAuth', 'page_ready', s.stateVersion);
  if (!r.ok) return sendFail(res, r.reason === 'invalid_state' ? 'invalid_state' : 'queue_full', `cannot confirm auth from ${s.state}`);
  json(res, 200, ok({ sessionId, state: r.session.state, stateVersion: r.session.stateVersion }));
}

async function handleRequestStatus(ctx: Ctx, requestId: string, res: ServerResponse): Promise<void> {
  const rec = ctx.registry.getRequestRecord(requestId);
  if (!rec) return sendFail(res, 'request_not_found', 'request unknown or expired');
  // Terminal (cached) or non-verify (analyze runs in be → result already recorded): return as-is.
  if (TERMINAL_REQUEST_STATUS.has(rec.status) || rec.type !== 'verify') {
    return json(res, 200, ok(ctx.registry.getRequest(requestId)));
  }
  // verify in-flight → proxy the daemon for the runner status (keyed on the canonical id).
  const r = await ctx.daemon.highLevelGet(`/v1/requests/${encodeURIComponent(rec.daemonRequestId)}`);
  if (!r.ok) {
    const code: ErrorCode = r.errorCode === 'request_not_found' ? 'request_not_found' : 'daemon_unavailable';
    return sendFail(res, code, r.error, requestId);
  }
  const d = (r.data ?? {}) as { status?: string; result?: unknown };
  if (d.status && TERMINAL_REQUEST_STATUS.has(d.status)) {
    const isOk = d.status === 'succeeded';
    ctx.registry.finalizeRequest(requestId, isOk
      ? { status: 'succeeded', result: d.result }
      : { status: d.status as 'failed' | 'timeout' | 'cancelled', error: d.result ?? null });
    ctx.registry.settleVerify(rec.sessionId, isOk);
  }
  json(res, 200, ok(ctx.registry.getRequest(requestId)));
}

function handleCancel(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): void {
  const scope = body.scope;
  if (scope !== 'request' && scope !== 'session' && scope !== 'capture') {
    return sendFail(res, 'validation_failed', 'invalid cancel scope');
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
  if ((scope === 'session' || scope === 'capture') && !sessionId) {
    return sendFail(res, 'validation_failed', 'sessionId required for session/capture cancel');
  }
  if (sessionId) {
    // 拆步流程:save 不再即时清理草稿目录(用户可逐个保存),改由会话取消/终止时清理,防 0700 临时目录泄漏。
    if (scope === 'session') {
      const drafts = ctx.registry.getDrafts(sessionId);
      if (drafts?.dir) cleanupDraftDir(drafts.dir);
    }
    ctx.registry.cancelSession(sessionId);
    // vnc 会话:回收容器(best-effort,fire-and-forget,不阻塞同步返回)。
    if (ctx.vnc.get(sessionId)) void ctx.vnc.stop(sessionId).catch(() => {});
  }
  // 幂等:无论是否存在都回成功(05 章 cancel idempotent)
  json(res, 200, ok({ cancelled: true }));
}

// ── #5b admin log-level toggle(09 Log Level Control)────────────────────────────
// loopback-only 运行时调级。仅在 restart-only flag FEATURE_ADMIN_LOG_LEVEL_TOGGLE 开启时由 route
// 注册(flag off → 端点真的不存在,落 request_not_found,忠实 09:168「off flag 不暴露新面」)。走全套
// side-effect 门禁(Origin/header/token/CSRF,同其他 POST /recorder/*);与 SIGUSR2/SIGHUP 调级语义一致,
// 永不放宽 redaction(LogFields 类型保证)。
const ADMIN_LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];
function handleAdminLogLevel(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): void {
  const level = body.level;
  if (typeof level !== 'string' || !(ADMIN_LOG_LEVELS as readonly string[]).includes(level)) {
    return sendFail(res, 'validation_failed', `level must be one of ${ADMIN_LOG_LEVELS.join('|')}`);
  }
  ctx.logger.setLevel(level as LogLevel);
  ctx.logger.info('recorder.log_level_changed', { status: level });
  json(res, 200, ok({ level }));
}

// ── M3:navigate / capture 经 daemon /command(page lease + stale fail-fast)──────
// daemon 错误码 → be ErrorCode。lease-loss 类(isLeaseLossCode)使会话 fail-fast(不重试)。
const KNOWN_ERROR_CODES = new Set<string>([
  'page_lost', 'daemon_unavailable', 'daemon_timeout', 'extension_disconnected',
  'navigation_url_forbidden', 'navigation_redirect_requires_interception',
  'navigation_blocked_by_policy', 'dns_resolution_failed', 'profile_busy',
  'ambiguous_iframe_target',
]);
// 真 daemon/扩展产出的「浏览器绑定/页面没了」码(真栈实测) → 给前端归一成 page_lost(连贯的 lease-loss
// 信号);这些不是 be ErrorCode 枚举,直接透传会被当 network_error。与 stateMachine.isLeaseLossCode 配套。
const DAEMON_LEASE_LOSS_CODES = new Set<string>([
  'command_result_unknown', 'extension_not_connected', 'profile_disconnected', 'bound_tab_not_found',
]);
function mapDaemonError(code: string): ErrorCode {
  if (code === 'daemon_timeout') return 'daemon_unavailable';
  if (code === 'navigation_blocked_by_policy') return 'navigation_url_forbidden';
  if (DAEMON_LEASE_LOSS_CODES.has(code)) return 'page_lost';
  return (KNOWN_ERROR_CODES.has(code) ? code : 'network_error') as ErrorCode;
}

async function handleNavigate(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const sessionId = body.sessionId;
  const url = body.url;
  if (typeof sessionId !== 'string') return sendFail(res, 'validation_failed', 'sessionId required');
  if (typeof url !== 'string' || !url) return sendFail(res, 'validation_failed', 'url required');
  const s = ctx.registry.getSession(sessionId);
  if (!s) return sendFail(res, 'request_not_found', 'session not found');
  // iframe 模式:页面由前端 <iframe src> 加载,扩展只 attach 已绑定的 dashboard tab,绝不开新 tab/导航。
  // navigate 在此模式是**状态推进 no-op**:把状态推到 page_ready(让 captureStart 可开窗),但不发任何
  // daemon tab/navigate 命令(bound dashboard tab 不允许 owned-tab 行为)。page lease 已在 bind 时建立。
  // 这样前端「navigate→captureStart」流程对两模式完全一致(差异全吸收进 be handler,Codex 裁定:模式=应用层策略)。
  if (s.recordingMode === 'embedded_iframe') {
    if (!s.targetId) return sendFail(res, 'page_lost', 'no bound dashboard tab; rebind first');
    const adv = ctx.registry.advance(sessionId, 'navigate', 'page_ready', s.stateVersion);
    if (!adv.ok) {
      return sendFail(res, adv.reason === 'invalid_state' ? 'invalid_state' : 'queue_full', `cannot navigate from ${s.state}`);
    }
    return json(res, 200, ok({ sessionId, state: 'page_ready', stateVersion: adv.session.stateVersion, page: s.targetId, url }));
  }
  // 状态门禁(CAS):navigate 允许 session_bound/auth_confirmed/page_ready/capture_a。
  // 开新 tab 的判定要在 advance 改写 state 之前读取(advance 原地把 s.state 改成 page_ready)。
  // vnc 模式与 tab_projection 同路径(A/B 各开独立 tab):命令经 daemonFor 路由到容器网关而非本机 daemon。
  const fromState = s.state;
  const adv = ctx.registry.advance(sessionId, 'navigate', 'page_ready', s.stateVersion);
  if (!adv.ok) {
    return sendFail(res, adv.reason === 'invalid_state' ? 'invalid_state' : 'queue_full', `cannot navigate from ${s.state}`);
  }
  // 经 daemon → 扩展 chrome.tabs.update(已被扩展侧 handleNavigate 的 Fetch guard 保护)
  // 浏览器命令必须带 session(扩展按 surface:session 做 tab lease key;缺 session → session_required)。
  // 用 recorder sessionId 作 session 名:同一 recorder 会话所有命令复用同一 lease/标签页。surface 显式
  // 'browser'(扩展默认也是 browser)。详见记忆 be-missing-session-breaks-real-extension。
  // 「开始录制」入口(首次=A 从 session_bound 无 lease;B 从 capture_a)→ `tabs op:new` 开一个**全新标签页**
  // (A=页面 a、B=页面 b)并导航,扩展回新 tab 的 targetId 作 page lease;其它(page_ready 原地重试)→ 在
  // 既有 tab 内 `navigate`。B 录制每次开新页面,符合用户选择的「每次新开全新页面」。
  const openNewTab = !s.targetId || fromState === 'capture_a';
  // 投屏一体化:录制 tab 后台开(windowMode:'background'),不抢焦点——用户留在 dashboard 看投屏。
  // vnc 模式相反:新 tab 要前台开(foreground),这样在 noVNC 整屏画面里能看到打开的录制页。
  const windowMode = s.recordingMode === 'vnc' ? 'foreground' : 'background';
  const daemon = daemonFor(ctx, s);
  const r = openNewTab
    ? await daemon.command({ action: 'tabs', op: 'new', url, session: sessionId, surface: 'browser', contextId: s.contextId, windowMode })
    : await daemon.command({ action: 'navigate', session: sessionId, surface: 'browser', url, contextId: s.contextId, page: s.targetId, windowMode });
  if (!r.ok) {
    if (isLeaseLossCode(r.errorCode) || r.errorCode === 'daemon_timeout') ctx.registry.markFailed(sessionId);
    return sendFail(res, mapDaemonError(r.errorCode), r.error);
  }
  // page ownership:真扩展把 page(targetId)放在命令结果**顶层**(r.page,data 的兄弟),不在 data 里
  // (真扩展实测发现;daemonBridge.command 现已透传顶层 page)。顶层优先,兼容旧桩的 data.page。
  // 拿不到 page → 建不起 lease → 后续 capture 全 page_lost。
  const data = (r.data ?? {}) as { page?: string; url?: string; title?: string };
  const page = r.page ?? (typeof data.page === 'string' ? data.page : undefined);
  if (typeof page === 'string') ctx.registry.setPage(sessionId, page);
  json(res, 200, ok({ sessionId, state: 'page_ready', stateVersion: adv.session.stateVersion, page: page ?? s.targetId, url: data.url, title: data.title }));
}

async function handleCaptureStart(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string') return sendFail(res, 'validation_failed', 'sessionId required');
  if (typeof body.sampleName !== 'string' || !body.sampleName) return sendFail(res, 'validation_failed', 'sampleName required');
  if (typeof body.trigger !== 'string') return sendFail(res, 'validation_failed', 'trigger required');
  const s = ctx.registry.getSession(sessionId);
  if (!s) return sendFail(res, 'request_not_found', 'session not found');
  if (!s.targetId) return sendFail(res, 'page_lost', 'no page lease; navigate first');
  // captureStart 只「开窗」**不推进状态**:停在 page_ready,让用户在打开的页面操作,直到 captureRead 冻结。
  // (旧实现 start 立即推进 capture_a/b,arm 完前端立刻 read 抓 0 条 + B 重导航后 A/B 误判,见状态机注释。)
  if (!canTransition(s.state, 'captureStart')) {
    return sendFail(res, 'invalid_state', `cannot start capture from ${s.state}`);
  }
  const pattern = typeof body.pattern === 'string' ? body.pattern : '';
  const daemon = daemonFor(ctx, s);
  const r = await daemon.command({ action: 'network-capture-start', session: sessionId, surface: 'browser', contextId: s.contextId, page: s.targetId, pattern });
  if (!r.ok) {
    if (isLeaseLossCode(r.errorCode) || r.errorCode === 'daemon_timeout') ctx.registry.markFailed(sessionId);
    return sendFail(res, mapDaemonError(r.errorCode), r.error);
  }
  // M-UI-2:同窗口一并开「用户操作录制」(注入只读 DOM 监听)。best-effort——UI 录制是增强,
  // 失败/旧扩展不支持都不阻断网络录制(captureRead 时读不到 actions 即空)。
  await daemon.command({ action: 'ui-capture-start', session: sessionId, surface: 'browser', contextId: s.contextId, page: s.targetId });
  json(res, 200, ok({ sessionId, state: s.state, stateVersion: s.stateVersion, sampleName: body.sampleName, started: true }));
}

// 一体化录制(Phase 1):投屏预览。经 daemon→扩展 Page.captureScreenshot 拿单帧 base64 jpeg。
// 只读、不推进状态、不动 capture buffer;前端轮询刷新。需已有 page lease(navigate 后)。
async function handleScreenshot(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string') return sendFail(res, 'validation_failed', 'sessionId required');
  const s = ctx.registry.getSession(sessionId);
  if (!s) return sendFail(res, 'request_not_found', 'session not found');
  if (!s.targetId) return sendFail(res, 'page_lost', 'no page lease; navigate first');
  const quality = typeof body.quality === 'number' ? body.quality : 60;
  const r = await daemonFor(ctx, s).command({
    action: 'screenshot', session: sessionId, surface: 'browser', contextId: s.contextId, page: s.targetId,
    format: 'jpeg', quality,
  });
  if (!r.ok) {
    if (isLeaseLossCode(r.errorCode) || r.errorCode === 'daemon_timeout') ctx.registry.markFailed(sessionId);
    return sendFail(res, mapDaemonError(r.errorCode), r.error);
  }
  // 扩展 screenshot 把 base64 放在结果 data(字符串)。
  const dataUrl = typeof r.data === 'string' ? r.data : '';
  json(res, 200, ok({ sessionId, format: 'jpeg', data: dataUrl }));
}

// 一体化录制(Phase 2):Input 回传。把 canvas 上的鼠标/键盘事件转成 CDP Input.* 发到真 tab。
// 经 cdp passthrough(Input.* 已在扩展 CDP_ALLOWLIST)。参数白名单:只允许这三类 CDP 方法。
const INPUT_CDP_METHODS = new Set(['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.synthesizeScrollGesture']);
async function handleInput(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const sessionId = body.sessionId;
  const cdpMethod = body.cdpMethod;
  if (typeof sessionId !== 'string') return sendFail(res, 'validation_failed', 'sessionId required');
  if (typeof cdpMethod !== 'string' || !INPUT_CDP_METHODS.has(cdpMethod)) {
    return sendFail(res, 'validation_failed', 'cdpMethod must be one of Input.dispatchMouseEvent/dispatchKeyEvent/insertText');
  }
  const cdpParams = (body.cdpParams && typeof body.cdpParams === 'object') ? body.cdpParams as Record<string, unknown> : {};
  const s = ctx.registry.getSession(sessionId);
  if (!s) return sendFail(res, 'request_not_found', 'session not found');
  if (!s.targetId) return sendFail(res, 'page_lost', 'no page lease; navigate first');
  const r = await daemonFor(ctx, s).command({
    action: 'cdp', session: sessionId, surface: 'browser', contextId: s.contextId, page: s.targetId,
    cdpMethod, cdpParams,
  });
  if (!r.ok) {
    if (isLeaseLossCode(r.errorCode) || r.errorCode === 'daemon_timeout') ctx.registry.markFailed(sessionId);
    return sendFail(res, mapDaemonError(r.errorCode), r.error);
  }
  json(res, 200, ok({ sessionId, dispatched: true }));
}

async function handleCaptureRead(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string') return sendFail(res, 'validation_failed', 'sessionId required');
  if (typeof body.sampleName !== 'string' || !body.sampleName) return sendFail(res, 'validation_failed', 'sampleName required');
  const s = ctx.registry.getSession(sessionId);
  if (!s) return sendFail(res, 'request_not_found', 'session not found');
  if (!s.targetId) return sendFail(res, 'page_lost', 'no page lease; navigate first');
  // captureRead 读窗冻结**才推进状态**(「结束录制」):按 sampleName 推进 page_ready→capture_a / capture_b。
  // CAS 守 stateVersion;与 navigate 同序——先 advance 占位转移,daemon 读失败(租约丢失)再 markFailed。
  const nextState: SessionState = body.sampleName === 'B' ? 'capture_b' : 'capture_a';
  const adv = ctx.registry.advance(sessionId, 'captureRead', nextState, s.stateVersion);
  if (!adv.ok) {
    return sendFail(res, adv.reason === 'invalid_state' ? 'invalid_state' : 'queue_full', `cannot read capture from ${s.state}`);
  }
  // embedded_iframe:下发目标 iframe URL,扩展据此把网络/UI 噪音过滤到该 iframe(+descendants)子 session,丢顶层 dashboard。
  const targetFrameUrl = s.recordingMode === 'embedded_iframe' ? s.targetUrl : undefined;
  const daemon = daemonFor(ctx, s);
  const r = await daemon.command({ action: 'network-capture-read', session: sessionId, surface: 'browser', contextId: s.contextId, page: s.targetId, ...(targetFrameUrl ? { targetFrameUrl } : {}) });
  if (!r.ok) {
    if (isLeaseLossCode(r.errorCode) || r.errorCode === 'daemon_timeout') ctx.registry.markFailed(sessionId);
    return sendFail(res, mapDaemonError(r.errorCode), r.error);
  }
  // Freeze this sample's entries into the session so rank can read A/B later (05:51).
  const entries = Array.isArray(r.data) ? r.data : [];
  // fix C(结构感知预览):采集侧把 responseBody 按字符切断会存成半截非法 JSON。这里在 storeSample 前
  // 把每条 entry 的 responsePreview 归一成**合法结构化 JSON 样本**(少量数组元素 + 完整嵌套结构 + 短字符串),
  // 让下游 buildResponseSummary 可靠 parse、拿到全字段路径。base64 体(base64: 前缀)是二进制,跳过不动。
  for (const e of entries as Array<Record<string, unknown>>) {
    if (typeof e.responsePreview !== 'string' || e.responsePreview.startsWith('base64:')) continue;
    const norm = makeStructureAwareResponsePreview({
      body: e.responsePreview,
      contentType: typeof e.responseContentType === 'string' ? e.responseContentType : undefined,
    });
    e.responsePreview = norm.responsePreview;
    // full → 不覆盖既有 truncated(采集侧可能已因 8MB 上限置 true);裁剪过则强制 true(诚实标注)。
    if (norm.previewMode !== 'full') e.responseBodyTruncated = true;
  }
  // 诊断:按 resourceType 打直方图 + WS 帧数(只记类型名/计数,绝不记 URL/数据 —— 09 脱敏)。
  // 正常只应见 XHR/Fetch/WebSocket;若出现 Stylesheet/Script/Document 即过滤失效(旧扩展/真 bug)。
  {
    const hist = new Map<string, number>();
    let wsFrames = 0;
    for (const e of entries as Array<Record<string, unknown>>) {
      const t = typeof e.resourceType === 'string' ? e.resourceType
        : e.kind === 'cdp-websocket' ? 'WebSocket' : 'unknown';
      hist.set(t, (hist.get(t) ?? 0) + 1);
      if (Array.isArray(e.webSocketFrames)) wsFrames += e.webSocketFrames.length;
    }
    const histStr = [...hist.entries()].map(([t, n]) => `${t}=${n}`).join(' ');
    ctx.logger.info('recorder.capture.entries', {
      sessionId, status: 'ok',
      stage: `${String(body.sampleName)} total=${entries.length} ${histStr} wsFrames=${wsFrames}`,
    });
  }
  // M-UI-2:读回本窗口录到的用户操作事件(best-effort,旧扩展/失败 → 空)。
  const { actions, dropped } = await readUiActions(ctx, daemon, s.contextId, s.targetId, sessionId, targetFrameUrl);
  // 结束录制时顺带抓一张页面截图,作为该样本的视觉证据(供 LLM 合成)。best-effort:截图是增强
  // 不是硬依赖,失败/不支持都不阻断录制;只驻内存挂在 session 上、不落盘。
  const screenshot = await captureScreenshot(ctx, daemon, s.contextId, s.targetId, sessionId);
  // dashboard seed 输入(评分识别 seed→param):用户声明本次搜索关键词。用 raw seed 扫已抓 entries 的
  // query 值反推参数名(value→param,纯函数在 core),再 deriveEvidenceSeedArgs 转成 HMAC 证据。
  // **raw seed 只在此处内存里用一瞬、用完即弃,绝不落盘/不进 storeSample/不出日志**(M7c,Codex 2026-06-29 裁定方案 A)。
  let seedEvidence: Record<string, unknown> | undefined;
  const rawSeed = typeof body.seed === 'string' ? body.seed.trim() : '';
  if (rawSeed) {
    const paramNames = resolveSeedParams(entries as never, rawSeed);
    if (paramNames.length) {
      // 每个命中参数名都映射同一 seed 值;deriveEvidenceSeedArgs 内部 HMAC、只留 placeholder/type/length。
      const rawMap: Record<string, unknown> = {};
      for (const name of paramNames) rawMap[name] = rawSeed;
      // 会话级 HMAC key:vault token(secret)+ sessionId,稳定且不可预测;evidence comparableAcrossRuns:false。
      const hmacKey = createHash('sha256').update(`${ctx.vault.token}:${sessionId}`).digest('hex');
      seedEvidence = deriveEvidenceSeedArgs(rawMap, hmacKey) as unknown as Record<string, unknown>;
    } else {
      // 关键词没出现在任何 query 值(SSR/POST body/SPA 页面 URL)→ 不构造证据,回退现状评分。只记计数,不记 seed 原文。
      ctx.logger.info('recorder.capture.seed', { sessionId, status: 'no_param_match', stage: String(body.sampleName) });
    }
  }
  if (body.sampleName === 'A' || body.sampleName === 'B') {
    ctx.registry.storeSample(sessionId, body.sampleName, entries, screenshot, actions, seedEvidence);
  }
  // 结束录制 → 关闭本样本的录制 tab(owned-tab 模式:tab_projection / vnc 各自拥有的录制 tab)。
  // best-effort,失败不阻断;embedded_iframe **绝不关**(那是 dashboard 自己的 tab,close 会毁掉本页)。
  // 关 tab 后 targetId 失效,清空 page lease;下个样本(B)的 navigate 会 `tabs op:new` 重新开。
  if (s.leaseKind === 'owned_tab' || s.leaseKind === 'container_tab') {
    await daemon.command({ action: 'tabs', op: 'close', session: sessionId, surface: 'browser', contextId: s.contextId, page: s.targetId }).catch(() => {});
    ctx.registry.setPage(sessionId, null);
  }
  json(res, 200, ok({ sessionId, sampleName: body.sampleName, entries, actions, actionsCount: actions.length, actionsDropped: dropped, state: adv.session.state, stateVersion: adv.session.stateVersion }));
}

/** best-effort 读 UI 操作事件(ui-capture-read)。失败/不支持/旧扩展 → 空数组,绝不抛、不阻断录制。 */
async function readUiActions(ctx: Ctx, daemon: DaemonBridge, contextId: string, page: string, sessionId: string, targetFrameUrl?: string): Promise<{ actions: unknown[]; dropped: number }> {
  try {
    const r = await daemon.command({ action: 'ui-capture-read', session: sessionId, surface: 'browser', contextId, page, ...(targetFrameUrl ? { targetFrameUrl } : {}) });
    if (!r.ok || !r.data || typeof r.data !== 'object') return { actions: [], dropped: 0 };
    const d = r.data as { events?: unknown; dropped?: unknown };
    return {
      actions: Array.isArray(d.events) ? d.events : [],
      dropped: typeof d.dropped === 'number' ? d.dropped : 0,
    };
  } catch {
    return { actions: [], dropped: 0 };
  }
}

/** best-effort 页面截图 → base64(jpeg)。失败/不支持返回 undefined,绝不抛、不阻断录制。 */
async function captureScreenshot(ctx: Ctx, daemon: DaemonBridge, contextId: string, page: string, sessionId: string): Promise<string | undefined> {
  try {
    const r = await daemon.command({ action: 'screenshot', session: sessionId, surface: 'browser', contextId, page, format: 'jpeg', quality: 60 });
    if (!r.ok) return undefined;
    // 截图 base64 在结果 data(string)或顶层(兼容不同形状);非 string 视为不支持。
    const data = typeof r.data === 'string' ? r.data : undefined;
    return data && data.length > 0 ? data : undefined;
  } catch {
    return undefined;
  }
}

// M4: rank the session's frozen A/B samples via the shared core engine (capture_b→ranked).
// 打分:规则 rankSamples 先出候选(含 hard-reject 预过滤 + 规则分),再用 LLM scorer 让模型判定信号成立性、
// be 按 profile delta 重算权威分;LLM 失败/无 key → scorer 返回 null,保留规则分(降级,行为不变)。
async function handleRank(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string') return sendFail(res, 'validation_failed', 'sessionId required');
  const s = ctx.registry.getSession(sessionId);
  if (!s) return sendFail(res, 'request_not_found', 'session not found');
  // state gate (CAS): rank only from capture_b.
  const adv = ctx.registry.advance(sessionId, 'rank', 'ranked', s.stateVersion);
  if (!adv.ok) {
    return sendFail(res, adv.reason === 'invalid_state' ? 'invalid_state' : 'queue_full', `cannot rank from ${s.state}`);
  }
  const stored = ctx.registry.getSamples(sessionId) ?? {};
  const samples: CaptureSample[] = [];
  if (stored.A) samples.push({ sampleName: 'A', entries: stored.A.entries as never, ...(stored.A.seedEvidence ? { seedArgsEvidence: stored.A.seedEvidence as never } : {}) });
  if (stored.B) samples.push({ sampleName: 'B', entries: stored.B.entries as never, ...(stored.B.seedEvidence ? { seedArgsEvidence: stored.B.seedEvidence as never } : {}) });
  // rank computation runs in the pure-domain shared package (no IO). The ScoringProfile is always
  // externalized (never inline constants); RANK_SCORE_* overrides apply only when the preview flag is
  // on (09:170) — otherwise the default profile is used even if overrides are set.
  const live = ctx.config.current(); // hot fields read from the live snapshot (M8d)
  const profile = live.featureFlags.FEATURE_PREVIEW_SCORING_PROFILE
    ? live.scoringProfile
    : DEFAULT_SCORING_PROFILE;
  const result = rankSamples({ sessionId, samples }, profile);
  if (!result.ok) {
    // insufficient_samples etc. — session already advanced to 'ranked'; surface the reason.
    return sendFail(res, 'insufficient_samples', result.reason);
  }
  // rank 只做「聚拢候选 + 规则分」(快、本地、免费),**不调 LLM**。真正的 LLM 评分(inferredFunction/
  // paramUnion/双轨分)只在用户进「评分候选页」时经 /recorder/pipeline/score 发生一次——避免 rank 与
  // score 两阶段重复调 LLM(重复花钱),且修 no genCands 根因:genStage 只在 score 阶段写,rank 提前用
  // LLM 填候选会让评分页误判"已评过"跳过 score → genStage 从不写 → 生成报 no genCands。
  const candidates = result.candidates;
  // Freeze candidates on the session so /recorder/init 与 /recorder/pipeline/* 可按 id 选/复用(H-002)。
  ctx.registry.storeCandidates(sessionId, candidates as unknown as Array<{ id: string; [k: string]: unknown }>);
  json(res, 200, ok({ sessionId, state: 'ranked', stateVersion: adv.session.stateVersion, candidates }));
}

// M5a: site analyze. be collects PageSignals via the existing daemon /command chain
// (navigate + exec probe + cookies + network-capture-read), then calls the pure
// analyzeSite from the shared package. daemon stays a thin proxy (no high-level Page);
// browser-IO orchestration lives in be, classification in recorder-core (rank-style split).
const ANALYZE_PROBE_JS = `(function(){
  return {
    cookieNames: (document.cookie||'').split(';').map(function(c){return c.trim().split('=')[0];}).filter(Boolean),
    initialState: {
      __INITIAL_STATE__: typeof window.__INITIAL_STATE__!=='undefined',
      __NUXT__: typeof window.__NUXT__!=='undefined',
      __NEXT_DATA__: typeof window.__NEXT_DATA__!=='undefined',
      __APOLLO_STATE__: typeof window.__APOLLO_STATE__!=='undefined'
    },
    title: document.title||'', finalUrl: location.href
  };
})()`;

async function handleAnalyze(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const sessionId = body.sessionId;
  const url = body.url;
  if (typeof sessionId !== 'string') return sendFail(res, 'validation_failed', 'sessionId required');
  if (typeof url !== 'string' || !url) return sendFail(res, 'validation_failed', 'url required');
  const s = ctx.registry.getSession(sessionId);
  if (!s) return sendFail(res, 'request_not_found', 'session not found');
  if (!s.targetId) return sendFail(res, 'page_lost', 'no page lease; navigate first');

  // analyze is an independent async lifecycle (05:67); it does NOT advance the session state
  // machine. 202 + canonical requestId; poll GET /recorder/requests/{id} for the report.
  const requestId = newRequestId();
  ctx.registry.createRequest({
    requestId, type: 'analyze', sessionId,
    contextId: s.contextId, profileId: s.profileId,
    pollAfterMs: ctx.config.current().REQUEST_POLL_AFTER_MS,
  });
  json(res, 202, ok({ accepted: true, sessionId, type: 'analyze' }, requestId));
  void runAnalyze(ctx, s.contextId, s.targetId, sessionId, url, requestId);
}

// Background analyze: collect PageSignals over the daemon /command chain, classify via the pure
// analyzeSite, write the outcome into the request registry (no res — already 202'd).
async function runAnalyze(ctx: Ctx, ctxId: string, page: string, sessionId: string, url: string, requestId: string): Promise<void> {
  const step = async (action: string, extra: Record<string, unknown> = {}) => {
    const r = await ctx.daemon.command({ action, session: sessionId, surface: 'browser', contextId: ctxId, page, ...extra });
    if (!r.ok && (isLeaseLossCode(r.errorCode) || r.errorCode === 'daemon_timeout')) ctx.registry.markFailed(sessionId);
    return r;
  };
  const failRequest = (code: ErrorCode, message: string) =>
    ctx.registry.finalizeRequest(requestId, { status: 'failed', error: { code, message } });
  try {
    await step('network-capture-start');
    const nav = await step('navigate', { url });
    if (!nav.ok) return failRequest(mapDaemonError(nav.errorCode), nav.error);

    const probe = await step('exec', { code: ANALYZE_PROBE_JS });
    if (!probe.ok) return failRequest(mapDaemonError(probe.errorCode), probe.error);
    const p = (probe.data ?? {}) as { cookieNames?: string[]; initialState?: PageSignals['initialState']; title?: string; finalUrl?: string };
    const finalUrl = p.finalUrl || url;

    const cookieRes = await step('cookies', { url: finalUrl });
    const browserCookieNames = cookieRes.ok && Array.isArray(cookieRes.data)
      ? (cookieRes.data as Array<{ name?: string }>).map((c) => c.name).filter((n): n is string => !!n)
      : [];

    const capRes = await step('network-capture-read');
    const rawItems = capRes.ok && Array.isArray(capRes.data) ? capRes.data as Array<Record<string, unknown>> : [];
    const networkEntries = rawItems.map((e) => ({
      url: typeof e.url === 'string' ? e.url : '',
      status: typeof e.responseStatus === 'number' ? e.responseStatus : (typeof e.status === 'number' ? e.status : 0),
      contentType: typeof e.responseContentType === 'string' ? e.responseContentType : (typeof e.ct === 'string' ? e.ct : ''),
      bodyPreview: typeof e.responsePreview === 'string' ? e.responsePreview : (typeof e.body === 'string' ? e.body : null),
    }));

    const signals: PageSignals = {
      requestedUrl: url,
      finalUrl,
      cookieNames: [...new Set([...(p.cookieNames ?? []), ...browserCookieNames])],
      networkEntries,
      initialState: p.initialState ?? { __INITIAL_STATE__: false, __NUXT__: false, __NEXT_DATA__: false, __APOLLO_STATE__: false },
      title: p.title ?? '',
    };
    // be has no adapter registry; nearest-adapter match is a main-repo concern → empty.
    const report = analyzeSite(signals, new Map<string, AdapterRef>());
    ctx.registry.finalizeRequest(requestId, { status: 'succeeded', result: report });
  } catch (e) {
    failRequest('network_error', e instanceof Error ? e.message : String(e));
  }
}

// M5b/H-002: init is SELECT-ONLY. be requires sessionId + selectedCandidateId, looks up
// the frozen rank candidate, and DERIVES domain/strategy/endpoint server-side (a client
// cannot contradict the chosen candidate — preserves rank -> selectedCandidateId -> init).
// FS write stays main-repo side: be forwards the derived payload to daemon /v1/init.
async function handleInit(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  if (typeof body.name !== 'string' || !body.name) return sendFail(res, 'validation_failed', 'name required');
  const sessionId = body.sessionId;
  const selectedCandidateId = body.selectedCandidateId;
  if (typeof sessionId !== 'string') return sendFail(res, 'validation_failed', 'sessionId required');
  if (typeof selectedCandidateId !== 'string') return sendFail(res, 'validation_failed', 'selectedCandidateId required (init is select-only)');
  const s = ctx.registry.getSession(sessionId);
  if (!s) return sendFail(res, 'request_not_found', 'session not found');
  // state gate: init only from `ranked` (05:61). dry-run previews without advancing; write advances.
  if (!canTransition(s.state, 'init')) return sendFail(res, 'invalid_state', `cannot init from ${s.state}`);
  const candidate = ctx.registry.getCandidate(sessionId, selectedCandidateId);
  if (!candidate) return sendFail(res, 'validation_failed', `unknown selectedCandidateId ${selectedCandidateId} (rank first)`);

  // H-002: writePolicy wire literal is `dry-run | write` (hyphen). Reject stale/garbage
  // values explicitly instead of silently normalizing them to dry-run.
  const wp = body.writePolicy ?? 'dry-run';
  if (wp !== 'dry-run' && wp !== 'write') {
    return sendFail(res, 'validation_failed', `invalid writePolicy ${String(wp)} (expected dry-run|write)`);
  }

  // LLM 合成(feature-gated):为选定候选生成 func/columns。缓存在 session(keyed by candidateId):
  // dry-run 生成一次,write 复用同一份 → 用户审阅的代码 === 写盘的代码,且不重复调 LLM。
  // flag off / 无 key / 调用失败 → synthesize 返回 null → derived 不带 LLM 字段 → daemon 渲染空模板。
  // P0-2 外发前置同意:合成会把截图+真实响应发往 Anthropic,故**仅在请求显式带 egress 同意时才合成**;
  // 无同意 → 不外发(零数据出站),由 llmSynthesisOffered 告诉前端「AI 可用、请先同意」。
  const egressAck = typeof body.llmEgressAcknowledgedAt === 'number' ? body.llmEgressAcknowledgedAt : undefined;
  const llmAvailable = ctx.cfg.LLM_SYNTHESIS_ENABLED && !!ctx.cfg.LLM_API_KEY;
  let synthesis = ctx.registry.getSynthesis(sessionId, selectedCandidateId);
  if (!synthesis && llmAvailable && egressAck) {
    const stored = ctx.registry.getSamples(sessionId) ?? {};
    const samples = [];
    if (stored.A) samples.push({ sampleName: 'A' as const, entries: stored.A.entries, screenshot: stored.A.screenshot, actions: stored.A.actions });
    if (stored.B) samples.push({ sampleName: 'B' as const, entries: stored.B.entries, screenshot: stored.B.screenshot, actions: stored.B.actions });
    const result = await ctx.synthesizer.synthesize({ candidate: candidate as unknown as RankCandidate, samples });
    if (result) {
      ctx.registry.storeSynthesis(sessionId, selectedCandidateId, result);
      synthesis = result;
    }
  }

  // Derive draft inputs from the candidate's endpoint descriptor (never from client free-form).
  const endpoint = (candidate.endpoint ?? {}) as { host?: string; method?: string; authRequired?: boolean };
  const derived = {
    name: body.name,
    domain: endpoint.host,
    strategy: endpoint.authRequired ? 'COOKIE' : 'PUBLIC',
    writePolicy: wp,
    responsibleUseAcknowledgedAt: body.responsibleUseAcknowledgedAt,
    // LLM 合成产物穿进 daemon /v1/init → renderAdapterTemplate 填进模板留白;无则空骨架。
    ...(synthesis
      ? { funcBody: synthesis.funcBody, columns: synthesis.columns, description: synthesis.description, access: synthesis.access, llmModel: ctx.cfg.LLM_MODEL }
      : {}),
  };
  const r = await ctx.daemon.highLevel('/v1/init', derived);
  if (!r.ok) {
    const code = (r.errorCode === 'validation_failed' || r.errorCode === 'responsible_use_required' || r.errorCode === 'daemon_unavailable')
      ? r.errorCode as ErrorCode : 'network_error';
    return sendFail(res, code, r.error);
  }
  // write commits the draft → advance ranked→draft_created (05:61); dry-run is a preview, no advance.
  if (wp === 'write') ctx.registry.advance(sessionId, 'init', 'draft_created', s.stateVersion);
  // llmSynthesisOffered:AI 可用但尚未合成(无同意/未生成)→ 前端提示「用 AI 生成」同意 CTA。
  const respData = (r.data ?? {}) as Record<string, unknown>;
  json(res, 200, ok({ ...respData, llmSynthesisOffered: llmAvailable && !synthesis }));
}

// verify forwards to the daemon high-level /v1/verify endpoint (Codex A':
// subprocess-class runs main-repo side). Since M6 the daemon's verifyAdapter
// delegates to the real child-process runner; be never runs adapter JS itself
// (runner_protocol_error now signals an actual runner fault, not "not implemented").
async function handleVerify(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  if (typeof body.name !== 'string' || !body.name) return sendFail(res, 'validation_failed', 'name required');
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string') return sendFail(res, 'validation_failed', 'sessionId required');
  const s = ctx.registry.getSession(sessionId);
  if (!s) return sendFail(res, 'request_not_found', 'session not found');
  // state gate: verify only from `draft_created` (05:62, after a write init).
  if (!canTransition(s.state, 'verify')) return sendFail(res, 'invalid_state', `cannot verify from ${s.state}`);

  // canonical requestId: one id across be ↔ daemon ↔ runner, and the envelope top-level id the
  // frontend polls with (httpRecorderClient callAsync reads accepted.requestId).
  const requestId = newRequestId();
  ctx.registry.createRequest({
    requestId, type: 'verify', sessionId,
    contextId: s.contextId, profileId: s.profileId,
    pollAfterMs: ctx.config.current().REQUEST_POLL_AFTER_MS,
  });

  // forward to daemon /v1/verify with the canonical id (daemon + RunnerPort key on it).
  const r = await ctx.daemon.highLevel('/v1/verify', { ...body, requestId });
  if (!r.ok) {
    const code = (r.errorCode === 'validation_failed' || r.errorCode === 'runner_protocol_error' || r.errorCode === 'daemon_unavailable')
      ? r.errorCode as ErrorCode : 'network_error';
    ctx.registry.finalizeRequest(requestId, { status: 'failed', error: { code, message: r.error } });
    ctx.logger.warn('recorder.verify', { requestId, sessionId, status: 'failed', errorCode: code });
    return sendFail(res, code, r.error, requestId);
  }
  // runner started → advance draft_created→verifying; 202 Accepted with the canonical id on the
  // envelope top level (data carries no second requestId — one canonical id only).
  ctx.registry.advance(sessionId, 'verify', 'verifying', s.stateVersion);
  ctx.logger.info('recorder.verify', { requestId, sessionId, status: 'accepted', stage: 'verifying' });
  json(res, 202, ok({ accepted: true, sessionId, state: 'verifying' }, requestId));
}

// ── N4 · verify-then-save 流水线(LLM 评分→多脚本→静态检查→草稿→verify→展示→保存) ──────

/** be 内部同步 verify 一个草稿:调 daemon /v1/verify(adapterPath override)→ 轮询到终态 → summary。 */
async function verifyDraftSync(
  ctx: Ctx,
  args: { name: string; adapterPath: string; verifyArgs: Record<string, unknown>; sessionId: string },
): Promise<VerifySummaryLike | null> {
  const r = await ctx.daemon.highLevel('/v1/verify', {
    name: args.name, adapterPath: args.adapterPath, sessionId: args.sessionId,
    executionSeedArgs: args.verifyArgs, fixture: 'ignore', trace: 'off',
  });
  if (!r.ok) return null;
  const reqId = (r.data as { requestId?: string } | undefined)?.requestId;
  if (!reqId) return null;
  // 草稿 verify 专用轮询:不复用面向 UI 的 REQUEST_POLL_AFTER_MS(默认 1000ms,太疏会给每个 verify 拖尾)。
  // verify-runner 真起子进程驱动浏览器,几秒级;300ms 轮询足够跟手,150 次封顶 ≈ 45s 上限。
  const pollMs = 300;
  for (let i = 0; i < 150; i++) {
    await new Promise((res) => setTimeout(res, pollMs));
    const g = await ctx.daemon.highLevelGet(`/v1/requests/${reqId}`);
    if (g.ok && g.data && typeof g.data === 'object') {
      const st = g.data as { status?: string; result?: unknown };
      if (st.status && ['succeeded', 'failed', 'timeout', 'cancelled'].includes(st.status)) {
        return (st.result ?? null) as VerifySummaryLike | null;
      }
    }
  }
  return null; // 超时
}

// POST /recorder/pipeline:从 ranked、egress 同意后跑 score→generate→静态检查→草稿→verify→收集。不推进状态。
async function handlePipeline(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string') return sendFail(res, 'validation_failed', 'sessionId required');
  const s = ctx.registry.getSession(sessionId);
  if (!s) return sendFail(res, 'request_not_found', 'session not found');
  if (s.state !== 'ranked') return sendFail(res, 'invalid_state', `cannot run pipeline from ${s.state}`);
  const llmAvailable = ctx.cfg.LLM_SYNTHESIS_ENABLED && !!ctx.cfg.LLM_API_KEY;
  if (!llmAvailable) return sendFail(res, 'validation_failed', 'LLM 合成未启用(需 FEATURE_LLM_SYNTHESIS + RECORDER_LLM_API_KEY)');
  // egress 同意必须在 POST 入口校验(不可挪到后台);P0-2。
  if (typeof body.llmEgressAcknowledgedAt !== 'number') return sendFail(res, 'validation_failed', 'llmEgressAcknowledgedAt required(外发前置同意)');

  const candidates = (ctx.registry.getCandidates(sessionId) ?? []) as unknown as RankCandidate[];
  if (!candidates.length) return sendFail(res, 'validation_failed', 'no candidates(先 rank)');
  const stored = ctx.registry.getSamples(sessionId) ?? {};
  const samples = [];
  if (stored.A) samples.push({ sampleName: 'A' as const, entries: stored.A.entries, screenshot: stored.A.screenshot, actions: stored.A.actions });
  if (stored.B) samples.push({ sampleName: 'B' as const, entries: stored.B.entries, screenshot: stored.B.screenshot, actions: stored.B.actions });
  const candidateIds = Array.isArray(body.candidateIds) ? body.candidateIds.filter((x): x is string => typeof x === 'string') : undefined;

  // 异步:202 + requestId 立即返回(pipeline 耗时长,score~90s+generate+verify),前端轮询 GET /recorder/requests/{id}
  // 看 progress 阶段(score✓/generate…/verify…)+ 终态 result。复用 analyze/verify 同套 request 生命周期。
  const requestId = newRequestId();
  ctx.registry.createRequest({
    requestId, type: 'pipeline', sessionId,
    contextId: s.contextId, profileId: s.profileId,
    pollAfterMs: ctx.config.current().REQUEST_POLL_AFTER_MS,
  });
  json(res, 202, ok({ accepted: true, sessionId, type: 'pipeline' }, requestId));
  void runPipelineAsync(ctx, sessionId, candidates, samples, candidateIds, requestId);
}

// 后台跑 pipeline:log 回调把阶段开始/结束(耗时)写进 request progress;终态写 result(drafts/rejected/prompts)。
async function runPipelineAsync(
  ctx: Ctx, sessionId: string,
  candidates: RankCandidate[],
  samples: Array<{ sampleName: 'A' | 'B'; entries: unknown; screenshot?: string; actions?: unknown }>,
  candidateIds: string[] | undefined,
  requestId: string,
): Promise<void> {
  try {
    // 与 handleRank 同源 profile(live/preview),传进 pipeline scorer 求分,避免退回闭包默认(High 6)。
    const live = ctx.config.current();
    const profile = live.featureFlags.FEATURE_PREVIEW_SCORING_PROFILE ? live.scoringProfile : DEFAULT_SCORING_PROFILE;
    // 20s heartbeat:长阶段(generate ~90s)pending 时定期 bump updatedAt,让前端 idle-timeout 见活动不误判卡死。
    const hb = setInterval(() => ctx.registry.touchRequest(requestId), 20_000);
    let result;
    try {
      result = await runPipeline(
        { candidates: candidates as never, samples: samples as never, candidateIds, cap: ctx.cfg.RECORDER_LLM_CANDIDATE_CAP, profile },
        {
          scorer: ctx.scorer,
          generator: ctx.generator,
          verifyDraft: (a) => verifyDraftSync(ctx, { ...a, sessionId }),
          // 阶段**开始**:标 running(前端 progress 显示 running + idle-timeout 见活动)。
          onPhaseStart: (stage) => ctx.registry.setPhaseRunning(requestId, stage),
          // 阶段性 prompt 就绪(score prompt 早出 / score 完出 generate prompt)→ 写 partialResult,分析过渡页按阶段展示。
          onPrompts: (prompts) => ctx.registry.setPartialResult(requestId, { prompts }),
          // log(stage,...) 在阶段**结束**时被调(带耗时);标 done。
          log: (stage, durationMs, detail) => {
            ctx.registry.setPhaseDone(requestId, stage, durationMs, detail);
            ctx.logger.info('recorder.pipeline.phase', { sessionId, status: 'ok', durationMs, stage: detail ? `${stage} ${detail}` : stage });
          },
        },
      );
    } finally {
      clearInterval(hb);
    }
    if (!result) {
      return void ctx.registry.finalizeRequest(requestId, { status: 'failed', error: { code: 'network_error', message: 'LLM 流水线失败(评分/生成返回空)' } });
    }
    const prev = ctx.registry.getDrafts(sessionId);
    if (prev?.dir && prev.dir !== result.draftDir) cleanupDraftDir(prev.dir);
    const items = result.drafts.map((d, i) => ({ id: `draft_${i}`, ...d }));
    ctx.registry.storeDrafts(sessionId, result.draftDir, items);
    ctx.registry.finalizeRequest(requestId, { status: 'succeeded', result: { sessionId, drafts: items, rejected: result.rejected, prompts: result.prompts } });
  } catch (e) {
    ctx.registry.finalizeRequest(requestId, { status: 'failed', error: { code: 'network_error', message: String((e as Error).message || e) } });
  }
}

// ── 拆步流程(评分候选 → 生成脚本 → 测试保存):三个独立端点,均自 ranked、不推进状态 ──────────

/** 共享:ranked + LLM 可用 + egress 同意校验;返回 {session} 或已 sendFail。egressRequired=false 时跳过同意校验。 */
function guardPipelineStage(
  ctx: Ctx, body: Record<string, unknown>, res: ServerResponse, egressRequired: boolean,
): { sessionId: string; s: ReturnType<Registry['getSession']> } | null {
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string') { sendFail(res, 'validation_failed', 'sessionId required'); return null; }
  const s = ctx.registry.getSession(sessionId);
  if (!s) { sendFail(res, 'request_not_found', 'session not found'); return null; }
  if (s.state !== 'ranked') { sendFail(res, 'invalid_state', `cannot run pipeline stage from ${s.state}`); return null; }
  const llmAvailable = ctx.cfg.LLM_SYNTHESIS_ENABLED && !!ctx.cfg.LLM_API_KEY;
  if (!llmAvailable) { sendFail(res, 'validation_failed', 'LLM 合成未启用(需 FEATURE_LLM_SYNTHESIS + RECORDER_LLM_API_KEY)'); return null; }
  if (egressRequired && typeof body.llmEgressAcknowledgedAt !== 'number') {
    sendFail(res, 'validation_failed', 'llmEgressAcknowledgedAt required(外发前置同意)'); return null;
  }
  return { sessionId, s };
}

/** 共享:从 registry 读 session 冻结的 A/B 样本,组装 pipeline 用 samples 数组。 */
function pipelineSamples(ctx: Ctx, sessionId: string): Array<{ sampleName: 'A' | 'B'; entries: unknown; screenshot?: string; actions?: unknown }> {
  const stored = ctx.registry.getSamples(sessionId) ?? {};
  const samples = [];
  if (stored.A) samples.push({ sampleName: 'A' as const, entries: stored.A.entries, screenshot: stored.A.screenshot, actions: stored.A.actions });
  if (stored.B) samples.push({ sampleName: 'B' as const, entries: stored.B.entries, screenshot: stored.B.screenshot, actions: stored.B.actions });
  return samples;
}

/** 共享:pipeline 阶段后台 runner 的 deps(heartbeat/onPhaseStart/onPrompts/log,与旧 runPipelineAsync 同套)。 */
function pipelineStageDeps(ctx: Ctx, sessionId: string, requestId: string) {
  return {
    scorer: ctx.scorer,
    generator: ctx.generator,
    verifyDraft: (a: { name: string; adapterPath: string; verifyArgs: Record<string, unknown> }) => verifyDraftSync(ctx, { ...a, sessionId }),
    onPhaseStart: (stage: string) => ctx.registry.setPhaseRunning(requestId, stage),
    onPrompts: (prompts: Record<string, unknown>) => ctx.registry.setPartialResult(requestId, { prompts }),
    log: (stage: string, durationMs: number, detail?: string) => {
      ctx.registry.setPhaseDone(requestId, stage, durationMs, detail);
      ctx.logger.info('recorder.pipeline.phase', { sessionId, status: 'ok', durationMs, stage: detail ? `${stage} ${detail}` : stage });
    },
  };
}

// POST /recorder/pipeline/score:只评分(score-only),出候选(含 LLM 语义推断)+ score/generate 提示词。
// 不生成、不写盘。genCands + 评分结果存 registry 供第二步生成复用。202 异步。
async function handlePipelineScore(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const g = guardPipelineStage(ctx, body, res, true);
  if (!g) return;
  const { sessionId, s } = g;
  const candidates = (ctx.registry.getCandidates(sessionId) ?? []) as unknown as RankCandidate[];
  if (!candidates.length) return sendFail(res, 'validation_failed', 'no candidates(先 rank)');
  const samples = pipelineSamples(ctx, sessionId);
  const candidateIds = Array.isArray(body.candidateIds) ? body.candidateIds.filter((x): x is string => typeof x === 'string') : undefined;

  const requestId = newRequestId();
  ctx.registry.createRequest({ requestId, type: 'pipeline', sessionId, contextId: s!.contextId, profileId: s!.profileId, pollAfterMs: ctx.config.current().REQUEST_POLL_AFTER_MS });
  json(res, 202, ok({ accepted: true, sessionId, type: 'pipeline' }, requestId));
  void runScoreAsync(ctx, sessionId, candidates, samples, candidateIds, requestId);
}

async function runScoreAsync(
  ctx: Ctx, sessionId: string, candidates: RankCandidate[],
  samples: Array<{ sampleName: 'A' | 'B'; entries: unknown; screenshot?: string; actions?: unknown }>,
  candidateIds: string[] | undefined, requestId: string,
): Promise<void> {
  try {
    const live = ctx.config.current();
    const profile = live.featureFlags.FEATURE_PREVIEW_SCORING_PROFILE ? live.scoringProfile : DEFAULT_SCORING_PROFILE;
    const result = await runScore(
      { candidates: candidates as never, samples: samples as never, candidateIds, cap: ctx.cfg.RECORDER_LLM_CANDIDATE_CAP, profile },
      pipelineStageDeps(ctx, sessionId, requestId) as never,
    );
    if (!result) return void ctx.registry.finalizeRequest(requestId, { status: 'failed', error: { code: 'network_error', message: 'LLM 评分失败(返回空)' } });
    // 存 genCands + 评分结果供 generate 阶段复用(不重复评分)。
    ctx.registry.storeGenStage(sessionId, result.genCands, result.scored);
    // 把 LLM 语义层(inferredFunction/paramUnion/score/confidence)merge 回候选给前端展示。
    const scoreById = new Map(result.scored.candidates.map((c) => [c.candidateId, c]));
    let mergedCount = 0;
    const mergedCandidates = candidates.map((c) => {
      const llm = scoreById.get(c.id as string);
      if (!llm) return c;
      mergedCount++;
      return {
        ...c, score: llm.uiScore, confidence: llm.confidence,
        ...(llm.risks?.length ? { risks: llm.risks } : {}),
        ...(llm.scoreExplanation ? { scoreExplanation: llm.scoreExplanation } : {}),
        ...(typeof llm.llmUtilityScore === 'number' ? { llmUtilityScore: llm.llmUtilityScore } : {}),
        ...(llm.inferredFunction ? { inferredFunction: llm.inferredFunction } : {}),
        ...(llm.paramUnion?.length ? { paramUnion: llm.paramUnion } : {}),
        scoredBy: 'llm' as const,
      };
    });
    const sentCandidateIds = result.genCands.map((c) => c.id);
    // 诊断:LLM 分实际 merge 回了几个候选(rank 阶段有等价日志,拆步 score 此前缺)。
    // mergedCount 远小于 candidates.length → 回填 id 错配(位置对齐兜底已尽量救);= 0 → 全走规则分。
    ctx.logger.info('recorder.pipeline.score', { sessionId, status: 'ok', stage: `merged=${mergedCount}/${candidates.length} genCands=${result.genCands.length}` });
    ctx.registry.finalizeRequest(requestId, { status: 'succeeded', result: {
      sessionId, candidates: mergedCandidates, rejected: result.rejected,
      scorePrompt: result.prompts.score, generatePrompt: result.prompts.generate,
      screenshotCount: result.prompts.screenshotCount, sentCandidateIds,
      ...(result.scored.rawInterfacesJson ? { llmRawJson: result.scored.rawInterfacesJson } : {}),
    } });
  } catch (e) {
    ctx.registry.finalizeRequest(requestId, { status: 'failed', error: { code: 'network_error', message: String((e as Error).message || e) } });
  }
}

// 从请求体解析用户选中的候选 id(candidateIds 多选优先,selectedCandidateId 单选兜底兼容 init 契约)。
// generate 与 preview 共用,避免两处过滤规则漂移(codex Moderate)。
function selectedCandidateIdsFromBody(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.candidateIds)) return body.candidateIds.filter((x): x is string => typeof x === 'string');
  if (typeof body.selectedCandidateId === 'string' && body.selectedCandidateId) return [body.selectedCandidateId];
  return [];
}

// 按选中过滤 genCands:选中集空 → 全部(向后兼容);否则只留选中的。generate 与 preview 共用同一规则。
function selectGenCands(body: Record<string, unknown>, allGenCands: RankCandidate[]): RankCandidate[] {
  const selectedIds = selectedCandidateIdsFromBody(body);
  return selectedIds.length ? allGenCands.filter((c) => selectedIds.includes(c.id)) : allGenCands;
}

// POST /recorder/pipeline/generate:只生成脚本(generate-only)+ 静态检查 + 写 0700 草稿。不 verify。
// 读第一步存的 genCands;草稿持久化(不 cleanup,留给第三步逐个 verify/save)。202 异步。
async function handlePipelineGenerate(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const g = guardPipelineStage(ctx, body, res, true);
  if (!g) return;
  const { sessionId, s } = g;
  const genStage = ctx.registry.getGenStage(sessionId);
  if (!genStage || !Array.isArray(genStage.genCands) || !genStage.genCands.length) {
    return sendFail(res, 'validation_failed', 'no genCands(先 score)');
  }
  // 用户在候选页选中的接口:generate 只为选中且生成资格(decision==='generate')的候选生成脚本。
  // 缺省/空 → 全部 genCands(向后兼容)。修 bug:此前忽略选中,全 decision=generate 候选(7个)全喂 →
  // prompt 巨大(97KB 撞 CF 120s)、生成一堆没选的脚本。过滤规则与 preview 共用 selectGenCands 防漂移。
  const genCands = selectGenCands(body, genStage.genCands as RankCandidate[]);
  if (!genCands.length) {
    return sendFail(res, 'validation_failed', '选中的候选都不具备生成资格(decision≠generate),或选中集与 genCands 无交集');
  }
  const samples = pipelineSamples(ctx, sessionId);
  const requestId = newRequestId();
  ctx.registry.createRequest({ requestId, type: 'pipeline', sessionId, contextId: s!.contextId, profileId: s!.profileId, pollAfterMs: ctx.config.current().REQUEST_POLL_AFTER_MS });
  json(res, 202, ok({ accepted: true, sessionId, type: 'pipeline' }, requestId));
  void runGenerateAsync(ctx, sessionId, genCands, genStage.scored, samples, requestId);
}

async function runGenerateAsync(
  ctx: Ctx, sessionId: string, genCands: RankCandidate[], scored: unknown,
  samples: Array<{ sampleName: 'A' | 'B'; entries: unknown; screenshot?: string; actions?: unknown }>,
  requestId: string,
): Promise<void> {
  // 20s heartbeat:generate 长阶段 pending 时 bump updatedAt,让前端 idle-timeout 见活动不误判卡死。
  const hb = setInterval(() => ctx.registry.touchRequest(requestId), 20_000);
  try {
    const result = await runGenerate(genCands as never, scored as never, samples as never, pipelineStageDeps(ctx, sessionId, requestId) as never);
    if (!result) return void ctx.registry.finalizeRequest(requestId, { status: 'failed', error: { code: 'network_error', message: 'LLM 生成失败(返回空)' } });
    const prev = ctx.registry.getDrafts(sessionId);
    if (prev?.dir && prev.dir !== result.draftDir) cleanupDraftDir(prev.dir);
    const items = result.drafts.map((d, i) => ({ id: `draft_${i}`, ...d }));
    ctx.registry.storeDrafts(sessionId, result.draftDir, items);
    ctx.registry.finalizeRequest(requestId, { status: 'succeeded', result: { sessionId, drafts: items } });
  } catch (e) {
    ctx.registry.finalizeRequest(requestId, { status: 'failed', error: { code: 'network_error', message: String((e as Error).message || e) } });
  } finally {
    clearInterval(hb);
  }
}

// POST /recorder/draft/verify:单草稿真 verify(第三步「测试」按钮)。body {draftId}。复用 verifyDraftSync
// (daemon /v1/verify + 轮询)→ meetsExpectation 判定 → 回写 registry 草稿。202 异步。
async function handleDraftVerify(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string') return sendFail(res, 'validation_failed', 'sessionId required');
  const draftId = body.draftId;
  if (typeof draftId !== 'string' || !draftId) return sendFail(res, 'validation_failed', 'draftId required');
  const s = ctx.registry.getSession(sessionId);
  if (!s) return sendFail(res, 'request_not_found', 'session not found');
  if (s.state !== 'ranked') return sendFail(res, 'invalid_state', `cannot verify draft from ${s.state}`);
  const drafts = ctx.registry.getDrafts(sessionId);
  const draft = drafts?.items.find((d) => d.id === draftId) as (PipelineDraft & { id: string }) | undefined;
  if (!draft) return sendFail(res, 'validation_failed', `unknown draftId ${draftId}`);
  if (!draft.filePath) return sendFail(res, 'validation_failed', '该草稿无可测文件(静态未通过或写盘失败)');

  const requestId = newRequestId();
  // 用 type 'pipeline'(非 'verify'):draft/verify 内部已用 verifyDraftSync 代理 daemon 并把整形后的
  // 结果 finalize 进 registry。若标 type='verify',handleRequestStatus 会再次代理 daemon 拿 runner 原始
  // 结果覆盖我们整形的 {draftId,usable,verify},故走 be-内结果直返的 'pipeline' 生命周期。
  ctx.registry.createRequest({ requestId, type: 'pipeline', sessionId, contextId: s.contextId, profileId: s.profileId, pollAfterMs: ctx.config.current().REQUEST_POLL_AFTER_MS });
  json(res, 202, ok({ accepted: true, sessionId, type: 'verify' }, requestId));
  void (async () => {
    try {
      const summary = await verifyDraftSync(ctx, { name: `${draft.site}/${draft.name}`, adapterPath: draft.filePath!, verifyArgs: draft.verifyArgs ?? {}, sessionId });
      const verify: VerifyOutcome = meetsExpectation(summary, draft.verifyExpectation);
      ctx.registry.updateDraftVerify(sessionId, draftId, verify as never);
      ctx.registry.finalizeRequest(requestId, { status: 'succeeded', result: { sessionId, draftId, verify, usable: verify.ok } });
    } catch (e) {
      ctx.registry.finalizeRequest(requestId, { status: 'failed', error: { code: 'network_error', message: String((e as Error).message || e) } });
    }
  })();
}

// GET-like POST /recorder/pipeline/preview:**不调用 LLM、不外发、不改状态**,只构建并返回将要发给 LLM 的
// 评分(score)阶段提示词 + 截图张数,供用户在「发送痕迹」同意前预览。生成(generate)阶段提示词依赖
// 评分结果(需先调 LLM),故预览阶段不可得——运行后才在结果页展示。透明优先:发出前先让用户看到发什么。
function handlePipelinePreview(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): void {
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string') return sendFail(res, 'validation_failed', 'sessionId required');
  const s = ctx.registry.getSession(sessionId);
  if (!s) return sendFail(res, 'request_not_found', 'session not found');
  if (s.state !== 'ranked') return sendFail(res, 'invalid_state', `cannot preview pipeline from ${s.state}`);
  const candidates = (ctx.registry.getCandidates(sessionId) ?? []) as unknown as RankCandidate[];
  if (!candidates.length) return sendFail(res, 'validation_failed', 'no candidates(先 rank)');
  const stored = ctx.registry.getSamples(sessionId) ?? {};
  const samples = [];
  if (stored.A) samples.push({ sampleName: 'A' as const, entries: stored.A.entries, screenshot: stored.A.screenshot, actions: stored.A.actions });
  if (stored.B) samples.push({ sampleName: 'B' as const, entries: stored.B.entries, screenshot: stored.B.screenshot, actions: stored.B.actions });
  const screenshotCount = samples.filter((x) => !!x.screenshot).length;
  // 透明展示:用真实 selectCandidatesForLlm(cap=5 + junk 预过滤)算出会被喂 LLM 的候选 id,
  // 供前端表格初始化默认勾选(top-N,N=cap)。
  const sentCandidateIds = selectCandidatesForLlm(candidates, ctx.cfg.RECORDER_LLM_CANDIDATE_CAP).map((c) => c.id);
  // generate 提示词预览:score 阶段已存 genCands(含 LLM 语义层)。按用户选中过滤——用**共享**
  // selectGenCands(与 handlePipelineGenerate 同一规则,防漂移:candidateIds/selectedCandidateId、空→全部)。
  // 还没 score(无 genStage)→ generate 留空(依赖评分结果)。交集空 → 空 prompt(preview 不报错,前端据空态禁用生成)。
  const genStage = ctx.registry.getGenStage(sessionId);
  const genCands = selectGenCands(body, (genStage?.genCands ?? []) as RankCandidate[]);
  const generatePrompt = genCands.length ? buildGenPrompt({ candidates: genCands, samples }) : '';
  json(res, 200, ok({
    sessionId,
    prompts: {
      score: buildScorePrompt({ candidates, samples }),
      generate: generatePrompt,
      screenshotCount,
    },
    sentCandidateIds,
  }));
}

// POST /recorder/save:保存一个或多个(可能编辑过的)草稿到 clis/;最后一次性 ranked→done。
// 兼容单存 `{draftId, source?}` 与批量 `{drafts:[{draftId, source?}]}`(多选保存)。
async function handleSave(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string') return sendFail(res, 'validation_failed', 'sessionId required');
  const s = ctx.registry.getSession(sessionId);
  if (!s) return sendFail(res, 'request_not_found', 'session not found');
  if (!canTransition(s.state, 'saveAdapter')) return sendFail(res, 'invalid_state', `cannot save from ${s.state}`);

  // 归一成 [{draftId, source?}] —— 批量 drafts[] 优先,否则回落单 draftId(向后兼容)。
  type SaveItem = { draftId: string; source?: string };
  let items: SaveItem[];
  if (Array.isArray(body.drafts)) {
    items = (body.drafts as Array<Record<string, unknown>>)
      .filter((d) => typeof d?.draftId === 'string')
      .map((d) => ({ draftId: d.draftId as string, source: typeof d.source === 'string' ? d.source : undefined }));
  } else if (typeof body.draftId === 'string') {
    items = [{ draftId: body.draftId, source: typeof body.source === 'string' ? body.source : undefined }];
  } else {
    return sendFail(res, 'validation_failed', 'draftId or drafts[] required');
  }
  if (!items.length) return sendFail(res, 'validation_failed', 'no drafts to save');

  const drafts = ctx.registry.getDrafts(sessionId);
  const saved: Array<{ draftId: string; site: string; name: string; adapterPath?: string }> = [];
  const failed: Array<{ draftId: string; reason: string }> = [];
  for (const item of items) {
    const draft = drafts?.items.find((d) => d.id === item.draftId) as { site?: string; name?: string; source?: string } | undefined;
    if (!draft) { failed.push({ draftId: item.draftId, reason: `unknown draftId ${item.draftId}` }); continue; }
    // 用户可能在前端改过源码;否则用草稿原 source。name 用 site/command。
    const source = item.source && item.source.trim() ? item.source : String(draft.source ?? '');
    const name = `${draft.site}/${draft.name}`;
    if (!source.trim()) { failed.push({ draftId: item.draftId, reason: 'empty source' }); continue; }
    const r = await ctx.daemon.highLevel('/v1/save-adapter', { name, source, llmModel: ctx.cfg.LLM_MODEL });
    if (!r.ok) { failed.push({ draftId: item.draftId, reason: r.error || r.errorCode || 'save failed' }); continue; }
    const data = (r.data ?? {}) as { adapterPath?: string };
    saved.push({ draftId: item.draftId, site: String(draft.site ?? ''), name: String(draft.name ?? ''), adapterPath: data.adapterPath });
  }

  // 拆步流程:保存成功后**停留 ranked**(用户可逐个保存其他脚本),不推进 done、不清草稿目录
  // (草稿清理移到 cancel/会话终止,见 handleCancel)。全失败则保持 ranked 让用户重试。
  if (!saved.length) {
    return sendFail(res, 'validation_failed', failed[0]?.reason ?? 'all saves failed');
  }
  json(res, 200, ok({
    sessionId,
    state: 'ranked',
    saved,
    ...(failed.length ? { failed } : {}),
    // 向后兼容:单存调用方仍读 adapterPath。
    adapterPath: saved[0]?.adapterPath,
  }));
}

async function route(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://127.0.0.1`);
  const path = url.pathname;
  const key = `${method} ${path}`;

  // 一次性 bootstrap 注入端点(不过门禁;nonce 单次换 token+csrf)
  if (method === 'GET' && path === '/__bootstrap') {
    const got = ctx.vault.consume(url.searchParams.get('nonce') ?? '');
    if (!got) return sendFail(res, 'auth_failed', 'invalid or consumed bootstrap nonce');
    return json(res, 200, ok({ baseUrl: `http://${ctx.cfg.HOST}:${ctx.cfg.PORT}`, ...got }));
  }

  // health:只读,仅过 header+origin(无 side-effect,不要求 CSRF)
  if (method === 'GET' && path === '/recorder/health') {
    const g = checkGates(req, { allowedOrigins: ctx.cfg.ALLOWED_ORIGINS, vault: ctx.vault }, false);
    if (!g.ok) return sendFail(res, g.code!, g.message!);
    return handleHealth(ctx, res);
  }

  // request status:只读
  if (method === 'GET' && path.startsWith('/recorder/requests/')) {
    const g = checkGates(req, { allowedOrigins: ctx.cfg.ALLOWED_ORIGINS, vault: ctx.vault }, false);
    if (!g.ok) return sendFail(res, g.code!, g.message!);
    return await handleRequestStatus(ctx, decodeURIComponent(path.slice('/recorder/requests/'.length)), res);
  }

  // 所有 side-effect POST:全套门禁(含 CSRF)
  if (method === 'POST' && path.startsWith('/recorder/')) {
    const g = checkGates(req, { allowedOrigins: ctx.cfg.ALLOWED_ORIGINS, vault: ctx.vault }, true);
    if (!g.ok) return sendFail(res, g.code!, g.message!);

    // M1 未过:导航链路占位
    if (GATED_ROUTES.has(key)) {
      return sendFail(res, 'feature_disabled', 'endpoint gated until M1 navigation spike lands');
    }

    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (e) {
      return sendFail(res, 'validation_failed', e instanceof Error ? e.message : 'invalid body');
    }

    // 幂等(03 章):side-effect POST 的 Idempotency-Key
    const idemKey = req.headers['idempotency-key'];
    if (typeof idemKey === 'string' && idemKey) {
      const scope = `${body.sessionId ?? 'no-session'}|${key}|${idemKey}`;
      const hit = ctx.registry.checkIdempotency(scope, payloadHash(body));
      if (hit === 'conflict') {
        ctx.metrics.inc('recorder_idempotency_conflict_total');
        return sendFail(res, 'idempotency_conflict', 'same key, different payload');
      }
      ctx.registry.recordIdempotency(scope, payloadHash(body), String(body.sessionId ?? ''));
    }

    switch (path) {
      case '/recorder/session/bind': return await handleBind(ctx, body, res);
      case '/recorder/session/confirm-auth': return handleConfirmAuth(ctx, body, res);
      case '/recorder/cancel': return handleCancel(ctx, body, res);
      case '/recorder/navigate': return await handleNavigate(ctx, body, res);
      case '/recorder/capture/start': return await handleCaptureStart(ctx, body, res);
      case '/recorder/capture/read': return await handleCaptureRead(ctx, body, res);
      case '/recorder/screenshot': return await handleScreenshot(ctx, body, res);
      case '/recorder/input': return await handleInput(ctx, body, res);
      case '/recorder/rank': return await handleRank(ctx, body, res);
      case '/recorder/analyze': return await handleAnalyze(ctx, body, res);
      case '/recorder/init': return await handleInit(ctx, body, res);
      case '/recorder/pipeline': return await handlePipeline(ctx, body, res);
      case '/recorder/pipeline/preview': return handlePipelinePreview(ctx, body, res);
      case '/recorder/pipeline/score': return await handlePipelineScore(ctx, body, res);
      case '/recorder/pipeline/generate': return await handlePipelineGenerate(ctx, body, res);
      case '/recorder/draft/verify': return await handleDraftVerify(ctx, body, res);
      case '/recorder/save': return await handleSave(ctx, body, res);
      case '/recorder/verify': return await handleVerify(ctx, body, res);
      case '/recorder/admin/log-level':
        // restart-only flag off → endpoint genuinely absent(与 default 同效,09:168)
        if (!ctx.cfg.featureFlags.FEATURE_ADMIN_LOG_LEVEL_TOGGLE) return sendFail(res, 'request_not_found', 'unknown endpoint');
        return handleAdminLogLevel(ctx, body, res);
      default: return sendFail(res, 'request_not_found', 'unknown endpoint');
    }
  }

  // 同源 UI 托管(①):GET 非 API 请求交静态服务器(SPA fallback + bootstrap 注入)
  if (method === 'GET' && ctx.staticServer && !path.startsWith('/recorder/')) {
    const served = await ctx.staticServer.handle(path, res, {
      baseUrl: `http://${ctx.cfg.HOST}:${ctx.cfg.PORT}`,
      token: ctx.vault.token,
      csrfToken: ctx.vault.csrfToken,
      embeddedIframeRecording: ctx.cfg.featureFlags.FEATURE_EMBEDDED_IFRAME_RECORDING,
      vncRecording: ctx.cfg.featureFlags.FEATURE_VNC_RECORDING,
    });
    if (served) return;
  }

  sendFail(res, 'request_not_found', 'not found');
}

export function createApp(cfg: RecorderConfig, loggerOverride?: Logger, metricsOverride?: Metrics): { server: ReturnType<typeof createServer>; ctx: Ctx } {
  const vault = new BootstrapVault(cfg.TOKEN);
  const logger = loggerOverride ?? createLogger(cfg.LOG_LEVEL);
  const ctx: Ctx = {
    cfg,
    vault,
    daemon: createDaemonBridge(cfg.DAEMON_PORT),
    registry: new Registry(cfg.RECORDER_MAX_ACTIVE_SESSIONS, cfg.REQUEST_TERMINAL_STATUS_TTL_MS),
    // #5a 同源 UI 托管由 restart-only flag FEATURE_LOCALHOST_HTTP_UI 主控(09:162/ADR-0001:
    // 是否进入「纯网页 localhost HTTP UI 形态」);UI_DIST 降级为「服哪个 build」。flag off → 即使设了
    // UI_DIST 也不托管(GET fallthrough 落 request_not_found),与默认 Electron-IPC/API-only 形态一致。
    // 从 pinned 启动 config 读(restart-only,绝不读热快照)。
    staticServer: (cfg.featureFlags.FEATURE_LOCALHOST_HTTP_UI && cfg.UI_DIST)
      ? createStaticServer(cfg.UI_DIST, resolveFrameSrc(cfg.featureFlags.FEATURE_EMBEDDED_IFRAME_RECORDING, cfg.IFRAME_FRAME_SRC, cfg.featureFlags.FEATURE_VNC_RECORDING))
      : null,
    logger,
    metrics: metricsOverride ?? createMetrics(),
    config: createConfigPort(cfg, (lvl) => logger.setLevel(lvl)),
    // 默认合成器:有 key 才建真 SDK 客户端;否则 synthesize 永远 null(退回空模板)。测试可替换 ctx.synthesizer。
    synthesizer: createSynthesizer({
      apiKey: cfg.LLM_SYNTHESIS_ENABLED ? cfg.LLM_API_KEY : undefined,
      baseURL: cfg.LLM_BASE_URL,
      model: cfg.LLM_MODEL,
      timeoutMs: cfg.LLM_TIMEOUT_MS,
    }),
    scorer: createScorer({
      apiKey: cfg.LLM_SYNTHESIS_ENABLED ? cfg.LLM_API_KEY : undefined,
      baseURL: cfg.LLM_BASE_URL,
      model: cfg.LLM_MODEL,
      timeoutMs: cfg.LLM_TIMEOUT_MS,
      // 把 score() 内被捕获的错误经结构化 logger 暴露(不破坏 null 契约):超时/网络/解析失败可诊断。
      // 收到的可能是 Error 也可能是结构化观测对象(score_prompt_degraded),统一 stringifyLlmError 序列化,
      // 避免旧写法把无-message 对象记成 "[object Object]"。
      onError: (err) => logger.warn('recorder.rank.llm_score_error', { status: 'error', stage: stringifyLlmError(err) }),
    }),
    generator: createGenerator({
      apiKey: cfg.LLM_SYNTHESIS_ENABLED ? cfg.LLM_API_KEY : undefined,
      baseURL: cfg.LLM_BASE_URL,
      model: cfg.LLM_MODEL,
      timeoutMs: cfg.LLM_TIMEOUT_MS,
      // 逐候选生成/预算降级/repair 的错误经结构化 logger 暴露(不破坏 null 契约):可诊断超时/降级/单候选失败。
      onError: (err) => logger.warn('recorder.pipeline.llm_generate_error', { status: 'error', stage: stringifyLlmError(err) }),
    }),
    vnc: createVncOrchestrator({ logger }),
    vncBridges: new Map(),
  };
  const server = createServer((req, res) => {
    // Single request-completion choke point (09 Structured Logging + Metrics): operation + outcome
    // + latency, no per-handler scatter. Only path/method/status/errorCode — never headers, token,
    // body or seed args.
    const started = Date.now();
    res.on('finish', () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      if (!path.startsWith('/recorder/')) return; // skip static assets / bootstrap noise
      const rel = path.slice('/recorder/'.length);
      // Collapse the one dynamic segment (GET /recorder/requests/{id}) to a stable route template, so
      // the `operation` label has BOUNDED cardinality — otherwise every requestId would mint a new
      // metric counter (unbounded memory growth) and a distinct log operation.
      const operation = rel.startsWith('requests/') ? 'recorder.requests' : `recorder.${rel.replace(/\//g, '.')}`;
      const status = res.statusCode < 400 ? 'ok' : 'failed';
      const errorCode = (res as ServerResponse & { __errorCode?: string }).__errorCode;
      const durationMs = Date.now() - started;
      ctx.logger.info(operation, { status, errorCode, durationMs });
      ctx.metrics.inc('recorder_requests_total', { operation, status, errorCode });
      ctx.metrics.observe('recorder_request_duration_ms', durationMs);
    });
    route(ctx, req, res).catch(() => {
      if (!res.headersSent) sendFail(res, 'network_error', 'internal error');
    });
  });
  return { server, ctx };
}

// 直接启动(node dist/server.js)
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    const cfg = loadConfig();
    const { server, ctx } = createApp(cfg);
    // Operator signals. Each handler is exception-contained — an uncaught throw from a signal
    // callback (e.g. a stderr EPIPE in the log sink) would crash the long-running service (Codex M8).
    // No SIGUSR1 metrics dump: SIGUSR1 is reserved by Node for the inspector; metrics are read via
    // ctx.metrics.snapshot() and the future loopback /metrics endpoint (M9), not a signal.
    const onSignal = (name: NodeJS.Signals, fn: () => void): void => {
      process.on(name, () => { try { fn(); } catch { /* never let a signal handler crash the process */ } });
    };
    // SIGUSR2 cycles LOG_LEVEL at runtime (09 Log Level Control); never widens redaction.
    onSignal('SIGUSR2', () => ctx.logger.info('recorder.log_level_changed', { status: ctx.logger.cycleLevel() }));
    // SIGHUP hot-reloads config (M8d · 09): re-read + validate, atomically swap the hot fields; a
    // failed reload keeps the old config. Security/restart fields are pinned regardless.
    onSignal('SIGHUP', () => {
      const r = ctx.config.reload();
      if (r.ok) ctx.logger.info('recorder.config_reloaded', { status: `v${r.version}` });
      else ctx.logger.warn('recorder.config_reload_failed', { errorCode: 'config_invalid', status: r.reason });
    });
    server.listen(cfg.PORT, cfg.HOST, () => {
      // structured startup log; the one-time nonce goes to a separate human line, never the token.
      ctx.logger.info('recorder.listening', { status: `http://${cfg.HOST}:${cfg.PORT}` });
      process.stderr.write(`[recorder-be] bootstrap: GET /__bootstrap?nonce=${ctx.vault.bootstrapNonce}\n`);
    });
  } catch (e) {
    if (e instanceof ConfigInvalidError) {
      // config failed before ctx/logger exists → a single structured line to stderr.
      process.stderr.write(JSON.stringify({ level: 'error', operation: 'recorder.config_invalid', errorCode: e.code }) + '\n');
      process.exit(1);
    }
    throw e;
  }
}

export type { SessionState };
