/**
 * bycli micro-daemon — HTTP + WebSocket bridge between CLI and Chrome Extension.
 *
 * Architecture:
 *   CLI → HTTP POST /command → daemon → WebSocket → Extension
 *   Extension → WebSocket result → daemon → HTTP response → CLI
 *
 * Security (defense-in-depth against browser-based CSRF):
 *   1. Origin check — reject HTTP/WS from non chrome-extension:// origins
 *   2. Custom header — require X-byCLI header (browsers can't send it
 *      without CORS preflight, which we deny)
 *   3. No CORS headers on command endpoints — only /ping is readable from the
 *      Browser Bridge extension origin so the extension can probe daemon reachability
 *   4. Body size limit — 1 MB max to prevent OOM
 *   5. WebSocket verifyClient — reject upgrade before connection is established
 *
 * Lifecycle:
 *   - Auto-spawned by bycli on first browser command
 *   - Persistent — stays alive until explicit shutdown, SIGTERM, or uninstall
 *   - Listens on localhost:19825
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { DEFAULT_DAEMON_PORT } from './constants.js';
import { EXIT_CODES } from './errors.js';
import { log } from './logger.js';
import { PKG_VERSION } from './version.js';
import { DEFAULT_CONTEXT_ID } from './browser/profile.js';
import { createAdapterDraft, saveAdapterSource, recoverInitTransactions, type InitInput, type SaveAdapterInput } from './recorder/highlevel/init.js';
import { verifyAdapter, type VerifyInput } from './recorder/highlevel/verify.js';
import { defaultRunnerPort, setDefaultRunnerDaemonPort, setDefaultRunnerObservability, setDefaultRunnerTempGuard } from './recorder/runner/runner-port.js';
import { createMetrics } from '@sovovs/bycli-recorder-core';
import { createRecorderLogger, type LogLevel } from './recorder/observability/logger.js';
import { reapOrphanedVerifyRuns } from './recorder/runner/reap.js';
import { resolveTempPolicy, resolveRunnerConfig, resolveTempCapacity } from './recorder/runner/config.js';
import { defaultSessionKeyRegistry } from './recorder/runner/session-keys.js';
import { recordExtensionVersion } from './update-check.js';
import {
  buildCommandDispatchFailure,
  buildExtensionDisconnectFailure,
  getResponseCorsHeaders,
} from './daemon-utils.js';

const PORT = parseInt(process.env.BYCLI_DAEMON_PORT ?? String(DEFAULT_DAEMON_PORT), 10);

// The verify runner (M6b) spawns child processes that connect back to THIS daemon for a
// browser Page. Hand them our port (→ BYCLI_DAEMON_PORT in the child env) so the child's
// Page reaches us, not a freshly-spawned daemon. Must run before the first /v1/verify
// builds the default runner singleton.
setDefaultRunnerDaemonPort(PORT);

// ─── Observability (#1b · 09) ────────────────────────────────────────
// daemon/runner-side structured logs + metrics (M8 only did dashboard-be). The metrics instance is
// a process singleton, shared by reference into the runner port (#1c) so GET /metrics shows runner
// counters too. LOG_LEVEL is read once at startup — the daemon has no ConfigPort, so no hot reload
// here (that's a larger, separate milestone); a malformed value falls back to 'info'.
const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
const envLogLevel = process.env.LOG_LEVEL ?? '';
const metrics = createMetrics();
const logger = createRecorderLogger((LOG_LEVELS as readonly string[]).includes(envLogLevel) ? (envLogLevel as LogLevel) : 'info');
// Share these singletons with the verify runner (#1c) BEFORE the first defaultRunnerPort() use, so
// runner counters surface on GET /metrics and runner logs share the daemon's level.
setDefaultRunnerObservability(metrics, logger);

// ─── State ───────────────────────────────────────────────────────────

type ExtensionProfileConnection = {
  contextId: string;
  ws: WebSocket;
  extensionVersion: string | null;
  extensionCompatRange: string | null;
  lastSeenAt: number;
};

const extensionProfiles = new Map<string, ExtensionProfileConnection>();
const pending = new Map<string, {
  contextId: string;
  action: string;
  dispatched: boolean;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
let commandResultUnknownCount = 0;
// Extension log ring buffer
interface LogEntry { level: string; msg: string; ts: number; }
const LOG_BUFFER_SIZE = 200;
const logBuffer: LogEntry[] = [];

class DaemonCommandFailure extends Error {
  constructor(
    message: string,
    readonly errorCode?: string,
    readonly errorHint?: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'DaemonCommandFailure';
  }
}

function pushLog(entry: LogEntry): void {
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}

function activeProfiles(): ExtensionProfileConnection[] {
  return [...extensionProfiles.values()].filter((entry) => entry.ws.readyState === WebSocket.OPEN);
}

function resolveExtensionConnection(contextId?: string): {
  connection?: ExtensionProfileConnection;
  errorCode?: 'extension_not_connected' | 'profile_required' | 'profile_disconnected';
  error?: string;
  errorHint?: string;
} {
  const requestedContextId = typeof contextId === 'string' && contextId.trim() ? contextId.trim() : undefined;
  if (requestedContextId) {
    const connection = extensionProfiles.get(requestedContextId);
    if (connection?.ws.readyState === WebSocket.OPEN) return { connection };
    return {
      errorCode: 'profile_disconnected',
      error: `Browser profile "${requestedContextId}" is not connected.`,
      errorHint: 'Open that Chrome profile and make sure the byCLI extension is enabled, or choose another profile with bycli profile use <name>.',
    };
  }

  const connected = activeProfiles();
  if (connected.length === 1) return { connection: connected[0] };
  if (connected.length > 1) {
    return {
      errorCode: 'profile_required',
      error: 'Multiple Browser Bridge profiles are connected; choose one with --profile.',
      errorHint: 'Run bycli profile list, then use bycli --profile <name> ... or bycli profile use <name>.',
    };
  }
  return {
    errorCode: 'extension_not_connected',
    error: 'Extension not connected. Please install the bycli Browser Bridge extension.',
  };
}

function registerExtensionConnection(ws: WebSocket, rawContextId: unknown): ExtensionProfileConnection {
  const contextId = typeof rawContextId === 'string' && rawContextId.trim()
    ? rawContextId.trim()
    : DEFAULT_CONTEXT_ID;
  const previous = extensionProfiles.get(contextId);
  if (previous && previous.ws !== ws) {
    previous.ws.close();
  }
  const existing = [...extensionProfiles.entries()].find(([, entry]) => entry.ws === ws);
  if (existing && existing[0] !== contextId) extensionProfiles.delete(existing[0]);

  const current = extensionProfiles.get(contextId);
  const connection: ExtensionProfileConnection = {
    contextId,
    ws,
    extensionVersion: current?.ws === ws ? current.extensionVersion : null,
    extensionCompatRange: current?.ws === ws ? current.extensionCompatRange : null,
    lastSeenAt: Date.now(),
  };
  extensionProfiles.set(contextId, connection);
  return connection;
}

function unregisterExtensionConnection(ws: WebSocket): void {
  for (const [contextId, connection] of extensionProfiles.entries()) {
    if (connection.ws !== ws) continue;
    extensionProfiles.delete(contextId);
    for (const [id, p] of pending) {
      if (p.contextId !== contextId) continue;
      clearTimeout(p.timer);
      const failure = buildExtensionDisconnectFailure({
        contextId,
        action: p.action,
        dispatched: p.dispatched,
      });
      if (failure.countAsCommandResultUnknown) {
        commandResultUnknownCount++;
        metrics.inc('daemon_command_result_unknown_total'); // #1b: structured metric alongside the /status field
        log.warn(`[daemon] Command result unknown after extension disconnect (id=${id}, action=${p.action}, context=${contextId})`);
      }
      p.reject(new DaemonCommandFailure(failure.message, failure.errorCode, failure.errorHint, failure.status));
      pending.delete(id);
    }
  }
}

// ─── HTTP Server ─────────────────────────────────────────────────────

const MAX_BODY = 1024 * 1024; // 1 MB — commands are tiny; this prevents OOM

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { aborted = true; req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks).toString('utf-8')); });
    req.on('error', (err) => { if (!aborted) reject(err); });
  });
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  data: unknown,
  extraHeaders?: Record<string, string>,
): void {
  // Stash any errorCode for the request-completion metrics choke point (#1b), so handlers don't
  // each have to wire it through. Only the bounded ErrorCode enum reaches a label/log field.
  const ec = (data as { errorCode?: unknown } | null)?.errorCode;
  if (typeof ec === 'string') (res as ServerResponse & { __errorCode?: string }).__errorCode = ec;
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(data));
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // ─── Security: Origin & custom-header check ──────────────────────
  // Block browser-based CSRF: browsers always send an Origin header on
  // cross-origin requests.  Node.js CLI fetch does NOT send Origin, so
  // legitimate CLI requests pass through.  Chrome Extension connects via
  // WebSocket (which bypasses this HTTP handler entirely).
  const origin = req.headers['origin'] as string | undefined;
  if (origin && !origin.startsWith('chrome-extension://')) {
    jsonResponse(res, 403, { ok: false, error: 'Forbidden: cross-origin request blocked' });
    return;
  }

  // CORS: do NOT send Access-Control-Allow-Origin for normal requests.
  // Only handle preflight so browsers get a definitive "no" answer.
  if (req.method === 'OPTIONS') {
    // No ACAO header → browser will block the actual request.
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? '/';
  const pathname = url.split('?')[0];

  // Request-completion metrics choke point (#1b · 09): one place records type/status/errorCode +
  // latency, no per-handler scatter. Only the high-level surface (/v1/*) and the /command bridge are
  // counted; the dynamic /v1/requests/{id} segment collapses to a bounded route template so the
  // `operation` label can't grow unboundedly. /v1/* operations also get a structured log line
  // (low volume, the recording ops); /command is counted but not logged (per-command WS bridge is
  // high volume). Never logs headers/token/body — only operation/status/errorCode/durationMs.
  const reqStarted = Date.now();
  res.on('finish', () => {
    let operation: string | null = null;
    if (pathname.startsWith('/v1/requests/')) operation = 'v1.requests';
    else if (pathname.startsWith('/v1/')) operation = `v1${pathname.slice(3).replace(/\//g, '.')}`; // /v1/init → v1.init
    else if (pathname === '/command') operation = 'command';
    if (!operation) return;
    const status = res.statusCode < 400 ? 'ok' : 'failed';
    const errorCode = (res as ServerResponse & { __errorCode?: string }).__errorCode;
    const durationMs = Date.now() - reqStarted;
    metrics.inc('daemon_requests_total', { operation, status, errorCode });
    if (operation === 'v1.verify') metrics.observe('daemon_verify_duration_ms', durationMs);
    if (operation.startsWith('v1')) logger.info(`daemon.${operation}`, { status, errorCode, durationMs });
  });

  // Health-check endpoint — no X-byCLI header required.
  // Used by the extension to silently probe daemon reachability before
  // attempting a WebSocket connection (avoids uncatchable ERR_CONNECTION_REFUSED).
  // Security note: this endpoint is reachable by any client that passes the
  // origin check above (chrome-extension:// or no Origin header, e.g. curl).
  // Timing side-channels can reveal daemon presence to local processes, which
  // is an accepted risk given the daemon is loopback-only and short-lived.
  if (req.method === 'GET' && pathname === '/ping') {
    jsonResponse(res, 200, { ok: true }, getResponseCorsHeaders(pathname, origin));
    return;
  }

  // Require custom header on all other HTTP requests.  Browsers cannot attach
  // custom headers in "simple" requests, and our preflight returns no
  // Access-Control-Allow-Headers, so scripted fetch() from web pages is
  // blocked even if Origin check is somehow bypassed.
  if (!req.headers['x-bycli']) {
    jsonResponse(res, 403, { ok: false, error: 'Forbidden: missing X-byCLI header' });
    return;
  }

  // High-level init (M5b · A'): daemon hosts the FS-writing init capability; the
  // logic lives in the main-repo init module (createAdapterDraft). dashboard-be
  // forwards here rather than writing main-repo adapter paths itself. Synchronous
  // (init is a short FS op, not a long-running runner); requestId/async is deferred.
  if (req.method === 'POST' && pathname === '/v1/init') {
    try {
      const body = JSON.parse(await readBody(req)) as Partial<InitInput>;
      if (typeof body.name !== 'string' || !body.name) {
        jsonResponse(res, 400, { ok: false, errorCode: 'validation_failed', error: 'name required' });
        return;
      }
      const result = createAdapterDraft(body as InitInput);
      if (!result.ok) {
        // init failures are all client-fixable 400s (validation_failed / responsible_use_required).
        jsonResponse(res, 400, { ok: false, errorCode: result.errorCode, error: result.reason });
        return;
      }
      jsonResponse(res, 200, { ok: true, data: { report: result.report, dryRun: result.dryRun, generatedSource: result.generatedSource } });
    } catch (err) {
      jsonResponse(res, 400, { ok: false, errorCode: 'validation_failed', error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // N4: save a reviewed, full LLM-generated adapter source to clis/ (verify-then-save flow).
  if (req.method === 'POST' && pathname === '/v1/save-adapter') {
    try {
      const body = JSON.parse(await readBody(req)) as Partial<SaveAdapterInput>;
      if (typeof body.name !== 'string' || !body.name || typeof body.source !== 'string' || !body.source) {
        jsonResponse(res, 400, { ok: false, errorCode: 'validation_failed', error: 'name and source required' });
        return;
      }
      const result = saveAdapterSource(body as SaveAdapterInput);
      if (!result.ok) { jsonResponse(res, 400, { ok: false, errorCode: result.errorCode, error: result.reason }); return; }
      jsonResponse(res, 200, { ok: true, data: { adapterPath: result.adapterPath, reportPath: result.reportPath } });
    } catch (err) {
      jsonResponse(res, 400, { ok: false, errorCode: 'validation_failed', error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // High-level verify (A'): interface + delegation seam. The adapter JS runs in the
  // M6 child-process runner (08) — verifyAdapter delegates to the real spawn-based
  // RunnerPort (defaultRunnerPort), so runner_protocol_error now signals an actual
  // runner fault, not "not implemented". The evidence HMAC is keyed by a per-session salt
  // held only in daemon memory (M7a · 04:111): be forwards the non-secret sessionId, the
  // daemon mints + holds the salt, and it never crosses the wire.
  if (req.method === 'POST' && pathname === '/v1/verify') {
    try {
      const body = JSON.parse(await readBody(req)) as Partial<VerifyInput>;
      if (typeof body.name !== 'string' || !body.name) {
        jsonResponse(res, 400, { ok: false, errorCode: 'validation_failed', error: 'name required' });
        return;
      }
      const sessionHmacKey = defaultSessionKeyRegistry().keyFor(body.sessionId);
      const result = await verifyAdapter(body as VerifyInput, sessionHmacKey);
      if (!result.ok) {
        const status = result.errorCode === 'validation_failed' ? 400
          : result.errorCode === 'queue_full' ? 429 // 03: queue/concurrency exceeded
          : 500;
        // requestId/sessionId correlation the choke point (res-only) can't see (09:89).
        logger.warn('daemon.verify', { sessionId: body.sessionId, status: 'failed', errorCode: result.errorCode });
        jsonResponse(res, status, { ok: false, errorCode: result.errorCode, error: result.reason });
        return;
      }
      logger.info('daemon.verify', { requestId: result.requestId, sessionId: body.sessionId, stage: 'accepted' });
      jsonResponse(res, 200, { ok: true, data: { requestId: result.requestId } });
    } catch (err) {
      jsonResponse(res, 400, { ok: false, errorCode: 'validation_failed', error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // High-level request status (M6 · ADR-0007): be polls verify status here. The runner
  // registry is keyed by the canonical requestId (be ↔ daemon ↔ runner share one id);
  // returns summary-only VerifySummary (raw seed/stdout/stderr/trace path never included).
  if (req.method === 'GET' && pathname.startsWith('/v1/requests/')) {
    const requestId = decodeURIComponent(pathname.slice('/v1/requests/'.length));
    if (!requestId) {
      jsonResponse(res, 400, { ok: false, errorCode: 'validation_failed', error: 'requestId required' });
      return;
    }
    const runStatus = defaultRunnerPort().getRunStatus(requestId);
    if (!runStatus) {
      jsonResponse(res, 404, { ok: false, errorCode: 'request_not_found', error: 'unknown requestId' });
      return;
    }
    // RunStatus (queued|running|succeeded|failed|timeout|cancelled) maps 1:1 to request status;
    // summary is null while queued/running, a VerifySummary once terminal (M6c adds queued).
    logger.debug('daemon.requests', { requestId, status: runStatus.status });
    jsonResponse(res, 200, { ok: true, data: { requestId, status: runStatus.status, result: runStatus.summary } });
    return;
  }

  if (req.method === 'GET' && pathname === '/status') {
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    const params = new URL(url, `http://localhost:${PORT}`).searchParams;
    const requestedContextId = params.get('contextId')?.trim() || undefined;
    const route = resolveExtensionConnection(requestedContextId);
    const profiles = activeProfiles().map((profile) => ({
      contextId: profile.contextId,
      extensionConnected: true,
      extensionVersion: profile.extensionVersion ?? undefined,
      extensionCompatRange: profile.extensionCompatRange ?? undefined,
      pending: [...pending.values()].filter((entry) => entry.contextId === profile.contextId).length,
      lastSeenAt: profile.lastSeenAt,
    }));
    jsonResponse(res, 200, {
      ok: true,
      pid: process.pid,
      uptime,
      daemonVersion: PKG_VERSION,
      extensionConnected: !!route.connection,
      extensionVersion: route.connection?.extensionVersion ?? undefined,
      extensionCompatRange: route.connection?.extensionCompatRange ?? undefined,
      contextId: route.connection?.contextId ?? requestedContextId,
      profileRequired: route.errorCode === 'profile_required',
      profileDisconnected: route.errorCode === 'profile_disconnected',
      profiles,
      pending: pending.size,
      commandResultUnknown: commandResultUnknownCount,
      memoryMB: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
      port: PORT,
    });
    return;
  }

  // Metrics scrape (#1b · 09): loopback diagnostic, same X-byCLI posture as /status (no token).
  // The counter/histogram registry is pure data in recorder-core; this endpoint (http-bound) stays
  // in the daemon transport layer. Values are non-sensitive enums/counts only (09).
  if (req.method === 'GET' && pathname === '/metrics') {
    jsonResponse(res, 200, { ok: true, ...metrics.snapshot() });
    return;
  }

  if (req.method === 'GET' && pathname === '/logs') {
    const params = new URL(url, `http://localhost:${PORT}`).searchParams;
    const level = params.get('level');
    const filtered = level
      ? logBuffer.filter(e => e.level === level)
      : logBuffer;
    jsonResponse(res, 200, { ok: true, logs: filtered });
    return;
  }

  if (req.method === 'DELETE' && pathname === '/logs') {
    logBuffer.length = 0;
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/shutdown') {
    jsonResponse(res, 200, { ok: true, message: 'Shutting down' });
    setTimeout(() => shutdown(), 100);
    return;
  }

  if (req.method === 'POST' && url === '/command') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.id) {
        jsonResponse(res, 400, { ok: false, error: 'Missing command id' });
        return;
      }

      const route = resolveExtensionConnection(typeof body.contextId === 'string' ? body.contextId : undefined);
      if (!route.connection) {
        jsonResponse(res, route.errorCode === 'profile_required' ? 409 : 503, {
          id: body.id,
          ok: false,
          errorCode: route.errorCode,
          error: route.error,
          ...(route.errorHint ? { errorHint: route.errorHint } : {}),
        });
        return;
      }

      const timeoutMs = typeof body.timeout === 'number' && body.timeout > 0
        ? body.timeout * 1000
        : 120000;
      if (pending.has(body.id)) {
        jsonResponse(res, 409, {
          id: body.id,
          ok: false,
          error: 'Duplicate command id already pending; retry',
        });
        return;
      }
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(body.id);
          reject(new Error(`Command timeout (${timeoutMs / 1000}s)`));
        }, timeoutMs);
        const entry = {
          contextId: route.connection!.contextId,
          action: typeof body.action === 'string' ? body.action : 'unknown',
          dispatched: false,
          resolve,
          reject,
          timer,
        };
        pending.set(body.id, entry);
        const failBeforeDispatch = (err: unknown) => {
          if (pending.get(body.id) !== entry) return;
          const failure = buildCommandDispatchFailure(entry.contextId);
          clearTimeout(timer);
          pending.delete(body.id);
          reject(new DaemonCommandFailure(failure.message, failure.errorCode, failure.errorHint, failure.status));
          log.warn(`[daemon] Failed to dispatch command ${body.id}: ${err instanceof Error ? err.message : String(err)}`);
        };
        try {
          route.connection!.ws.send(JSON.stringify(body), (err?: Error) => {
            if (err && !entry.dispatched) failBeforeDispatch(err);
          });
          // Once ws accepts the frame, the command may execute even if the
          // result is later lost; do not downgrade later disconnects to a
          // pre-dispatch failure just because no result/ack has arrived yet.
          entry.dispatched = true;
        } catch (err) {
          failBeforeDispatch(err);
        }
      });

      jsonResponse(res, 200, result);
    } catch (err) {
      const commandFailure = err instanceof DaemonCommandFailure ? err : null;
      jsonResponse(res, commandFailure?.status ?? (err instanceof Error && err.message.includes('timeout') ? 408 : 400), {
        ok: false,
        error: err instanceof Error ? err.message : 'Invalid request',
        ...(commandFailure?.errorCode ? { errorCode: commandFailure.errorCode } : {}),
        ...(commandFailure?.errorHint ? { errorHint: commandFailure.errorHint } : {}),
      });
    }
    return;
  }

  jsonResponse(res, 404, { error: 'Not found' });
}

// ─── WebSocket for Extension ─────────────────────────────────────────

const httpServer = createServer((req, res) => { handleRequest(req, res).catch(() => { res.writeHead(500); res.end(); }); });
const wss = new WebSocketServer({
  server: httpServer,
  path: '/ext',
  verifyClient: ({ req }: { req: IncomingMessage }) => {
    // Block browser-originated WebSocket connections.  Browsers don't
    // enforce CORS on WebSocket, so a malicious webpage could connect to
    // ws://localhost:19825/ext and impersonate the Extension.  Real Chrome
    // Extensions send origin chrome-extension://<id>.
    const origin = req.headers['origin'] as string | undefined;
    return !origin || origin.startsWith('chrome-extension://');
  },
});

wss.on('connection', (ws: WebSocket) => {
  log.info('[daemon] Extension connected');

  // ── Heartbeat: ping every 15s, close if 2 pongs missed ──
  let missedPongs = 0;
  const heartbeatInterval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(heartbeatInterval);
      return;
    }
    if (missedPongs >= 2) {
      log.warn('[daemon] Extension heartbeat lost, closing connection');
      clearInterval(heartbeatInterval);
      ws.terminate();
      return;
    }
    missedPongs++;
    ws.ping();
  }, 15000);

  ws.on('pong', () => {
    missedPongs = 0;
  });

  ws.on('message', (data: RawData) => {
    try {
      const msg = JSON.parse(data.toString());

      // Handle hello message from extension (version handshake)
      if (msg.type === 'hello') {
        const connection = registerExtensionConnection(ws, msg.contextId);
        connection.extensionVersion = typeof msg.version === 'string' ? msg.version : null;
        connection.extensionCompatRange = typeof msg.compatRange === 'string' ? msg.compatRange : null;
        connection.lastSeenAt = Date.now();
        if (connection.extensionVersion) recordExtensionVersion(connection.extensionVersion);
        log.info(`[daemon] Extension profile connected: ${connection.contextId}`);
        return;
      }

      // Handle log messages from extension
      if (msg.type === 'log') {
        if (msg.level === 'error') log.error(`[ext] ${msg.msg}`);
        else if (msg.level === 'warn') log.warn(`[ext] ${msg.msg}`);
        else log.info(`[ext] ${msg.msg}`);
        pushLog({ level: msg.level, msg: msg.msg, ts: msg.ts ?? Date.now() });
        return;
      }

      // Handle command results
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.resolve(msg);
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on('close', () => {
    log.info('[daemon] Extension disconnected');
    clearInterval(heartbeatInterval);
    unregisterExtensionConnection(ws);
  });

  ws.on('error', () => {
    clearInterval(heartbeatInterval);
    unregisterExtensionConnection(ws);
  });
});

// ─── Start ───────────────────────────────────────────────────────────

httpServer.listen(PORT, '127.0.0.1', () => {
  log.info(`[daemon] Listening on http://127.0.0.1:${PORT}`);
  // Temp-store reap policy (M7b · 09:27-29). Resolved once at startup; out-of-range env → throws,
  // but we keep the daemon alive by falling back to the (validated-elsewhere) defaults on error.
  let tempPolicy;
  try {
    tempPolicy = resolveTempPolicy();
  } catch (err) {
    log.warn(`[daemon] temp policy config invalid, using defaults: ${err instanceof Error ? err.message : String(err)}`);
    tempPolicy = { tempTtlMs: 3_600_000, startupReapMaxAgeMs: 86_400_000, orphanKillGraceMs: 1_500 };
  }
  // Age-reap safety floor (08 / M7b): a verify cannot legitimately outlive timeoutMs + killGraceMs,
  // so the age threshold must never drop below it — otherwise a short RECORDER_TEMP_TTL_MS (min 60s)
  // would let the sweep kill a still-running verify (timeoutMs reaches 600s). Fall back to the
  // absolute config ceiling (max timeoutMs + max killGraceMs) if runner config is unreadable.
  let minLeakAgeMs = 600_000 + 30_000;
  try {
    const rc = resolveRunnerConfig();
    minLeakAgeMs = rc.timeoutMs + rc.killGraceMs;
  } catch { /* keep the absolute ceiling (safest, highest floor) */ }
  // #1d temp-store capacity guard: the runner refuses a new verify (temp_store_full) past the high
  // watermark rather than risk filling the disk. Resolved at startup (temp root is restart-only,
  // 09:182); bad env falls back to defaults (consistent with temp policy above). Registered BEFORE the
  // first defaultRunnerPort() use (no request is served until after this listen callback returns). The
  // on-pressure sweep reuses the same age-bounded reap as the periodic sweep (never kills a live verify).
  let tempCapacity;
  try { tempCapacity = resolveTempCapacity(); }
  catch (err) {
    log.warn(`[daemon] temp capacity config invalid, using defaults: ${err instanceof Error ? err.message : String(err)}`);
    tempCapacity = resolveTempCapacity({}); // empty env → validated defaults
  }
  setDefaultRunnerTempGuard(tempCapacity, () => {
    reapOrphanedVerifyRuns({ log: (m) => log.info(m), maxAgeMs: tempPolicy.tempTtlMs, minLeakAgeMs, graceMs: tempPolicy.orphanKillGraceMs });
  });
  // Startup reap (08:37): clean up verify temp dirs orphaned by a previously-crashed daemon
  // (ownerPid-dead), plus any dir older than the startup age backstop (M7b leak sweep). A live
  // sibling's in-flight verify (young + owner alive, or within the hard-deadline floor) is never touched.
  try {
    const r = reapOrphanedVerifyRuns({ log: (m) => log.info(m), maxAgeMs: tempPolicy.startupReapMaxAgeMs, minLeakAgeMs, graceMs: tempPolicy.orphanKillGraceMs });
    // #1c · 09 startup reap count (orphan runners killed, temp dirs swept)
    if (r.orphans) metrics.inc('startup_reap_orphans_total', undefined, r.orphans);
    if (r.killed) metrics.inc('startup_reap_killed_total', undefined, r.killed);
    if (r.deleted) metrics.inc('startup_reap_deleted_total', undefined, r.deleted);
  } catch (err) {
    log.warn(`[daemon] verify startup reap failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Periodic TTL sweep (M7b): while the daemon runs, reap dirs older than the temp TTL — but never
  // below the run hard-deadline floor (minLeakAgeMs), so an aggressive TTL can't kill a live verify.
  // Unref'd so it never keeps the process alive on its own.
  const sweep = setInterval(() => {
    try {
      const r = reapOrphanedVerifyRuns({ log: (m) => log.info(m), maxAgeMs: tempPolicy.tempTtlMs, minLeakAgeMs, graceMs: tempPolicy.orphanKillGraceMs });
      if (r.killed) metrics.inc('temp_sweep_killed_total', undefined, r.killed);
      if (r.deleted) metrics.inc('temp_sweep_deleted_total', undefined, r.deleted);
      // Drop salts for abandoned sessions (M7a TTL backstop; daemon restart already rotates all).
      const dropped = defaultSessionKeyRegistry().sweepExpired();
      if (dropped) metrics.inc('session_keys_dropped_total', undefined, dropped);
    } catch (err) {
      log.warn(`[daemon] verify temp sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, tempPolicy.tempTtlMs);
  sweep.unref?.();
  // Init write-transaction crash recovery (07:106-117): resolve any adapter draft interrupted
  // mid-write by a previous crash (roll-forward marker / quarantine unprovenanced / roll back).
  try {
    recoverInitTransactions({ log: (m) => log.info(m) });
  } catch (err) {
    log.warn(`[daemon] init startup recovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`[daemon] Port ${PORT} already in use — another daemon is likely running. Exiting.`);
    process.exit(EXIT_CODES.SERVICE_UNAVAIL);
  }
  log.error(`[daemon] Server error: ${err.message}`);
  process.exit(EXIT_CODES.GENERIC_ERROR);
});

// Graceful shutdown
function shutdown(): void {
  // Reject all pending requests so CLI doesn't hang
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error('Daemon shutting down'));
  }
  pending.clear();
  for (const profile of extensionProfiles.values()) profile.ws.close();
  httpServer.close();
  process.exit(EXIT_CODES.SUCCESS);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
