// M9 High-Level HTTP wrapper —— 端点 handler。返回纯 HandlerOutcome(status/body/errorCode),由
// wrapper-server 写入 res —— handler 不碰 res,便于单测直接断言。M9a 只含 init/status/health;
// verify(M9b)/analyze(M9c)随后加。统一 202 语义:init 同步跑完后立刻 finalize,仍返 202 + requestId,
// 失败经 GET /v1/requests/{id} 查(high-level.openapi 的 POST 只定义 202)。
import {
  accepted,
  errorBody,
  newRequestId,
  type ErrorCode,
} from './wrapper-envelope.js';
import type { WrapperRegistry } from './wrapper-registry.js';
import { type InitInput, type createAdapterDraft } from '../highlevel/init.js';
import { verifyAdapter, type VerifyInput } from '../highlevel/verify.js';
import type { RunnerPortWithLifecycle } from '../runner/runner-port.js';
import { defaultSessionKeyRegistry } from '../runner/session-keys.js';
import type { AnalyzeRunner } from './analyze-runner.js';

export interface HandlerOutcome {
  status: number;
  body: unknown;
  /** 供 finish-logger / metrics 打标(非 2xx 时设)。 */
  errorCode?: ErrorCode;
}

/** handler 依赖(可注入,测试用)。 */
export interface HandlerCtx {
  registry: WrapperRegistry;
  createDraft: typeof createAdapterDraft;
  /** verify 委托的 runner(production=defaultRunnerPort();测试注入 fake);用于 startVerify + getRunStatus。 */
  runner: RunnerPortWithLifecycle;
  /** sessionId → per-session HMAC key(M7a;缺 session 用进程 fallback)。可注入,默认进程级 registry。 */
  sessionKeyFor?: (sessionId?: string) => string;
  /** analyze 委托(production=daemon-backed Page;测试注入 fake)。 */
  analyzeRunner: AnalyzeRunner;
  /** 在飞后台作业集合(analyze 的 in-process Page 工作);shutdown 时 drain 它们好让 finally closeWindow
   * 释放 daemon Page lease,而不是被 process.exit 硬切(Codex M9 Med)。createWrapperApp 注入。 */
  inflight?: Set<Promise<unknown>>;
}

const TERMINAL = new Set(['succeeded', 'failed', 'timeout', 'cancelled']);
const RUN_TERMINAL = new Set(['succeeded', 'failed', 'timeout', 'cancelled']);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** GET /health —— 门禁已由 router 施加,此处只报存活。 */
export function handleHealth(): HandlerOutcome {
  return { status: 200, body: { status: 'ok', schemaVersion: 'high-level.v1' } };
}

/**
 * POST /v1/adapters/init —— 铸 requestId → createRequest → createAdapterDraft(同步)→ finalize →
 * 202 AcceptedResponse。name 缺失/非法 → finalize failed(validation_failed),仍 202(错误经 status 查)。
 */
export function handleInit(ctx: HandlerCtx, body: Record<string, unknown>): HandlerOutcome {
  const requestId = newRequestId();
  ctx.registry.createRequest({ requestId, type: 'init' });

  const name = body.name;
  if (typeof name !== 'string' || name.length === 0) {
    ctx.registry.finalizeRequest(requestId, {
      status: 'failed',
      error: errorBody('validation_failed', 'name is required (site/command)'),
    });
    return { status: 202, body: accepted(requestId) };
  }

  const strategyRaw = body.strategy;
  const strategy =
    strategyRaw === 'PUBLIC' || strategyRaw === 'COOKIE' || strategyRaw === 'UI' ? strategyRaw : undefined;
  const writePolicyRaw = body.writePolicy;
  const writePolicy =
    writePolicyRaw === 'write' || writePolicyRaw === 'dry-run' ? writePolicyRaw : undefined;

  const input: InitInput = {
    name,
    domain: typeof body.domain === 'string' ? body.domain : undefined,
    strategy,
    browser: typeof body.browser === 'boolean' ? body.browser : undefined,
    writePolicy,
    responsibleUseAcknowledgedAt:
      typeof body.responsibleUseAcknowledgedAt === 'number' ? body.responsibleUseAcknowledgedAt : undefined,
  };

  const result = ctx.createDraft(input);
  if (result.ok) {
    ctx.registry.finalizeRequest(requestId, {
      status: 'succeeded',
      result: { report: result.report, dryRun: result.dryRun },
    });
  } else {
    ctx.registry.finalizeRequest(requestId, {
      status: 'failed',
      error: errorBody(result.errorCode, result.reason),
    });
  }
  return { status: 202, body: accepted(requestId) };
}

