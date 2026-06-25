// Recorder Local Service —— localhost HTTP server(M2 shell)。
// 仅监听 127.0.0.1;side-effect 经 04 章门禁;navigate/capture/rank/init/verify 占位 feature_disabled。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { loadConfig, ConfigInvalidError, type RecorderConfig } from './config.js';
import { BootstrapVault } from './security/bootstrap.js';
import { checkGates } from './security/gates.js';
import { createDaemonBridge, type DaemonBridge } from './transport/daemonBridge.js';
import { createStaticServer, type StaticServer } from './static.js';
import { createLogger, type Logger, type LogLevel } from './logger.js';
import { createMetrics, type Metrics } from './metrics.js';
import { createConfigPort, type ConfigPort } from './config-port.js';
import { Registry } from './session/registry.js';
import { type SessionState, canTransition, isLeaseLossCode } from './session/stateMachine.js';
import { rankSamples, analyzeSite, DEFAULT_SCORING_PROFILE, type CaptureSample, type PageSignals, type AdapterRef } from '@sovovs/bycli-recorder-core';
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
  const status = await ctx.daemon.status();
  if (status === null) {
    // daemon 不可达:health 仍 200 返回降级态(不 fail,UI 据此引导启动)
    json(res, 200, ok({ localService: 'ok', daemon: 'down', extension: 'disconnected', highLevel: 'down' }));
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
    }),
  );
}

function handleBind(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): void {
  const mode = body.mode;
  // contextId 不写死 'default':client 不传时留空,daemon 用单连接回退路由到唯一连着的扩展。
  // 真扩展常注册在生成的 profile id(如 'xhz62x7b'),写死 'default' 会 profile_disconnected
  // (真扩展实测发现)。多 profile 场景由 UI 显式传 contextId。
  const contextId = typeof body.contextId === 'string' ? body.contextId : '';
  if (mode !== 'bind_existing_page' && mode !== 'create_page_await_user_login' && mode !== 'bind_existing_context') {
    return sendFail(res, 'validation_failed', 'invalid bind mode');
  }
  try {
    const session = ctx.registry.createSession({
      contextId,
      targetId: typeof body.targetId === 'string' ? body.targetId : null,
      profileId: typeof body.profileId === 'string' ? body.profileId : null,
      awaitingLogin: mode === 'create_page_await_user_login',
    });
    json(res, 200, ok({
      sessionId: session.sessionId,
      contextId: session.contextId,
      targetId: session.targetId,
      awaitingLogin: session.state === 'awaiting_user_login',
      stateVersion: session.stateVersion,
    }));
  } catch (e) {
    const code = (e as { code?: ErrorCode }).code ?? 'validation_failed';
    sendFail(res, code, 'cannot create session');
  }
}

function handleConfirmAuth(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): void {
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string') return sendFail(res, 'validation_failed', 'sessionId required');
  const s = ctx.registry.getSession(sessionId);
  if (!s) return sendFail(res, 'request_not_found', 'session not found');
  const r = ctx.registry.advance(sessionId, 'confirmAuth', 'auth_confirmed', s.stateVersion);
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
  if (sessionId) ctx.registry.cancelSession(sessionId);
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
  // 状态门禁(CAS):navigate 只允许 session_bound/auth_confirmed/page_ready
  const adv = ctx.registry.advance(sessionId, 'navigate', 'page_ready', s.stateVersion);
  if (!adv.ok) {
    return sendFail(res, adv.reason === 'invalid_state' ? 'invalid_state' : 'queue_full', `cannot navigate from ${s.state}`);
  }
  // 经 daemon → 扩展 chrome.tabs.update(已被扩展侧 handleNavigate 的 Fetch guard 保护)
  // 浏览器命令必须带 session(扩展按 surface:session 做 tab lease key;缺 session → session_required)。
  // 用 recorder sessionId 作 session 名:同一 recorder 会话所有命令复用同一 lease/标签页。surface 显式
  // 'browser'(扩展默认也是 browser)。详见记忆 be-missing-session-breaks-real-extension。
  const r = await ctx.daemon.command({ action: 'navigate', session: sessionId, surface: 'browser', url, contextId: s.contextId, page: s.targetId });
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
  // Sample A start advances page_ready→capture_a; sample B start advances capture_a→capture_b (05:50).
  const nextState: SessionState = s.state === 'capture_a' ? 'capture_b' : 'capture_a';
  const adv = ctx.registry.advance(sessionId, 'captureStart', nextState, s.stateVersion);
  if (!adv.ok) {
    return sendFail(res, adv.reason === 'invalid_state' ? 'invalid_state' : 'queue_full', `cannot start capture from ${s.state}`);
  }
  const pattern = typeof body.pattern === 'string' ? body.pattern : '';
  const r = await ctx.daemon.command({ action: 'network-capture-start', session: sessionId, surface: 'browser', contextId: s.contextId, page: s.targetId, pattern });
  if (!r.ok) {
    if (isLeaseLossCode(r.errorCode) || r.errorCode === 'daemon_timeout') ctx.registry.markFailed(sessionId);
    return sendFail(res, mapDaemonError(r.errorCode), r.error);
  }
  json(res, 200, ok({ sessionId, state: adv.session.state, stateVersion: adv.session.stateVersion, sampleName: body.sampleName, started: true }));
}

