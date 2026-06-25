// M9 High-Level HTTP wrapper —— 独立 loopback HTTP server(07 · Optional HTTP Wrapper)。
// 形态镜像 dashboard-be/src/server.ts 的 createApp/createServer/finish-logger,但**主仓侧**(直调
// high-level 模块,不经 daemon bridge,不 import be)。与 daemon 的 /v1/*(daemon-high-level.v1)是
// 独立 server / 独立路由族(ADR-0007,严禁混淆)。默认关闭,经 `bycli internal highlevel-http` 启动。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadWrapperConfig, type WrapperConfig } from './wrapper-config.js';
import { WrapperRegistry } from './wrapper-registry.js';
import { checkWrapperGates } from './wrapper-gates.js';
import { errorBody } from './wrapper-envelope.js';
import {
  handleHealth,
  handleInit,
  handleVerify,
  handleAnalyze,
  handleRequestStatus,
  type HandlerOutcome,
} from './handlers.js';
import { createMetrics, type Metrics } from './wrapper-metrics.js';
import { createAnalyzeRunner, type AnalyzeRunner } from './analyze-runner.js';
import { createAdapterDraft } from '../highlevel/init.js';
import {
  defaultRunnerPort,
  setDefaultRunnerDaemonPort,
  type RunnerPortWithLifecycle,
} from '../runner/runner-port.js';

/** 结构化日志允许字段(09;forbidden=token/body/seed 类型上就进不来)。 */
interface LogFields {
  status: string;
  errorCode?: string;
  durationMs?: number;
  requestId?: string;
}

export interface WrapperDeps {
  /** 注入时钟(测试 TTL)。 */
  now?: () => number;
  /** 注入 init 实现(测试无需写盘)。默认真实 createAdapterDraft。 */
  createDraft?: typeof createAdapterDraft;
  /** 结构化日志 sink(默认 stderr 单行 JSON)。 */
  logSink?: (line: string) => void;
  /** 注入 metrics(测试断言)。默认 createMetrics()。 */
  metrics?: Metrics;
  /** 注入 verify runner(测试 fake;production = defaultRunnerPort,连回 daemon 拿 Page 跑 browser adapter)。 */
  runner?: RunnerPortWithLifecycle;
  /** 注入 sessionId→HMAC key(测试)。默认进程级 defaultSessionKeyRegistry。 */
  sessionKeyFor?: (sessionId?: string) => string;
  /** 注入 analyze runner(测试 fake;production = daemon-backed Page)。 */
  analyzeRunner?: AnalyzeRunner;
}

export interface WrapperCtx {
  cfg: WrapperConfig;
  registry: WrapperRegistry;
  createDraft: typeof createAdapterDraft;
  runner: RunnerPortWithLifecycle;
  sessionKeyFor?: (sessionId?: string) => string;
  analyzeRunner: AnalyzeRunner;
  /** 在飞后台作业(analyze in-process Page);shutdown drain 用(Codex M9 Med)。 */
  inflight: Set<Promise<unknown>>;
  log: (operation: string, fields: LogFields) => void;
  metrics: Metrics;
}

/** Shutdown 时等在飞作业跑完(其 finally 释放 Page lease),最多 graceMs;超时则放弃(lease 靠 daemon
 * idle-expire 兜底)。返回时 inflight 要么空、要么已超 grace。 */
