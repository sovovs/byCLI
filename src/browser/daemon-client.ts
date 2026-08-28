/**
 * HTTP client for communicating with the bycli daemon.
 *
 * Provides a typed send() function that posts a Command and returns a Result.
 */

import { sleep } from '../utils.js';
import { resolveDaemonPort } from './daemon-config.js';
import { classifyBrowserError } from './errors.js';
import { resolveProfileContextId } from './profile.js';
import { AdapterCoordinationError } from '../errors.js';
import type {
  AdapterLease,
  AdapterLeaseRelease,
  AdapterLeaseRequest,
  AdapterResourceGrant,
} from '../adapter-scheduler.js';
import { getAdapterExecutionContext } from '../adapter-execution-context.js';

const BYCLI_HEADERS = { 'X-byCLI': '1' };

let _idCounter = 0;

function generateId(): string {
  return `cmd_${process.pid}_${Date.now()}_${++_idCounter}`;
}

export interface DaemonCommand {
  id: string;
  action: 'exec' | 'navigate' | 'tabs' | 'cookies' | 'screenshot' | 'close-window' | 'set-file-input' | 'insert-text' | 'bind' | 'network-capture-start' | 'network-capture-read' | 'ima-auth-start' | 'ima-auth-read' | 'ima-reader-request' | 'ima-auth-release' | 'wait-download' | 'cdp' | 'frames';
  /** Target page identity (targetId). Cross-layer contract with the extension. */
  page?: string;
  code?: string;
  session?: string;
  surface?: 'browser' | 'adapter';
  /** Adapter site session lifecycle. Persistent site sessions do not idle-expire. */
  siteSession?: 'ephemeral' | 'persistent';
  url?: string;
  op?: string;
  index?: number;
  domain?: string;
  format?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
  /** Override viewport width in CSS pixels for screenshot (0 / undefined = use current) */
  width?: number;
  /** Override viewport height in CSS pixels for screenshot (0 / undefined = use current; ignored when fullPage) */
  height?: number;

  /** Local file paths for set-file-input action */
  files?: string[];
  /** CSS selector for file input element (set-file-input action) */
  selector?: string;
  /** Raw text payload for insert-text action */
  text?: string;
  /** URL substring filter pattern for network capture */
  pattern?: string;
  authId?: string;
  readerPath?: string;
  readerBody?: Record<string, unknown>;
  /** Download wait timeout in milliseconds */
  timeoutMs?: number;
  cdpMethod?: string;
  cdpParams?: Record<string, unknown>;
  /** Window foreground/background policy for owned Browser Bridge containers. */
  windowMode?: 'foreground' | 'background';
  /** Custom idle timeout in seconds for this session. Overrides the default. */
  idleTimeout?: number;
  /** Frame index for cross-frame operations (0-based, from 'frames' action) */
  frameIndex?: number;
  /** Browser profile/context to route the command to. */
  contextId?: string;
  /** Active Adapter lease used by the daemon to fence every browser action. */
  adapterLease?: AdapterLease;
}

export interface DaemonResult {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  errorCode?: string;
  errorHint?: string;
  /** Page identity (targetId) — present on page-scoped command responses */
  page?: string;
}

export class BrowserCommandError extends Error {
  constructor(message: string, readonly code?: string, readonly hint?: string) {
    super(message);
    this.name = 'BrowserCommandError';
  }
}

export interface DaemonStatus {
  ok: boolean;
  pid: number;
  uptime: number;
  daemonVersion?: string;
  extensionConnected: boolean;
  extensionVersion?: string;
  extensionCompatRange?: string;
  extensionCapabilities?: string[];
  contextId?: string;
  profileRequired?: boolean;
  profileDisconnected?: boolean;
  profiles?: BrowserProfileStatus[];
  pending: number;
  commandResultUnknown?: number;
  memoryMB: number;
  port: number;
}

export interface BrowserProfileStatus {
  contextId: string;
  extensionConnected: boolean;
  extensionVersion?: string;
  extensionCompatRange?: string;
  extensionCapabilities?: string[];
  pending: number;
  lastSeenAt?: number;
}

export type DaemonStatusProbe =
  | { kind: 'status'; status: DaemonStatus }
  | { kind: 'stopped' }
  | { kind: 'timeout' }
  | { kind: 'http_error'; statusCode: number }
  | { kind: 'invalid_response' }
  | { kind: 'config_error' }
  | { kind: 'network_error' };