/** analyze 后台 worker:跑 daemon-backed analyzeRunner → finalize report;映射 timeout/daemon-unavailable。 */
async function runAnalyzeBackground(
  ctx: HandlerCtx,
  requestId: string,
  input: { url: string; session: string; contextId: string; settleMs?: number },
): Promise<void> {
  try {
    const report = await ctx.analyzeRunner(input);
    ctx.registry.finalizeRequest(requestId, { status: 'succeeded', result: report });
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    const msg = e instanceof Error ? e.message : String(e);
    let errorCode: ErrorCode;
    let status: 'failed' | 'timeout';
    if (code === 'analyze_timeout') {
      errorCode = 'analyze_timeout';
      status = 'timeout';
    } else if (
      code === 'daemon_unavailable' ||
      // 只认**连接级**失败签名(Codex M9 Med:原宽匹配 connect/network error/daemon 会把普通运行时/
      // 站点异常误报 503)。daemon-client 连不上时 undici 抛 "fetch failed"、重试耗尽抛 "max retries
      // exhausted"、底层 ECONNREFUSED/ECONNRESET —— 这些才是 daemon 不可达,其余归 adapter_runtime_error。
      /ECONNREFUSED|ECONNRESET|fetch failed|max retries exhausted/i.test(msg)
    ) {
      errorCode = 'daemon_unavailable';
      status = 'failed';
    } else {
      errorCode = 'adapter_runtime_error';
      status = 'failed';
    }
    ctx.registry.finalizeRequest(requestId, { status, error: errorBody(errorCode, msg) });
  }
}

/**
 * POST /v1/browser/analyze —— 校验 url/session/contextId → 铸 requestId → createRequest → **立即 202** →
 * 后台 `runAnalyzeBackground`(构造 daemon-backed Page 跑 analyze,M6b 模式)。analyze 无 seed;结果是
 * 站点分类 AnalyzeReport。daemon 不可达 → daemon_unavailable(503),超时 → analyze_timeout(504,status timeout)。
 */
export function handleAnalyze(ctx: HandlerCtx, body: Record<string, unknown>): HandlerOutcome {
  const requestId = newRequestId();
  ctx.registry.createRequest({ requestId, type: 'analyze' });

  const url = body.url;
  const session = body.session;
  const contextId = body.contextId;
  if (
    typeof url !== 'string' || url.length === 0 ||
    typeof session !== 'string' || session.length === 0 ||
    typeof contextId !== 'string' || contextId.length === 0
  ) {
    ctx.registry.finalizeRequest(requestId, {
      status: 'failed',
      error: errorBody('validation_failed', 'url, session and contextId are required'),
    });
    return { status: 202, body: accepted(requestId) };
  }
  const settleMs = typeof body.settleMs === 'number' ? body.settleMs : undefined;
  // fire-and-forget;客户端轮询 GET /v1/requests/{id}(analyze 类无 runner,registry 是唯一权威)。
  // 登记进 inflight 供 shutdown drain(release Page lease);runAnalyzeBackground 永不 reject。
  const job = runAnalyzeBackground(ctx, requestId, { url, session, contextId, settleMs });
  if (ctx.inflight) {
    ctx.inflight.add(job);
    void job.finally(() => ctx.inflight!.delete(job));
  }
  return { status: 202, body: accepted(requestId) };
}

/**
 * POST /v1/adapters/verify —— 铸 requestId(== runner canonical id)→ createRequest → 委托
 * verifyAdapter(name 校验 → 派生 evidence HMAC → runner.startVerify)。runner 接受即留 running(202,
 * 客户端轮询 GET status 拿 runner live 进度);startVerify 同步拒(validation_failed/queue_full/
 * runner_protocol_error)→ finalize failed,仍 202。**raw executionSeedArgs 只进 runner input.json,
 * 绝不进 registry/202/log**(verifyAdapter 内部经 input.json 0600 落盘,wrapper 这层不碰 raw)。
 */