async function handleCaptureRead(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string') return sendFail(res, 'validation_failed', 'sessionId required');
  if (typeof body.sampleName !== 'string' || !body.sampleName) return sendFail(res, 'validation_failed', 'sampleName required');
  const s = ctx.registry.getSession(sessionId);
  if (!s) return sendFail(res, 'request_not_found', 'session not found');
  if (!s.targetId) return sendFail(res, 'page_lost', 'no page lease; navigate first');
  // captureRead 不推进状态机(允许在 page_ready/capture_a 多次读),但校验来源态合法
  if (!canTransition(s.state, 'captureRead')) {
    return sendFail(res, 'invalid_state', `cannot read capture from ${s.state}`);
  }
  const r = await ctx.daemon.command({ action: 'network-capture-read', session: sessionId, surface: 'browser', contextId: s.contextId, page: s.targetId });
  if (!r.ok) {
    if (isLeaseLossCode(r.errorCode) || r.errorCode === 'daemon_timeout') ctx.registry.markFailed(sessionId);
    return sendFail(res, mapDaemonError(r.errorCode), r.error);
  }
  // Freeze this sample's entries into the session so rank can read A/B later (05:51).
  const entries = Array.isArray(r.data) ? r.data : [];
  if (body.sampleName === 'A' || body.sampleName === 'B') {
    ctx.registry.storeSample(sessionId, body.sampleName, entries);
  }
  json(res, 200, ok({ sessionId, sampleName: body.sampleName, entries }));
}

// M4: rank the session's frozen A/B samples via the shared core engine (capture_b→ranked).
function handleRank(ctx: Ctx, body: Record<string, unknown>, res: ServerResponse): void {
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
  if (stored.A) samples.push({ sampleName: 'A', entries: stored.A as never });
  if (stored.B) samples.push({ sampleName: 'B', entries: stored.B as never });
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
  // Freeze candidates on the session so /recorder/init can select one by id (H-002).
  ctx.registry.storeCandidates(sessionId, result.candidates as unknown as Array<{ id: string; [k: string]: unknown }>);
  json(res, 200, ok({ sessionId, state: 'ranked', stateVersion: adv.session.stateVersion, candidates: result.candidates }));
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

  // Derive draft inputs from the candidate's endpoint descriptor (never from client free-form).
  const endpoint = (candidate.endpoint ?? {}) as { host?: string; method?: string; authRequired?: boolean };
  const derived = {
    name: body.name,
    domain: endpoint.host,
    strategy: endpoint.authRequired ? 'COOKIE' : 'PUBLIC',
    writePolicy: wp,
    responsibleUseAcknowledgedAt: body.responsibleUseAcknowledgedAt,
  };
  const r = await ctx.daemon.highLevel('/v1/init', derived);
  if (!r.ok) {
    const code = (r.errorCode === 'validation_failed' || r.errorCode === 'responsible_use_required' || r.errorCode === 'daemon_unavailable')
      ? r.errorCode as ErrorCode : 'network_error';
    return sendFail(res, code, r.error);
  }
  // write commits the draft → advance ranked→draft_created (05:61); dry-run is a preview, no advance.
  if (wp === 'write') ctx.registry.advance(sessionId, 'init', 'draft_created', s.stateVersion);
  json(res, 200, ok(r.data));
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
      case '/recorder/session/bind': return handleBind(ctx, body, res);
      case '/recorder/session/confirm-auth': return handleConfirmAuth(ctx, body, res);
      case '/recorder/cancel': return handleCancel(ctx, body, res);
      case '/recorder/navigate': return await handleNavigate(ctx, body, res);
      case '/recorder/capture/start': return await handleCaptureStart(ctx, body, res);
      case '/recorder/capture/read': return await handleCaptureRead(ctx, body, res);
      case '/recorder/rank': return handleRank(ctx, body, res);
      case '/recorder/analyze': return await handleAnalyze(ctx, body, res);
      case '/recorder/init': return await handleInit(ctx, body, res);
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
    staticServer: (cfg.featureFlags.FEATURE_LOCALHOST_HTTP_UI && cfg.UI_DIST) ? createStaticServer(cfg.UI_DIST) : null,
    logger,
    metrics: metricsOverride ?? createMetrics(),
    config: createConfigPort(cfg, (lvl) => logger.setLevel(lvl)),
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