async function consumeDaemonResponse<T>(
  pathname: string,
  init: RequestInit & { timeout?: number } | undefined,
  consume: (response: Response) => Promise<T>,
  port?: number,
): Promise<T> {
  const { timeout = 2000, headers, ...rest } = init ?? {};
  const portResolution = port === undefined ? resolveDaemonPort() : { ok: true as const, port };
  if (!portResolution.ok) throw new Error('Invalid BYCLI_DAEMON_PORT configuration');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`http://127.0.0.1:${portResolution.port}${pathname}`, {
      ...rest,
      headers: { ...BYCLI_HEADERS, ...headers },
      signal: controller.signal,
    });
    return await consume(response);
  } finally {
    clearTimeout(timer);
  }
}

async function requestDaemon(pathname: string, init?: RequestInit & { timeout?: number }): Promise<Response> {
  return consumeDaemonResponse(pathname, init, async (response) => response);
}

async function postAdapterLease<T>(pathname: string, body: unknown, timeout: number): Promise<T> {
  const response = await requestDaemon(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout,
  });
  const envelope = await response.json() as {
    ok?: boolean;
    data?: T;
    error?: string;
    errorCode?: string;
  };
  if (!response.ok || envelope.ok !== true || envelope.data === undefined) {
    throw new AdapterCoordinationError(
      envelope.errorCode ?? 'ADAPTER_QUEUE_RESET',
      envelope.error ?? 'Adapter scheduler request failed',
      true,
    );
  }
  return envelope.data;
}

export function acquireAdapterLease(request: AdapterLeaseRequest): Promise<AdapterLease> {
  return postAdapterLease<AdapterLease>(
    '/v1/adapter-leases/acquire',
    request,
    request.queueTimeoutMs + 5_000,
  );
}

export function heartbeatAdapterLease(lease: AdapterLease): Promise<AdapterLease> {
  return postAdapterLease<AdapterLease>('/v1/adapter-leases/heartbeat', lease, 5_000);
}

export async function releaseAdapterLease(release: AdapterLeaseRelease): Promise<boolean> {
  const data = await postAdapterLease<{ released: boolean }>('/v1/adapter-leases/release', release, 5_000);
  return data.released;
}

export async function cancelAdapterLease(requestId: string): Promise<boolean> {
  const data = await postAdapterLease<{ cancelled: boolean }>('/v1/adapter-leases/cancel', { requestId }, 5_000);
  return data.cancelled;
}

export function acquireAdapterResources(
  lease: AdapterLease,
  keys: string[],
  timeoutMs: number,
): Promise<AdapterResourceGrant> {
  return postAdapterLease<AdapterResourceGrant>(
    '/v1/adapter-resources/acquire',
    { lease, keys, timeoutMs },
    timeoutMs + 5_000,
  );
}

export async function releaseAdapterResources(lease: AdapterLease, grantId: string): Promise<boolean> {
  const data = await postAdapterLease<{ released: boolean }>(
    '/v1/adapter-resources/release',
    { lease, grantId },
    5_000,
  );
  return data.released;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string') return candidate.code;
  return errorCode(candidate.cause);
}

export async function probeDaemonStatus(opts?: { timeout?: number; contextId?: string }): Promise<DaemonStatusProbe> {
  const portResolution = resolveDaemonPort();
  if (!portResolution.ok) return { kind: 'config_error' };
  try {
    const params = opts?.contextId ? `?contextId=${encodeURIComponent(opts.contextId)}` : '';
    return await consumeDaemonResponse(`/status${params}`, { timeout: opts?.timeout ?? 2000 }, async (res) => {
      if (!res.ok) return { kind: 'http_error', statusCode: res.status };
      try {
        return { kind: 'status', status: await res.json() as DaemonStatus };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        return { kind: 'invalid_response' };
      }
    }, portResolution.port);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { kind: 'timeout' };
    if (errorCode(error) === 'ECONNREFUSED') return { kind: 'stopped' };
    return { kind: 'network_error' };
  }
}

export async function fetchDaemonStatus(opts?: { timeout?: number; contextId?: string }): Promise<DaemonStatus | null> {
  const result = await probeDaemonStatus(opts);
  if (result.kind !== 'status') {
    return null;
  }
  return result.status;
}

export type DaemonHealth =
  | { state: 'stopped'; status: null }
  | { state: 'no-extension'; status: DaemonStatus }
  | { state: 'profile-required'; status: DaemonStatus }
  | { state: 'profile-disconnected'; status: DaemonStatus }
  | { state: 'ready'; status: DaemonStatus };

/**
 * Unified daemon health check — single entry point for all status queries.
 * Replaces isDaemonRunning(), isExtensionConnected(), and checkDaemonStatus().
 */