export async function handleVerify(ctx: HandlerCtx, body: Record<string, unknown>): Promise<HandlerOutcome> {
  const requestId = newRequestId();
  ctx.registry.createRequest({ requestId, type: 'verify', runnerId: requestId });

  const name = body.name;
  if (typeof name !== 'string' || name.length === 0) {
    ctx.registry.finalizeRequest(requestId, {
      status: 'failed',
      error: errorBody('validation_failed', 'name is required (site/command)'),
    });
    return { status: 202, body: accepted(requestId) };
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const keyFor = ctx.sessionKeyFor ?? ((sid?: string) => defaultSessionKeyRegistry().keyFor(sid));
  const sessionHmacKey = keyFor(sessionId);

  const fixtureRaw = body.fixture;
  const fixture = fixtureRaw === 'ignore' || fixtureRaw === 'match' || fixtureRaw === 'update' ? fixtureRaw : undefined;
  const traceRaw = body.trace;
  const trace = traceRaw === 'off' || traceRaw === 'retain-on-failure' || traceRaw === 'always' ? traceRaw : undefined;
  const executionSeedArgs =
    body.executionSeedArgs && typeof body.executionSeedArgs === 'object' && !Array.isArray(body.executionSeedArgs)
      ? (body.executionSeedArgs as Record<string, unknown>)
      : undefined;

  const adapterPathRaw = body.adapterPath;
  const expectedSourceSha256Raw = body.expectedSourceSha256;
  const invalidAdapterPath = adapterPathRaw !== undefined
    && (typeof adapterPathRaw !== 'string' || adapterPathRaw.trim().length === 0);
  const invalidExpectedSourceHash = expectedSourceSha256Raw !== undefined
    && (typeof expectedSourceSha256Raw !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSourceSha256Raw));
  if (invalidAdapterPath || invalidExpectedSourceHash) {
    ctx.registry.finalizeRequest(requestId, {
      status: 'failed',
      error: errorBody('validation_failed', 'adapterPath or expectedSourceSha256 is invalid'),
    });
    return { status: 202, body: accepted(requestId) };
  }

  const adapterPath = typeof adapterPathRaw === 'string' ? adapterPathRaw : undefined;
  const expectedSourceSha256 = typeof expectedSourceSha256Raw === 'string'
    ? expectedSourceSha256Raw
    : undefined;

  const input: VerifyInput = {
    name,
    requestId,
    sessionId,
    executionSeedArgs,
    fixture,
    trace,
    adapterPath,
    expectedSourceSha256,
  };
  const result = await verifyAdapter(input, sessionHmacKey, ctx.runner);
  if (!result.ok) {
    ctx.registry.finalizeRequest(requestId, { status: 'failed', error: errorBody(result.errorCode, result.reason) });
    return { status: 202, body: accepted(requestId) };
  }
  // ok:true → 后台收尾:runner settle 时 finalize registry,**与客户端是否轮询无关**(否则 abandoned
  // verify 永远卡 running〔expiresAt=null〕→ 永不被 sweep → 泄漏)。finalizeRequest 幂等,与轮询 refresh()
  // 双触发安全;whenSettled resolve/reject 都收尾(用 getRunStatus 取终态;null/non-terminal 则 idle 兜底)。
  const settled = ctx.runner.whenSettled(requestId);
  if (settled) void settled.then(() => finalizeVerifyFromRunner(ctx, requestId), () => finalizeVerifyFromRunner(ctx, requestId));
  return { status: 202, body: accepted(requestId) };
}

/** 从 runner 当前态收尾一个 verify 记录(终态 → finalize summary-only;非终态 → updateRequest)。幂等。 */
function finalizeVerifyFromRunner(ctx: HandlerCtx, requestId: string): void {
  const live = ctx.runner.getRunStatus(requestId);
  if (!live) return;
  if (RUN_TERMINAL.has(live.status)) {
    // 把 runner 终态错误(VerifySummary.error,如 verify_timeout/adapter_runtime_error)投影到顶层
    // RequestStatus.error,使 verify 失败与 init/analyze 同一读取出口(Codex M9 Med);summary 仍保留完整体。
    const e = live.summary?.error;
    ctx.registry.finalizeRequest(requestId, {
      status: live.status as 'succeeded' | 'failed' | 'timeout' | 'cancelled',
      result: live.summary ?? undefined,
      error: e ? errorBody(e.code as ErrorCode, e.message, e.hint) : undefined,
    });
  } else {
    ctx.registry.updateRequest(requestId, { status: live.status });
  }
}

/**
 * 把 verify 记录从 runner 拉取 live status 投影进 registry(终态 finalize summary,summary-only 已脱敏)。
 * init/analyze 类不动(它们的终态由各自 handler finalize)。返回最新投影后的 RequestStatus。
 */
function refresh(ctx: HandlerCtx, requestId: string): ReturnType<WrapperRegistry['getRequest']> {
  const r = ctx.registry.getRecord(requestId);
  if (r && r.type === 'verify' && !TERMINAL.has(r.status)) {
    const live = ctx.runner.getRunStatus(r.runnerId);
    if (live) {
      if (RUN_TERMINAL.has(live.status)) {
        ctx.registry.finalizeRequest(requestId, {
          status: live.status as 'succeeded' | 'failed' | 'timeout' | 'cancelled',
          result: live.summary ?? undefined,
        });
      } else {
        ctx.registry.updateRequest(requestId, { status: live.status });
      }
    }
  }
  return ctx.registry.getRequest(requestId);
}

/**
 * GET /v1/requests/{requestId}(+waitMs long-poll)—— 未知/TTL 过期 → 404 request_not_found;否则
 * 200 RequestStatus。verify 类经 runner getRunStatus 代理 live 进度并在终态 finalize summary。
 */
export async function handleRequestStatus(
  ctx: HandlerCtx,
  requestId: string,
  waitMs: number,
): Promise<HandlerOutcome> {
  const deadline = Date.now() + waitMs;
  let rec = refresh(ctx, requestId);
  while (rec && !TERMINAL.has(rec.status) && Date.now() < deadline) {
    await sleep(Math.min(200, Math.max(0, deadline - Date.now())));
    rec = refresh(ctx, requestId);
  }
  if (!rec) {
    return {
      status: 404,
      body: { error: errorBody('request_not_found', 'no such request (unknown or expired)') },
      errorCode: 'request_not_found',
    };
  }
  return { status: 200, body: rec };
}