export async function drainInflight(inflight: Set<Promise<unknown>>, graceMs: number): Promise<void> {
  if (inflight.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((r) => { timer = setTimeout(r, graceMs); });
  try {
    await Promise.race([Promise.allSettled([...inflight]).then(() => undefined), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const REQUESTS_PREFIX = '/v1/requests/';
/** Shutdown 时等在飞 analyze 释放 Page lease 的最长宽限(Codex M9 Med)。 */
const SHUTDOWN_GRACE_MS = 5000;

function sendOutcome(res: ServerResponse, outcome: HandlerOutcome): void {
  if (outcome.errorCode) (res as ServerResponse & { __errorCode?: string }).__errorCode = outcome.errorCode;
  const payload = JSON.stringify(outcome.body);
  // 04 章:不回 CORS 头(no-CORS);nosniff。
  res.writeHead(outcome.status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
  res.end(payload);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
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

function clampWaitMs(raw: string | null, max: number): number {
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), max);
}

/** 路由分发:gate(全端点)→ 已注册端点;未匹配 404。 */
async function route(ctx: WrapperCtx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  // 门禁:所有端点(含 /health)统一过 X-byCLI + Origin + token。
  const gate = checkWrapperGates(req, { allowedOrigins: ctx.cfg.ALLOWED_ORIGINS, token: ctx.cfg.TOKEN });
  if (!gate.ok) {
    sendOutcome(res, {
      status: 403,
      body: { error: errorBody(gate.code ?? 'auth_failed', gate.message ?? 'forbidden') },
      errorCode: gate.code ?? 'auth_failed',
    });
    return;
  }

  if (method === 'GET' && pathname === '/health') {
    sendOutcome(res, handleHealth());
    return;
  }

  // GET /metrics —— loopback metrics scrape(09 · M8 复审遗留,gated 同其它端点)。返回 snapshot JSON
  // (counters/histograms,标签只非敏感 enum)。不入 finish-logger 计数(避免 scrape 自计/噪声)。
  if (method === 'GET' && pathname === '/metrics') {
    sendOutcome(res, { status: 200, body: ctx.metrics.snapshot() });
    return;
  }

  if (method === 'POST' && pathname === '/v1/adapters/init') {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req, ctx.cfg.BODY_LIMIT_BYTES);
    } catch {
      sendOutcome(res, {
        status: 400,
        body: { error: errorBody('validation_failed', 'request body too large or invalid JSON') },
        errorCode: 'validation_failed',
      });
      return;
    }
    sendOutcome(res, handleInit(ctx, body));
    return;
  }

  if (method === 'POST' && pathname === '/v1/adapters/verify') {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req, ctx.cfg.BODY_LIMIT_BYTES);
    } catch {
      sendOutcome(res, {
        status: 400,
        body: { error: errorBody('validation_failed', 'request body too large or invalid JSON') },
        errorCode: 'validation_failed',
      });
      return;
    }
    sendOutcome(res, await handleVerify(ctx, body));
    return;
  }

  if (method === 'POST' && pathname === '/v1/browser/analyze') {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req, ctx.cfg.BODY_LIMIT_BYTES);
    } catch {
      sendOutcome(res, {
        status: 400,
        body: { error: errorBody('validation_failed', 'request body too large or invalid JSON') },
        errorCode: 'validation_failed',
      });
      return;
    }
    sendOutcome(res, handleAnalyze(ctx, body));
    return;
  }

  if (method === 'GET' && pathname.startsWith(REQUESTS_PREFIX)) {
    const requestId = pathname.slice(REQUESTS_PREFIX.length);
    const waitMs = clampWaitMs(url.searchParams.get('waitMs'), ctx.cfg.REQUEST_WAIT_MS_MAX);
    sendOutcome(res, await handleRequestStatus(ctx, requestId, waitMs));
    return;
  }

  // 未注册路由(含 M9b/c 待接的 verify/analyze)→ 404。
  sendOutcome(res, { status: 404, body: { error: { code: 'request_not_found', message: 'not found' } } });
}

/**
 * 装配 wrapper app(工厂 + 可注入 deps 供测试)。返回 { server, ctx };调用方负责 server.listen。
 */