export async function getDaemonHealth(opts?: { timeout?: number; contextId?: string }): Promise<DaemonHealth> {
  const status = await fetchDaemonStatus(opts);
  if (!status) return { state: 'stopped', status: null };
  if (status.profileRequired) return { state: 'profile-required', status };
  if (status.profileDisconnected) return { state: 'profile-disconnected', status };
  if (!status.extensionConnected) return { state: 'no-extension', status };
  return { state: 'ready', status };
}

/** Resolve the concrete daemon profile used to key Adapter scheduler pools. */
export async function resolveAdapterLeaseContextId(requestedContextId?: string): Promise<string> {
  const health = await getDaemonHealth({ contextId: requestedContextId });
  if (health.state === 'ready' && health.status.contextId) {
    return health.status.contextId;
  }
  throw new AdapterCoordinationError(
    'ADAPTER_PROFILE_UNAVAILABLE',
    'The browser daemon could not identify the authenticated profile for this Adapter session.',
    true,
    requestedContextId
      ? `Check that profile "${requestedContextId}" is connected.`
      : 'Connect exactly one browser profile or pass --profile explicitly.',
  );
}

export async function requestDaemonShutdown(opts?: { timeout?: number }): Promise<boolean> {
  try {
    const res = await requestDaemon('/shutdown', { method: 'POST', timeout: opts?.timeout ?? 5000 });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Internal: send a command to the daemon with retry logic.
 * Returns the raw DaemonResult. All retry policy lives here — callers
 * (sendCommand, sendCommandFull) only shape the return value.
 *
 * Retries up to 4 times:
 * - Network errors (TypeError, AbortError): retry at 500ms
 * - Transient browser errors: retry at the delay suggested by classifyBrowserError()
 */
async function sendCommandRaw(
  action: DaemonCommand['action'],
  params: Omit<DaemonCommand, 'id' | 'action'>,
): Promise<DaemonResult> {
  const maxRetries = 4;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const id = generateId();
    const rawWindowMode = process.env.BYCLI_WINDOW;
    const envWindowMode = rawWindowMode === 'foreground' || rawWindowMode === 'background'
      ? rawWindowMode
      : undefined;
    const contextId = params.contextId ?? resolveProfileContextId();
    const windowMode = params.windowMode ?? envWindowMode;
    const adapterLease = getAdapterExecutionContext()?.lease;
    const command: DaemonCommand = {
      id, action, ...params,
      ...(contextId && { contextId }),
      ...(windowMode && { windowMode }),
      ...(adapterLease && { adapterLease }),
    };
    try {
      const res = await requestDaemon('/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
        timeout: 30000,
      });

      const result = (await res.json()) as DaemonResult;

      if (!result.ok) {
        if (result.errorCode === 'command_result_unknown') {
          throw new BrowserCommandError(result.error ?? 'Browser command result is unknown', result.errorCode, result.errorHint);
        }
        const isDuplicateCommandId = res.status === 409
          && (result.error ?? '').includes('Duplicate command id');
        if (isDuplicateCommandId && attempt < maxRetries) {
          continue;
        }
        const advice = classifyBrowserError(new Error(result.error ?? ''));
        if (advice.retryable && attempt < maxRetries) {
          await sleep(advice.delayMs);
          continue;
        }
        throw new BrowserCommandError(result.error ?? 'Daemon command failed', result.errorCode, result.errorHint);
      }

      return result;
    } catch (err) {
      const isNetworkError = err instanceof TypeError
        || (err instanceof Error && err.name === 'AbortError');
      if (isNetworkError && attempt < maxRetries) {
        await sleep(500);
        continue;
      }
      throw err;
    }
  }
  throw new Error('sendCommand: max retries exhausted');
}

/**
 * Send a command to the daemon and return the result data.
 */
export async function sendCommand(
  action: DaemonCommand['action'],
  params: Omit<DaemonCommand, 'id' | 'action'> = {},
): Promise<unknown> {
  const result = await sendCommandRaw(action, params);
  return result.data;
}

/**
 * Like sendCommand, but returns both data and page identity (targetId).
 * Use this for page-scoped commands where the caller needs the page identity.
 */
export async function sendCommandFull(
  action: DaemonCommand['action'],
  params: Omit<DaemonCommand, 'id' | 'action'> = {},
): Promise<{ data: unknown; page?: string }> {
  const result = await sendCommandRaw(action, params);
  return { data: result.data, page: result.page };
}

export async function bindTab(session: string, opts: { contextId?: string } = {}): Promise<unknown> {
  return sendCommand('bind', { session, surface: 'browser', ...opts });
}