export function createWrapperApp(cfg: WrapperConfig, deps: WrapperDeps = {}): { server: ReturnType<typeof createServer>; ctx: WrapperCtx } {
  const logSink = deps.logSink ?? ((line: string) => process.stderr.write(line + '\n'));
  // production runner = defaultRunnerPort();browser-verify 子进程经 BYCLI_DAEMON_PORT 连回 daemon 拿 Page,
  // 故必须在首次 defaultRunnerPort() 前注入 daemon 端口(同 daemon.ts:49)。测试注入 deps.runner 绕开全局单例。
  if (!deps.runner) setDefaultRunnerDaemonPort(cfg.DAEMON_PORT);
  const ctx: WrapperCtx = {
    cfg,
    registry: new WrapperRegistry({
      terminalTtlMs: cfg.REQUEST_TERMINAL_STATUS_TTL_MS,
      pollAfterMs: cfg.REQUEST_POLL_AFTER_MS,
      now: deps.now,
    }),
    createDraft: deps.createDraft ?? createAdapterDraft,
    runner: deps.runner ?? defaultRunnerPort(),
    sessionKeyFor: deps.sessionKeyFor,
    analyzeRunner: deps.analyzeRunner ?? createAnalyzeRunner({ timeoutMs: cfg.ANALYZE_TIMEOUT_MS }),
    inflight: new Set<Promise<unknown>>(),
    log: (operation, fields) => {
      if (cfg.LOG_LEVEL === 'error' && fields.status === 'ok') return; // 静音成功日志(error level)
      logSink(JSON.stringify({ time: Date.now(), level: 'info', operation, ...fields }));
    },
    metrics: deps.metrics ?? createMetrics(),
  };

  const server = createServer((req, res) => {
    // 单点 finish-logger + metrics(09 Structured Logging/Metrics):operation + outcome + latency。只
    // path/method/status/errorCode/durationMs —— 永不含 header/token/body/seed。
    const started = Date.now();
    res.on('finish', () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      if (path === '/metrics') return; // 不给 /metrics scrape 自计/记日志
      // 把唯一动态段(GET /v1/requests/{id})collapse 成稳定模板,operation 基数有界。
      const operation = path.startsWith(REQUESTS_PREFIX)
        ? 'highlevel.requests'
        : `highlevel.${path.replace(/^\/+/, '').replace(/\//g, '.') || 'root'}`;
      const status = res.statusCode < 400 ? 'ok' : 'failed';
      const errorCode = (res as ServerResponse & { __errorCode?: string }).__errorCode;
      const durationMs = Date.now() - started;
      ctx.log(operation, { status, errorCode, durationMs });
      ctx.metrics.inc('highlevel_requests_total', { operation, status, errorCode });
      ctx.metrics.observe('highlevel_request_duration_ms', durationMs);
    });
    route(ctx, req, res).catch(() => {
      if (!res.headersSent) {
        sendOutcome(res, {
          status: 500,
          body: { error: errorBody('network_error', 'internal error') },
          errorCode: 'network_error',
        });
      }
    });
  });

  // 周期 sweep:回收已过 TTL 的终态记录(getRecord 只在访问时删,abandoned 终态否则常驻内存)。
  // 间隔绑 TTL(Codex M9 Low:固定 5min 对 1min TTL 会多滞留 ~4min)——取 min(5min, max(30s, TTL/2))。
  // unref → 不吊住进程;server 'close' 清掉(测试关 server 即停 timer,不泄漏)。
  const sweepMs = Math.min(300_000, Math.max(30_000, Math.floor(cfg.REQUEST_TERMINAL_STATUS_TTL_MS / 2)));
  const sweepTimer = setInterval(() => ctx.registry.sweepExpired(), sweepMs);
  sweepTimer.unref?.();
  server.on('close', () => clearInterval(sweepTimer));

  return { server, ctx };
}

/**
 * `bycli internal highlevel-http` 入口:load config → 装配 → bind 127.0.0.1。默认关闭(opt-in)。
 * 绝不打印 token(只打印 listening 行)。**在 server 存活期间不 resolve**(等 'close'),这样 main.ts
 * 的 `await runWrapperCli()` 会一直挂起、绝不 fall-through 到完整 CLI discovery。
 */
export async function runWrapperCli(): Promise<void> {
  const cfg = loadWrapperConfig();
  // analyze 的 daemon-backed Page 经 daemon-client(模块加载时读 process.env.BYCLI_DAEMON_PORT)连回 daemon;
  // 显式钉到 cfg.DAEMON_PORT,保证 Page 连的是 wrapper 配置的同一 daemon(Page 在首次 analyze 才懒加载)。
  process.env.BYCLI_DAEMON_PORT = String(cfg.DAEMON_PORT);
  const { server, ctx } = createWrapperApp(cfg);
  // 在 server 存活期间不 resolve(阻止 main.ts fall-through);仅在 SIGTERM/SIGINT 优雅关闭后 resolve。
  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      server.close(); // 停止接新连接
      // 先 drain 在飞 analyze(其 finally closeWindow 释放 daemon Page lease),最多 SHUTDOWN_GRACE_MS,
      // 再 resolve → main.ts process.exit;不再被硬切(Codex M9 Med)。超 grace 则放弃,靠 lease idle-expire。
      void drainInflight(ctx.inflight, SHUTDOWN_GRACE_MS).finally(() => resolve());
    };
    server.once('error', reject);
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    server.listen(cfg.PORT, cfg.HOST, () => {
      process.stderr.write(
        JSON.stringify({ time: Date.now(), level: 'info', operation: 'highlevel.listening', status: 'ok', port: cfg.PORT }) + '\n',
      );
    });
  });
}
