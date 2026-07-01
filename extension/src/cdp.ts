/**
 * CDP execution via chrome.debugger API.
 *
 * chrome.debugger only needs the "debugger" permission — no host_permissions.
 * It can attach to any http/https tab. Avoid chrome:// and chrome-extension://
 * tabs (resolveTabId in background.ts filters them).
 */

import { UI_BINDING_NAME, UI_LISTENER_SOURCE, MAX_UI_EVENTS, parseUiEvent, type UserActionEvent } from './ui-capture';
import { maskUrlAuthTokens } from './url-redact';

const attached = new Set<number>();

const tabFrameContexts = new Map<number, Map<string, number>>();
const frameTargets = new Map<string, string>();
const frameTargetKeys = new Map<string, string>();
let frameTargetCleanupRegistered = false;

// ── OOPIF(跨源 iframe)flat auto-attach 录制 ──────────────────────────────
// 跨源 iframe 是独立 CDP target,经 flat autoAttach 后事件 source 带 sessionId
// (source.tabId 仍是父 tab)。给子 session 发命令用 {tabId, sessionId}。
// childSessionId → 归属 tabId;tabId → 该 tab 下各子 session 的已武装能力位。
const sessionToTab = new Map<string, number>();
// childSessionId → 该 iframe 文档 URL(已脱敏,取自 Target.attachedToTarget 的 targetInfo.url,
// 100% 可靠、不依赖注入脚本)。给子 session 的 network entry / UI event 打 frameUrl 标来源。
const sessionToFrameUrl = new Map<string, string>();
// childSessionId → 父 session id(顶层 attach 的子 session 父为 undefined → 记 ''(top))。
// embedded_iframe 噪音过滤要从目标 iframe 的 frameSessionId 沿父链收 descendants(嵌套 OOPIF 真实 API 不丢)。
const sessionToParent = new Map<string, string>();
type ChildArmState = { autoAttach: boolean; network: boolean; ui: boolean; overCap: boolean };
const armedChildSessions = new Map<number, Map<string, ChildArmState>>();
// 背压:广告站可能有几十个 iframe,每 tab 纳管的子 session 数设上限,超限只放行不武装。
const MAX_CHILD_SESSIONS_PER_TAB = 50;
// rearm/detach 并发守卫:detach 清状态时 bump 该 tab 的 generation,在飞的 rearm 循环据此停手。
const tabCaptureGeneration = new Map<number, number>();

function childStateMap(tabId: number): Map<string, ChildArmState> {
  let m = armedChildSessions.get(tabId);
  if (!m) { m = new Map(); armedChildSessions.set(tabId, m); }
  return m;
}

/** 子 session debuggee。sessionId 在运行时受支持(flat sessions),类型上需 cast。 */
function childDebuggee(tabId: number, sessionId: string): chrome.debugger.Debuggee {
  return { tabId, sessionId } as chrome.debugger.Debuggee;
}

/** 读 Debuggee.sessionId(@types/chrome 未声明此字段,运行时由 flat sessions 提供)。 */
function sessionIdOf(source: chrome.debugger.Debuggee): string | undefined {
  return (source as { sessionId?: string }).sessionId;
}

/** try/catch 包装的 sendCommand;子 session 可能正在销毁,全 best-effort。
 *  返回是否成功——调用方据此决定是否标记能力位为已武装(临时失败不应标 true,留待 rearm 重试)。 */
async function sendSafe(target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown> = {}): Promise<boolean> {
  try { await chrome.debugger.sendCommand(target, method, params); return true; } catch { return false; }
}

/** capture buffer key:跨子 session 的 requestId 不保证唯一,以 sessionId 前缀防撞。 */
function reqKey(sessionId: string | undefined, requestId: string): string {
  return `${sessionId ?? 'top'}:${requestId}`;
}

const AUTO_ATTACH_IFRAME_PARAMS = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: 'iframe', exclude: false }],
} as const;

// Large cap so agents stop hitting silent JSON.parse failures on real API bodies.
// See src/browser/cdp.ts CDP_RESPONSE_BODY_CAPTURE_LIMIT for the matching constant
// on the direct-CDP path. Keep in sync.
const CDP_RESPONSE_BODY_CAPTURE_LIMIT = 8 * 1024 * 1024;
const CDP_REQUEST_BODY_CAPTURE_LIMIT = 1 * 1024 * 1024;
// WebSocket(kind='cdp-websocket'):单帧 payload 截断上限 + 单连接帧数上限(背压)。
const CDP_WS_FRAME_CAPTURE_LIMIT = 256 * 1024;
const MAX_WS_FRAMES_PER_CONN = 500;

type WebSocketFrame = {
  direction: 'sent' | 'received';
  opcode: number; // 1=text、2=binary(payloadPreview 为 base64);control 帧(8/9/10)不收
  payloadPreview: string;
  payloadFullSize: number;
  payloadTruncated: boolean;
  timestamp: number;
};

type NetworkCaptureEntry = {
  kind: 'cdp' | 'cdp-websocket';
  url: string;
  method: string;
  requestHeaders?: Record<string, string>;
  requestBodyKind?: string;
  requestBodyPreview?: string;
  requestBodyFullSize?: number;
  requestBodyTruncated?: boolean;
  responseStatus?: number;
  responseContentType?: string;
  responseHeaders?: Record<string, string>;
  responsePreview?: string;
  responseBodyFullSize?: number;
  responseBodyTruncated?: boolean;
  timestamp: number;
  /** M-UI-3 因果对齐信号:CDP initiator 类型(script/parser/preload/other)+ 发起 frameId。
   *  script=用户交互触发的 JS fetch(可关联到 user-action);parser/preload=旁路(降权)。 */
  initiatorType?: string;
  frameId?: string;
  /** OOPIF:请求来自的跨源 iframe 子 session(顶层请求无此字段);供下游因果对齐区分 frame。 */
  frameSessionId?: string;
  /** OOPIF:请求来自的 iframe 文档 URL(已脱敏,取自 CDP targetInfo.url);顶层请求无此字段。 */
  frameUrl?: string;
  // CDP ResourceType(XHR/Fetch/WebSocket…)。诊断 + 喂 LLM 用;采集已按此过滤,正常只应见 XHR/Fetch/WebSocket。
  resourceType?: string;
  // WebSocket(kind==='cdp-websocket')专用:握手后累计的数据帧序列 + 背压丢弃计数。
  webSocketFrames?: WebSocketFrame[];
  webSocketFramesDropped?: number;
};

type NetworkCaptureState = {
  patterns: string[];
  entries: NetworkCaptureEntry[];
  requestToIndex: Map<string, number>;
};

export type DownloadWaitResult = {
  downloaded: boolean;
  id?: number;
  filename?: string;
  url?: string;
  finalUrl?: string;
  mime?: string;
  totalBytes?: number;
  state?: string;
  danger?: string;
  error?: string;
  elapsedMs: number;
};

const networkCaptures = new Map<number, NetworkCaptureState>();

// 采集只录制 DevTools Network 面板「Fetch/XHR」过滤器对应的请求,
// 排除 Document/Stylesheet/Script/Image/Font/Media 等静态资源(js/css/html…)。
// CDP 在 requestWillBeSent / responseReceived 的 `type` 字段给出 ResourceType。
const CAPTURE_RESOURCE_TYPES = new Set(['XHR', 'Fetch']);
function isApiResourceType(type: unknown): boolean {
  return typeof type === 'string' && CAPTURE_RESOURCE_TYPES.has(type);
}

// 二次过滤:有些站点用 fetch()/XHR 拉静态资源(CSS/JS/字体/图片),resourceType 会是 Fetch/XHR
// 蒙混过关。按服务器声明的响应 Content-Type 再排除一道(只丢明确的静态资源类型;JSON/HTML/text
// 等数据响应一律保留)。WS 无 contentType,由 readNetworkCapture 的 kind 守卫单独放行。
function isStaticAssetContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  const t = ct.toLowerCase().split(';')[0].trim();
  if (t.startsWith('image/') || t.startsWith('font/') || t.startsWith('audio/') || t.startsWith('video/')) return true;
  return (
    t === 'text/css' ||
    t === 'text/javascript' ||
    t === 'application/javascript' ||
    t === 'application/x-javascript' ||
    t === 'application/ecmascript' ||
    t === 'application/font-woff' ||
    t === 'application/font-woff2' ||
    t === 'application/x-font-ttf' ||
    t === 'application/vnd.ms-fontobject'
  );
}

// UI 节点录制(M-UI-1):per-tab 用户事件 ring-cap buffer + 累计 dropped 计数。
interface UiCaptureState { events: UserActionEvent[]; dropped: number }
const uiCaptures = new Map<number, UiCaptureState>();
/** Check if a URL can be attached via CDP — only allow http(s) and blank pages. */
function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;  // empty/undefined = tab still loading, allow it
  return url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank' || url.startsWith('data:');
}

export async function ensureAttached(tabId: number, aggressiveRetry: boolean = false): Promise<void> {
  // Verify the tab URL is debuggable before attempting attach
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isDebuggableUrl(tab.url)) {
      // Invalidate cache if previously attached
      attached.delete(tabId);
      throw new Error(`Cannot debug tab ${tabId}: URL is ${tab.url ?? 'unknown'}`);
    }
  } catch (e) {
    // Re-throw our own error, catch only chrome.tabs.get failures
    if (e instanceof Error && e.message.startsWith('Cannot debug tab')) throw e;
    attached.delete(tabId);
    throw new Error(`Tab ${tabId} no longer exists`);
  }

  if (attached.has(tabId)) {
    // Verify the debugger is still actually attached by sending a harmless command
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1', returnByValue: true,
      });
      return; // Still attached and working
    } catch {
      // Stale cache entry — need to re-attach
      attached.delete(tabId);
    }
  }

  // Retry attach up to 3 times — other extensions (1Password, Playwright MCP Bridge)
  // can temporarily interfere with chrome.debugger. A short delay usually resolves it.
  // Normal commands: 2 retries, 500ms delay (fast fail for non-browser use)
  // Browser commands: 5 retries, 1500ms delay (aggressive, tolerates extension interference)
  const MAX_ATTACH_RETRIES = aggressiveRetry ? 5 : 2;
  const RETRY_DELAY_MS = aggressiveRetry ? 1500 : 500;
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTACH_RETRIES; attempt++) {
    try {
      // Force detach first to clear any stale state from other extensions
      try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
      await chrome.debugger.attach({ tabId }, '1.3');
      lastError = '';
      break; // Success
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_ATTACH_RETRIES) {
        console.warn(`[bycli] attach attempt ${attempt}/${MAX_ATTACH_RETRIES} failed: ${lastError}, retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        // Re-verify tab URL before retrying (it may have changed)
        try {
          const tab = await chrome.tabs.get(tabId);
          if (!isDebuggableUrl(tab.url)) {
            lastError = `Tab URL changed to ${tab.url} during retry`;
            break; // Don't retry if URL became un-debuggable
          }
        } catch {
          // Tab is gone — don't fail early here.
          // Later retry layers can re-resolve a fresh automation tab/window.
          lastError = `Tab ${tabId} no longer exists`;
          // Don't break; fall through to retry
        }
      }
    }
  }

  if (lastError) {
    // Log detailed diagnostics for debugging extension conflicts
    let finalUrl = 'unknown';
    let finalWindowId = 'unknown';
    try {
      const tab = await chrome.tabs.get(tabId);
      finalUrl = tab.url ?? 'undefined';
      finalWindowId = String(tab.windowId);
    } catch { /* tab gone */ }
    console.warn(`[bycli] attach failed for tab ${tabId}: url=${finalUrl}, windowId=${finalWindowId}, error=${lastError}`);

    const hint = lastError.includes('chrome-extension://')
      ? '. Tip: another Chrome extension may be interfering — try disabling other extensions'
      : '';
    throw new Error(`attach failed: ${lastError}${hint}`);
  }
  attached.add(tabId);

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
  } catch {
    // Some pages may not need explicit enable
  }
}

export async function evaluate(tabId: number, expression: string, aggressiveRetry: boolean = false): Promise<unknown> {
  // Retry the entire evaluate (attach + command).
  // Normal: 2 retries. Browser: 3 retries (tolerates extension interference).
  const MAX_EVAL_RETRIES = aggressiveRetry ? 3 : 2;
  for (let attempt = 1; attempt <= MAX_EVAL_RETRIES; attempt++) {
    try {
      await ensureAttached(tabId, aggressiveRetry);

      const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }) as {
        result?: { type: string; value?: unknown; description?: string; subtype?: string };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      };

      if (result.exceptionDetails) {
        const errMsg = result.exceptionDetails.exception?.description
          || result.exceptionDetails.text
          || 'Eval error';
        throw new Error(errMsg);
      }

      return result.result?.value;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Only retry on attach/debugger errors, not on JS eval errors
      const isNavigateError = msg.includes('Inspected target navigated') || msg.includes('Target closed');
      const isAttachError = isNavigateError || msg.includes('attach failed') || msg.includes('Debugger is not attached')
        || msg.includes('chrome-extension://');
      if (isAttachError && attempt < MAX_EVAL_RETRIES) {
        attached.delete(tabId); // Force re-attach on next attempt
        // SPA navigations recover quickly; debugger detach needs longer
        const retryMs = isNavigateError ? 200 : 500;
        await new Promise(resolve => setTimeout(resolve, retryMs));
        continue;
      }
      throw e;
    }
  }
  throw new Error('evaluate: max retries exhausted');
}

export const evaluateAsync = evaluate;

/**
 * Capture a screenshot via CDP Page.captureScreenshot.
 * Returns base64-encoded image data.
 */
export async function screenshot(
  tabId: number,
  options: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; width?: number; height?: number } = {},
): Promise<string> {
  await ensureAttached(tabId);

  const format = options.format ?? 'png';
  const fullPage = options.fullPage === true;
  const overrideWidth = options.width && options.width > 0 ? Math.ceil(options.width) : undefined;
  // height is ignored under fullPage so the existing measure-from-content path stays unchanged for users who pass --height alongside --full-page.
  const overrideHeight = !fullPage && options.height && options.height > 0 ? Math.ceil(options.height) : undefined;
  const needsOverride = fullPage || overrideWidth !== undefined || overrideHeight !== undefined;

  if (needsOverride) {
    // When width is set, apply it first so layout reflows before we read content size.
    if (overrideWidth !== undefined && fullPage) {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
        mobile: false,
        width: overrideWidth,
        height: 0,
        deviceScaleFactor: 1,
      });
    }
    let finalWidth = overrideWidth ?? 0;
    let finalHeight = overrideHeight ?? 0;
    if (fullPage) {
      const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics') as {
        contentSize?: { width: number; height: number };
        cssContentSize?: { width: number; height: number };
      };
      const size = metrics.cssContentSize || metrics.contentSize;
      if (size) {
        if (finalWidth === 0) finalWidth = Math.ceil(size.width);
        finalHeight = Math.ceil(size.height);
      }
    }
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      mobile: false,
      width: finalWidth,
      height: finalHeight,
      deviceScaleFactor: 1,
    });
  }

  try {
    const params: Record<string, unknown> = { format };
    if (format === 'jpeg' && options.quality !== undefined) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }

    const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params) as {
      data: string; // base64-encoded
    };

    return result.data;
  } finally {
    if (needsOverride) {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
  }
}

/**
 * Set local file paths on a file input element via CDP DOM.setFileInputFiles.
 * This bypasses the need to send large base64 payloads through the message channel —
 * Chrome reads the files directly from the local filesystem.
 *
 * @param tabId - Target tab ID
 * @param files - Array of absolute local file paths
 * @param selector - CSS selector to find the file input (optional, defaults to first file input)
 */
export async function setFileInputFiles(
  tabId: number,
  files: string[],
  selector?: string,
): Promise<void> {
  await ensureAttached(tabId);

  // Enable DOM domain (required for DOM.querySelector and DOM.setFileInputFiles)
  await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');

  // Get the document root
  const doc = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument') as {
    root: { nodeId: number };
  };

  // Find the file input element
  const query = selector || 'input[type="file"]';
  const result = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: query,
  }) as { nodeId: number };

  if (!result.nodeId) {
    throw new Error(`No element found matching selector: ${query}`);
  }

  // Set files directly via CDP — Chrome reads from local filesystem
  await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
    files,
    nodeId: result.nodeId,
  });
}

function matchesDownloadPattern(item: chrome.downloads.DownloadItem, pattern: string): boolean {
  if (!pattern) return true;
  const haystack = [
    item.filename,
    item.url,
    item.finalUrl,
    item.mime,
  ].filter(Boolean).join('\n').toLowerCase();
  return haystack.includes(pattern.toLowerCase());
}

function downloadResult(item: chrome.downloads.DownloadItem, startedAt: number): DownloadWaitResult {
  return {
    downloaded: item.state === 'complete',
    id: item.id,
    filename: item.filename,
    url: item.url,
    finalUrl: item.finalUrl,
    mime: item.mime,
    totalBytes: item.totalBytes,
    state: item.state,
    danger: item.danger,
    error: item.error,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function waitForDownload(pattern: string = '', timeoutMs: number = 30000): Promise<DownloadWaitResult> {
  const startedAt = Date.now();
  const timeout = Math.max(1, timeoutMs);

  return await new Promise<DownloadWaitResult>((resolve) => {
    let done = false;
    const inProgressIds = new Set<number>();
    const finish = (result: DownloadWaitResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(result);
    };

    const inspectById = async (id: number) => {
      const items = await chrome.downloads.search({ id });
      const item = items[0];
      if (!item || !matchesDownloadPattern(item, pattern)) return;
      inProgressIds.add(id);
      if (item.state === 'complete' || item.state === 'interrupted') finish(downloadResult(item, startedAt));
    };

    const onCreated = (item: chrome.downloads.DownloadItem) => {
      if (!matchesDownloadPattern(item, pattern)) return;
      inProgressIds.add(item.id);
      if (item.state === 'complete' || item.state === 'interrupted') finish(downloadResult(item, startedAt));
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (!delta.id) return;
      if (!inProgressIds.has(delta.id) && !delta.filename && !delta.url) return;
      if (delta.filename?.current || delta.url?.current) {
        void inspectById(delta.id);
        return;
      }
      if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
        void inspectById(delta.id);
      }
    };
    const timer = setTimeout(() => {
      finish({
        downloaded: false,
        state: 'interrupted',
        error: `No download matched "${pattern || '*'}" within ${timeout}ms`,
        elapsedMs: Date.now() - startedAt,
      });
    }, timeout);

    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);

    void chrome.downloads.search({
      limit: 50,
      orderBy: ['-startTime'],
      startedAfter: new Date(startedAt - Math.max(timeout, 1000)).toISOString(),
    }).then((recent) => {
      if (done) return;
      const completed = recent.find((item) => item.state === 'complete' && matchesDownloadPattern(item, pattern));
      if (completed) {
        finish(downloadResult(completed, startedAt));
        return;
      }
      for (const item of recent) {
        if (item.state === 'in_progress' && matchesDownloadPattern(item, pattern)) inProgressIds.add(item.id);
      }
    }).catch((err) => {
      finish({
        downloaded: false,
        state: 'interrupted',
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

function frameTargetKey(tabId: number, frameId: string): string {
  return `${tabId}:${frameId}`;
}

function registerFrameTargetCleanup(): void {
  if (frameTargetCleanupRegistered) return;
  frameTargetCleanupRegistered = true;
  chrome.debugger.onEvent.addListener((_source, method, params: any) => {
    if (method === 'Target.detachedFromTarget') {
      const targetId = String(params?.targetId || '');
      clearFrameTarget(targetId);
    }
  });
}

function clearFrameTarget(targetId: string): void {
  if (!targetId) return;
  const key = frameTargetKeys.get(targetId);
  if (key) frameTargets.delete(key);
  frameTargetKeys.delete(targetId);
}

async function ensureFrameTarget(
  tabId: number,
  frameId: string,
  aggressiveRetry: boolean = false,
  targetUrl?: string,
): Promise<string> {
  registerFrameTargetCleanup();
  await ensureAttached(tabId, aggressiveRetry);
  const key = frameTargetKey(tabId, frameId);
  const existing = frameTargets.get(key);
  if (existing) return existing;

  await chrome.debugger.sendCommand({ tabId }, 'Target.setDiscoverTargets', { discover: true }).catch(() => {});
  // 若该 tab 正在 capture,flat autoAttach 已用 waitForDebuggerOnStart:true 武装子 session;
  // 这里不要 downgrade 成 false(会破坏 capture 的子 session 暂停/武装时序)。capture 不活跃时
  // 维持旧行为(false:per-frame exec 不需要暂停子 target)。
  const captureActive = networkCaptures.has(tabId) || uiCaptures.has(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: captureActive,
    flatten: true,
    filter: [{ type: 'iframe', exclude: false }],
  }).catch(() => {});
  const targetId = await resolveFrameTargetId(tabId, frameId, targetUrl);
  try {
    await chrome.debugger.attach({ targetId } as chrome.debugger.Debuggee, '1.3');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('Another debugger is already attached')) throw err;
  }
  frameTargets.set(key, targetId);
  frameTargetKeys.set(targetId, key);
  return targetId;
}

async function resolveFrameTargetId(tabId: number, frameId: string, targetUrl?: string): Promise<string> {
  const result = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargets').catch(() => null) as
    | { targetInfos?: Array<{ targetId?: string; id?: string; type?: string; url?: string }> }
    | null;
  const targets = result?.targetInfos ?? [];
  const frameTarget = targets.find((candidate) => {
    const candidateId = candidate.targetId || candidate.id;
    return candidate.type === 'iframe'
      && (
        candidateId === frameId
        || (!!targetUrl && candidate.url === targetUrl)
      );
  });
  const targetId = frameTarget?.targetId || frameTarget?.id;
  if (targetId) return targetId;
  const candidates = targets
    .filter((target) => target.type === 'iframe')
    .map((target) => `${target.targetId || target.id || '?'} ${target.url || ''}`)
    .join('; ');
  throw new Error(`No iframe target found for frame ${frameId}${targetUrl ? ` (${targetUrl})` : ''}. Candidates: ${candidates || 'none'}`);
}

export async function sendCommandInFrameTarget(
  tabId: number,
  frameId: string,
  method: string,
  params: Record<string, unknown> = {},
  aggressiveRetry: boolean = false,
  _timeoutMs: number = 30_000,
  targetUrl?: string,
): Promise<unknown> {
  const targetId = await ensureFrameTarget(tabId, frameId, aggressiveRetry, targetUrl);
  const target = { targetId } as chrome.debugger.Debuggee;
  return chrome.debugger.sendCommand(target, method, params);
}

export async function insertText(
  tabId: number,
  text: string,
): Promise<void> {
  await ensureAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
}

export function registerFrameTracking(): void {
  registerFrameTargetCleanup();
  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    const tabId = source.tabId;
    if (!tabId) return;
    // OOPIF:忽略带 sessionId 的子 session Runtime context 事件——子 session 的 executionContextId
    // 与顶层不同域,若写进 tabFrameContexts 会让 evaluateInFrame 拿子 contextId 却向顶层 {tabId}
    // 发 Runtime.evaluate(契约不符)。per-frame eval 走 sendCommandInFrameTarget 自己的路径。
    if (sessionIdOf(source)) return;

    if (method === 'Runtime.executionContextCreated') {
      const context = params.context;
      if (!context?.auxData?.frameId || context.auxData.isDefault !== true) return;
      const frameId = context.auxData.frameId as string;
      if (!tabFrameContexts.has(tabId)) {
        tabFrameContexts.set(tabId, new Map());
      }
      tabFrameContexts.get(tabId)!.set(frameId, context.id);
    }

    if (method === 'Runtime.executionContextDestroyed') {
      const ctxId = params.executionContextId;
      const contexts = tabFrameContexts.get(tabId);
      if (contexts) {
        for (const [fid, cid] of contexts) {
          if (cid === ctxId) { contexts.delete(fid); break; }
        }
      }
    }

    if (method === 'Runtime.executionContextsCleared') {
      tabFrameContexts.delete(tabId);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabFrameContexts.delete(tabId);
  });
}

export async function getFrameTree(tabId: number): Promise<any> {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree');
}

export async function evaluateInFrame(
  tabId: number,
  expression: string,
  frameId: string,
  aggressiveRetry: boolean = false,
): Promise<unknown> {
  await ensureAttached(tabId, aggressiveRetry);

  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable').catch(() => {});

  const contexts = tabFrameContexts.get(tabId);
  const contextId = contexts?.get(frameId);

  if (contextId === undefined) {
    await sendCommandInFrameTarget(tabId, frameId, 'Runtime.enable', {}, aggressiveRetry).catch(() => undefined);
    const result = await sendCommandInFrameTarget(tabId, frameId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, aggressiveRetry) as {
      result?: { type: string; value?: unknown; description?: string; subtype?: string };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };

    if (result.exceptionDetails) {
      const errMsg = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'Eval error';
      throw new Error(errMsg);
    }

    return result.result?.value;
  }

  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true,
  }) as {
    result?: { type: string; value?: unknown; description?: string; subtype?: string };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Eval error';
    throw new Error(errMsg);
  }

  return result.result?.value;
}

function normalizeCapturePatterns(pattern?: string): string[] {
  return String(pattern || '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
}

function shouldCaptureUrl(url: string | undefined, patterns: string[]): boolean {
  if (!url) return false;
  if (!patterns.length) return true;
  return patterns.some((pattern) => url.includes(pattern));
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    out[String(key)] = String(value);
  }
  return out;
}

function getOrCreateNetworkCaptureEntry(tabId: number, key: string, fallback?: {
  url?: string;
  method?: string;
  requestHeaders?: Record<string, string>;
}, kind: 'cdp' | 'cdp-websocket' = 'cdp'): NetworkCaptureEntry | null {
  const state = networkCaptures.get(tabId);
  if (!state) return null;
  const existingIndex = state.requestToIndex.get(key);
  if (existingIndex !== undefined) {
    return state.entries[existingIndex] || null;
  }
  const url = fallback?.url || '';
  if (!shouldCaptureUrl(url, state.patterns)) return null;
  const entry: NetworkCaptureEntry = {
    kind,
    url,
    method: fallback?.method || 'GET',
    requestHeaders: fallback?.requestHeaders || {},
    timestamp: Date.now(),
  };
  state.entries.push(entry);
  state.requestToIndex.set(key, state.entries.length - 1);
  return entry;
}

// ── OOPIF 子 session 武装 ────────────────────────────────────────────────
// flat autoAttach 出来的 iframe 子 session,按当前激活的 capture 种类开 Network/UI 域。
// 能力位幂等:同一 session 多次调用只补未武装的域(network-capture-start 与
// ui-capture-start 是先后两条命令,iframe 可能在两者之间 attach,必须能后补)。
// 能力位仅在 sendSafe 成功时才置 true(临时失败留待 rearm 重试)。
// waitForDebuggerOnStart:true → 子 target 暂停在启动点,武装完(仅首次 attach)必须
// runIfWaitingForDebugger 放行(异常路径也放),否则 iframe 永久卡加载。
async function armChildSession(tabId: number, sessionId: string): Promise<void> {
  const states = childStateMap(tabId);
  let st = states.get(sessionId);
  const isNew = st === undefined;
  // 背压:超过 per-tab 上限的新 session 只登记 + 放行,不武装(不开域 → 不产生事件)。
  // overCap 持久化:后续 rearm 据此短路,绝不补武装(否则破坏 cap)。
  if (isNew && states.size >= MAX_CHILD_SESSIONS_PER_TAB) {
    states.set(sessionId, { autoAttach: false, network: false, ui: false, overCap: true });
    sessionToTab.set(sessionId, tabId);
    await sendSafe(childDebuggee(tabId, sessionId), 'Runtime.runIfWaitingForDebugger', {});
    return;
  }
  if (!st) { st = { autoAttach: false, network: false, ui: false, overCap: false }; states.set(sessionId, st); }
  if (st.overCap) return; // over-cap session 永不武装(持久短路,堵 rearm 漏洞)
  sessionToTab.set(sessionId, tabId);
  const child = childDebuggee(tabId, sessionId);
  try {
    if (!st.autoAttach) {
      // 级联:子 session 也自动 attach 它内部的 iframe(嵌套 OOPIF)。
      if (await sendSafe(child, 'Target.setAutoAttach', { ...AUTO_ATTACH_IFRAME_PARAMS })) st.autoAttach = true;
    }
    if (networkCaptures.has(tabId) && !st.network) {
      if (await sendSafe(child, 'Network.enable', {})) st.network = true;
    }
    if (uiCaptures.has(tabId) && !st.ui) {
      // UI 注入是多步;全部成功才标 ui=true(任一失败 rearm 时整体重试,addBinding 等本就幂等)。
      const ok = (await sendSafe(child, 'Runtime.enable', {}))
        && (await sendSafe(child, 'Page.enable', {}))
        && (await sendSafe(child, 'Runtime.addBinding', { name: UI_BINDING_NAME }))
        && (await sendSafe(child, 'Page.addScriptToEvaluateOnNewDocument', { source: UI_LISTENER_SOURCE }));
      // 当前已加载子文档立即注入一次(失败不阻断,后续导航会再注入)。
      await sendSafe(child, 'Runtime.evaluate', { expression: UI_LISTENER_SOURCE });
      if (ok) st.ui = true;
    }
  } finally {
    // 关键:仅首次 attach 时放行,否则 waitForDebuggerOnStart 卡死该 iframe;rearm 不重复 resume。
    if (isNew) await sendSafe(child, 'Runtime.runIfWaitingForDebugger', {});
  }
}

/** 已纳管的子 session 在新 capture 种类启动时补武装缺失的域。
 *  generation 守卫:若遍历途中 detach 清了该 tab 状态(generation 变),立即停手,
 *  避免在清理后继续 arm 后续 session 造成状态复活。 */
async function rearmChildSessions(tabId: number): Promise<void> {
  const states = armedChildSessions.get(tabId);
  if (!states) return;
  const gen = tabCaptureGeneration.get(tabId) ?? 0;
  for (const sessionId of [...states.keys()]) {
    if ((tabCaptureGeneration.get(tabId) ?? 0) !== gen) return; // 被 detach 打断
    if (armedChildSessions.get(tabId) !== states) return;        // 状态已被替换/清除
    if (!states.has(sessionId)) continue; // 单个 child 在遍历途中 detach → 跳过,不重建
    await armChildSession(tabId, sessionId);
  }
}

/** capture 启动时对 tab 开启 iframe flat autoAttach,后续新建/导航的子 frame 会自动 attach。 */
async function enableIframeAutoAttach(tabId: number): Promise<void> {
  await sendSafe({ tabId }, 'Target.setAutoAttach', { ...AUTO_ATTACH_IFRAME_PARAMS });
}

export async function startNetworkCapture(
  tabId: number,
  pattern?: string,
): Promise<void> {
  await ensureAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  networkCaptures.set(tabId, {
    patterns: normalizeCapturePatterns(pattern),
    entries: [],
    requestToIndex: new Map(),
  });
  // OOPIF:让后续新建/导航的跨源 iframe 子 session 自动 attach(armChildSession 开 Network)。
  await enableIframeAutoAttach(tabId);
  // 已纳管的子 session(如 UI capture 先开时 attach 的)补开 Network 域。
  await rearmChildSessions(tabId);
}

export async function readNetworkCapture(tabId: number, filter?: CaptureFrameFilter): Promise<NetworkCaptureEntry[]> {
  const state = networkCaptures.get(tabId);
  if (!state) return [];
  // WS 永远保留;HTTP 条目按响应 Content-Type 丢掉静态资源(CSS/JS/字体/图片/音视频)。
  let entries = state.entries.filter(
    (e) => e.kind === 'cdp-websocket' || !isStaticAssetContentType(e.responseContentType),
  );
  // embedded_iframe:只留目标 iframe(+descendants)的条目,丢顶层 dashboard 噪音。
  if (filter) {
    const r = applyFrameFilter(tabId, entries, filter);
    if (r.resolve.kind === 'ambiguous') throw new AmbiguousIframeTargetError(r.resolve.candidates.length);
    entries = r.items;
  }
  state.entries = [];
  state.requestToIndex.clear();
  return entries;
}

/** embedded_iframe 目标 iframe 解析出多候选 → be 回 ambiguous_iframe_target 让 UI 提示用户澄清。 */
export class AmbiguousIframeTargetError extends Error {
  readonly code = 'ambiguous_iframe_target' as const;
  constructor(count: number) { super(`ambiguous iframe target: ${count} candidate frames matched`); }
}

// ── embedded_iframe 噪音过滤(采集适配层)──────────────────────────────────
// dashboard 自己的 tab 被 attach 后,顶层 dashboard 的 be API/截图轮询(frameSessionId 空)会混进 capture。
// be 传目标 iframe 的 URL,这里解析出其 frameSessionId 并沿子链收 descendants,只留这些子 session 的条目、
// 丢顶层(frameSessionId 空)。tab_projection(无 filter)路径完全不走这里。
export type CaptureFrameFilter = { targetFrameUrl: string };

/** 解析 ambiguous:返回结果区分「唯一命中」「无命中」「多候选歧义」,让 be 回 ambiguous_iframe_target。 */
export type FrameResolveResult =
  | { kind: 'ok'; sessionIds: Set<string> }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: string[] };

function normalizeUrlForMatch(raw: string): { href: string; origin: string; pathname: string } | null {
  try {
    const u = new URL(raw);
    // 归一:去 hash、补默认 /、去尾斜杠(/ 保留根)。query 保留(SPA 常以 query 区分)。
    const pathname = u.pathname.replace(/\/+$/, '') || '/';
    return { href: `${u.origin}${pathname}${u.search}`, origin: u.origin, pathname };
  } catch {
    return null;
  }
}

/** 把目标 URL 解析到一个或多个 iframe 子 session。匹配顺序(Codex 裁定,别只靠 exact):
 *  normalizedUrl exact → same-origin+pathname → 多候选报 ambiguous。frameUrl 已脱敏,目标 URL 同样脱敏后比。 */
function resolveTargetFrameSessions(tabId: number, targetFrameUrl: string): FrameResolveResult {
  const target = normalizeUrlForMatch(maskUrlAuthTokens(targetFrameUrl));
  if (!target) return { kind: 'none' };
  const states = armedChildSessions.get(tabId);
  if (!states || states.size === 0) return { kind: 'none' };
  const candidates: Array<{ sid: string; norm: ReturnType<typeof normalizeUrlForMatch> }> = [];
  for (const sid of states.keys()) {
    const frameUrl = sessionToFrameUrl.get(sid);
    if (!frameUrl) continue;
    candidates.push({ sid, norm: normalizeUrlForMatch(frameUrl) });
  }
  // 第一层:normalizedUrl 完全相等。
  const exact = candidates.filter((c) => c.norm && c.norm.href === target.href);
  if (exact.length === 1) return { kind: 'ok', sessionIds: collectDescendants(tabId, exact[0].sid) };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact.map((c) => c.sid) };
  // 第二层:same-origin + pathname(站会补 query/重定向/SPA shell)。
  const loose = candidates.filter((c) => c.norm && c.norm.origin === target.origin && c.norm.pathname === target.pathname);
  if (loose.length === 1) return { kind: 'ok', sessionIds: collectDescendants(tabId, loose[0].sid) };
  if (loose.length > 1) return { kind: 'ambiguous', candidates: loose.map((c) => c.sid) };
  // 第三层:same-origin(任意 path;SPA 站内跳转/重定向后 pathname 已变)。
  const sameOrigin = candidates.filter((c) => c.norm && c.norm.origin === target.origin);
  if (sameOrigin.length === 1) return { kind: 'ok', sessionIds: collectDescendants(tabId, sameOrigin[0].sid) };
  if (sameOrigin.length > 1) return { kind: 'ambiguous', candidates: sameOrigin.map((c) => c.sid) };
  // 兜底:URL 全程拿不到(OOPIF attach 时 targetInfo.url 为空、targetInfoChanged 也没来),但确实有 iframe 子 session。
  // embedded 模式只嵌一个目标站 → 保留所有 iframe 子 session(+descendants),只丢顶层 dashboard 噪音(frameSessionId 空)。
  // 这是 embedded 模式抓不到 entries 的真实根因兜底(真机 juejin:111 条全被空 URL 误滤)。
  const all = new Set<string>();
  for (const sid of states.keys()) for (const d of collectDescendants(tabId, sid)) all.add(d);
  if (all.size > 0) return { kind: 'ok', sessionIds: all };
  return { kind: 'none' };
}

/** 从目标 frameSessionId 沿父链收集所有后代子 session(嵌套 OOPIF 的真实 API 不能丢)。 */
function collectDescendants(tabId: number, rootSid: string): Set<string> {
  const out = new Set<string>([rootSid]);
  const states = armedChildSessions.get(tabId);
  if (!states) return out;
  // 多趟传播:子的父在 out 中则纳入,直到不再增长(子 session 数有上限,趟数有界)。
  let grew = true;
  while (grew) {
    grew = false;
    for (const sid of states.keys()) {
      if (out.has(sid)) continue;
      const parent = sessionToParent.get(sid);
      if (parent !== undefined && out.has(parent)) { out.add(sid); grew = true; }
    }
  }
  return out;
}

function applyFrameFilter<T extends { frameSessionId?: string }>(
  tabId: number, items: T[], filter: CaptureFrameFilter,
): { items: T[]; resolve: FrameResolveResult } {
  const resolve = resolveTargetFrameSessions(tabId, filter.targetFrameUrl);
  if (resolve.kind !== 'ok') return { items: [], resolve };
  const allow = resolve.sessionIds;
  return { items: items.filter((it) => it.frameSessionId !== undefined && allow.has(it.frameSessionId)), resolve };
}

export function hasActiveNetworkCapture(tabId: number): boolean {
  return networkCaptures.has(tabId);
}

// ── UI 节点录制(M-UI-1)────────────────────────────────────────────────────
// 暴露 window.__bycli_ui binding + 注入只读监听脚本(future-doc via addScriptToEvaluateOnNewDocument
// 覆盖后续导航,current-doc via Runtime.evaluate 覆盖已打开页)。事件经 Runtime.bindingCalled 回到
// registerListeners 的 onEvent → ring-cap buffer。dedicated sendCommand,绕过 cdp 白名单(同 network-capture)。
export async function startUiCapture(tabId: number): Promise<void> {
  await ensureAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.addBinding', { name: UI_BINDING_NAME });
  await chrome.debugger.sendCommand({ tabId }, 'Page.addScriptToEvaluateOnNewDocument', { source: UI_LISTENER_SOURCE });
  // 当前已加载文档不会触发 addScriptToEvaluateOnNewDocument → 立即注入一次(脚本内有防重复装守卫)。
  try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: UI_LISTENER_SOURCE }); } catch { /* CSP/timing：后续导航会再注入 */ }
  uiCaptures.set(tabId, { events: [], dropped: 0 });
  // OOPIF:让跨源 iframe 子 session 自动 attach(armChildSession 注入 UI binding/脚本)。
  await enableIframeAutoAttach(tabId);
  // 已纳管的子 session(如 network capture 先开时 attach 的)补注 UI binding/脚本。
  await rearmChildSessions(tabId);
}

export async function readUiCapture(tabId: number, filter?: CaptureFrameFilter): Promise<{ events: UserActionEvent[]; dropped: number }> {
  const state = uiCaptures.get(tabId);
  if (!state) return { events: [], dropped: 0 };
  let events = state.events.slice();
  // embedded_iframe:UI actions 同样过滤(顶层 dashboard 的 click 不能混进 iframe 内操作时间线)。
  if (filter) {
    const r = applyFrameFilter(tabId, events, filter);
    if (r.resolve.kind === 'ambiguous') throw new AmbiguousIframeTargetError(r.resolve.candidates.length);
    events = r.items;
  }
  const out = { events, dropped: state.dropped };
  state.events = [];
  state.dropped = 0;
  return out;
}

// ── Navigation Fetch guard (M1 P0-1) ────────────────────────────────────────
// Arms chrome.debugger Fetch interception on a tab BEFORE navigation so that the
// initial main-frame request and every redirect/secondary main-frame request is
// re-checked against URL policy before it is sent. failRequest keeps a forbidden
// target at 0 received bytes (ADR-0002 / ADR-0006, ip-observed-only tier — DNS
// rebinding is NOT closed here, the SW has no resolver).
//
// The policy predicate is injected so this module stays decoupled from url-policy.
// One global Fetch.requestPaused/Network.responseReceived listener is registered
// lazily and routes by tabId via fetchGuards.

type FetchGuardState = {
  /** returns true to allow (continueRequest), false to block (failRequest). */
  allow: (url: string) => boolean;
  blocked: string[];
  observedIps: string[];
};

const fetchGuards = new Map<number, FetchGuardState>();
let fetchListenerRegistered = false;

function ensureFetchListener(): void {
  if (fetchListenerRegistered) return;
  fetchListenerRegistered = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (!tabId) return;
    const guard = fetchGuards.get(tabId);
    if (!guard) return;
    const p = params as Record<string, any> | undefined;

    if (method === 'Fetch.requestPaused') {
      const requestId = p?.requestId as string;
      const url = (p?.request?.url as string) ?? '';
      const resourceType = p?.resourceType as string | undefined;
      // Only enforce on top-level documents; let sub-resources through unmodified.
      if (resourceType !== 'Document') {
        chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId }).catch(() => {});
        return;
      }
      if (guard.allow(url)) {
        chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId }).catch(() => {});
      } else {
        guard.blocked.push(url);
        chrome.debugger.sendCommand({ tabId }, 'Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      }
      return;
    }

    if (method === 'Network.responseReceived') {
      const ip = p?.response?.remoteIPAddress as string | undefined;
      if (ip) guard.observedIps.push(ip); // logged only — not a security boundary
    }
  });
}

/**
 * Arm Fetch before-send interception on a tab. Throws if attach or Fetch.enable
 * fails — callers MUST treat a throw as "interception unavailable" and refuse to
 * navigate (fail-closed). Returns the guard state for later inspection.
 */
export async function armFetchGuard(
  tabId: number,
  allow: (url: string) => boolean,
  aggressiveRetry: boolean = false,
): Promise<FetchGuardState> {
  await ensureAttached(tabId, aggressiveRetry);
  ensureFetchListener();
  const state: FetchGuardState = { allow, blocked: [], observedIps: [] };
  fetchGuards.set(tabId, state);
  try {
    // Network domain enables remoteIPAddress observation (ip-observed-only).
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable').catch(() => {});
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
    });
  } catch (e) {
    fetchGuards.delete(tabId);
    throw e;
  }
  return state;
}

export function getFetchGuard(tabId: number): FetchGuardState | undefined {
  return fetchGuards.get(tabId);
}

/** Disable Fetch interception and drop guard state. Idempotent. */
export async function disposeFetchGuard(tabId: number): Promise<void> {
  if (!fetchGuards.has(tabId)) return;
  fetchGuards.delete(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable').catch(() => {});
}

function clearFrameTargetsForTab(tabId: number): void {
  for (const [key, targetId] of [...frameTargets.entries()]) {
    if (!key.startsWith(`${tabId}:`)) continue;
    frameTargets.delete(key);
    frameTargetKeys.delete(targetId);
    chrome.debugger.detach({ targetId } as chrome.debugger.Debuggee).catch(() => {});
  }
}

// OOPIF:清掉某 tab 下所有子 session 内存状态(root detach 通常级联释放子 session,
// 但状态不靠浏览器回调兜底,显式清)。bump generation 让在飞的 rearm 循环停手。
function clearChildSessionsForTab(tabId: number): void {
  tabCaptureGeneration.set(tabId, (tabCaptureGeneration.get(tabId) ?? 0) + 1);
  const states = armedChildSessions.get(tabId);
  if (states) {
    for (const sid of states.keys()) { sessionToTab.delete(sid); sessionToFrameUrl.delete(sid); sessionToParent.delete(sid); }
    armedChildSessions.delete(tabId);
  }
}

export async function detach(tabId: number): Promise<void> {
  // 无条件清所有内存状态(即便 attached 缓存已失效,也不能留 capture/frame/child 残留)。
  clearFrameTargetsForTab(tabId);
  clearChildSessionsForTab(tabId);
  networkCaptures.delete(tabId);
  uiCaptures.delete(tabId);
  fetchGuards.delete(tabId);
  tabFrameContexts.delete(tabId);
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
}

export function registerListeners(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
    networkCaptures.delete(tabId);
  uiCaptures.delete(tabId);
    fetchGuards.delete(tabId);
    tabFrameContexts.delete(tabId);
    clearFrameTargetsForTab(tabId);
    clearChildSessionsForTab(tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) {
      attached.delete(source.tabId);
      networkCaptures.delete(source.tabId);
      uiCaptures.delete(source.tabId);
      fetchGuards.delete(source.tabId);
      tabFrameContexts.delete(source.tabId);
      clearFrameTargetsForTab(source.tabId);
      clearChildSessionsForTab(source.tabId);
      return;
    }
    if (source.targetId) clearFrameTarget(source.targetId);
  });
  // Invalidate attached cache when tab URL changes to non-debuggable
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.url && !isDebuggableUrl(info.url)) {
      await detach(tabId);
    }
  });
  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    // OOPIF:flat autoAttach 出来的 iframe 子 session 纳管(source 是父 session)。
    if (method === 'Target.attachedToTarget') {
      const ap = params as { sessionId?: string; targetInfo?: { type?: string; url?: string } } | undefined;
      const childSessionId = ap?.sessionId;
      const parentTabId = source.tabId;
      if (!childSessionId || !parentTabId) return;
      if (ap?.targetInfo?.type !== 'iframe') {
        // 非 iframe 子 target 也要放行,否则 waitForDebuggerOnStart 卡住它。
        await sendSafe(childDebuggee(parentTabId, childSessionId), 'Runtime.runIfWaitingForDebugger', {});
        return;
      }
      // iframe 文档 URL:从 targetInfo 显式记录(脱敏),供 network entry / UI event 标来源。
      if (typeof ap.targetInfo.url === 'string') {
        sessionToFrameUrl.set(childSessionId, maskUrlAuthTokens(ap.targetInfo.url));
      }
      // 父 session:顶层 attach 的 iframe 父为 undefined(记 ''=top);嵌套 OOPIF 父为外层 iframe 的 session。
      sessionToParent.set(childSessionId, sessionIdOf(source) ?? '');
      await armChildSession(parentTabId, childSessionId);
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const dp = params as { sessionId?: string } | undefined;
      const sid = dp?.sessionId; // 主字段是 sessionId(targetId 已 deprecated)
      if (sid) {
        const owner = sessionToTab.get(sid);
        sessionToTab.delete(sid);
        sessionToFrameUrl.delete(sid);
        sessionToParent.delete(sid);
        if (owner !== undefined) armedChildSessions.get(owner)?.delete(sid);
      }
      return;
    }
    // OOPIF 在文档导航完成前就 attach,attachedToTarget 那刻 targetInfo.url 常为空。
    // 文档落地后 Chrome 发 targetInfoChanged 带真实 URL → 回填 sessionToFrameUrl,让目标 frame 精确匹配/ambiguous 可用。
    if (method === 'Target.targetInfoChanged') {
      const cp = params as { targetInfo?: { type?: string; url?: string } } | undefined;
      const ti = cp?.targetInfo;
      // flat 模型下该事件的子 session id 在 source 上(顶层 targetInfoChanged 无 sessionId,跳过)。
      const sid = sessionIdOf(source);
      if (sid && ti?.type === 'iframe' && typeof ti.url === 'string' && ti.url) {
        sessionToFrameUrl.set(sid, maskUrlAuthTokens(ti.url));
      }
      return;
    }

    // flat 模型下子 session 事件 source.tabId 仍是父 tab;销毁竞态缺 tabId 时用 sessionToTab 兜底。
    const eventSessionId = sessionIdOf(source);
    const tabId = source.tabId
      ?? (eventSessionId ? sessionToTab.get(eventSessionId) : undefined);
    if (!tabId) return;
    const sessionId = eventSessionId;
    // UI 录制(M-UI-1):注入脚本调 window.__bycli_ui → Runtime.bindingCalled。先于 network 守卫处理。
    if (method === 'Runtime.bindingCalled') {
      const bp = params as { name?: string; payload?: string } | undefined;
      if (bp?.name === UI_BINDING_NAME) {
        const ui = uiCaptures.get(tabId);
        if (ui) {
          const ev = parseUiEvent(String(bp.payload ?? ''));
          if (ev) {
            // OOPIF:标注事件来源子 session(顶层事件无 sessionId),供下游区分 iframe 内操作。
            if (sessionId) {
              ev.frameSessionId = sessionId;
              const fu = sessionToFrameUrl.get(sessionId); if (fu) ev.frameUrl = fu;
            }
            if (ui.events.length < MAX_UI_EVENTS) ui.events.push(ev);
            else ui.dropped++; // ring-cap 满 → 丢弃 + 计数(背压,Codex F3)
          }
        }
      }
      return;
    }
    const state = networkCaptures.get(tabId);
    if (!state) return;
    const eventParams = params as Record<string, any> | undefined;

    if (method === 'Network.requestWillBeSent') {
      // 只收 Fetch/XHR(DevTools Network「Fetch/XHR」同款过滤);静态资源直接丢弃。
      if (!isApiResourceType(eventParams?.type)) return;
      const requestId = String(eventParams?.requestId || '');
      const request = eventParams?.request as {
        url?: string;
        method?: string;
        headers?: Record<string, unknown>;
        postData?: string;
        hasPostData?: boolean;
      } | undefined;
      const entry = getOrCreateNetworkCaptureEntry(tabId, reqKey(sessionId, requestId), {
        url: maskUrlAuthTokens(request?.url),
        method: request?.method,
        requestHeaders: normalizeHeaders(request?.headers),
      });
      if (!entry) return;
      if (typeof eventParams?.type === 'string') entry.resourceType = eventParams.type;
      // M-UI-3:记 initiator 类型 + frameId(因果对齐用;只取 type,不取 JS stack——避免体积/隐私)。
      const initiator = eventParams?.initiator as { type?: string } | undefined;
      if (initiator?.type) entry.initiatorType = initiator.type;
      const frameId = eventParams?.frameId;
      if (typeof frameId === 'string') entry.frameId = frameId;
      // OOPIF:标注来源子 session(顶层无),供因果对齐强约束区分 iframe↔顶层。
      if (sessionId) entry.frameSessionId = sessionId;
      if (sessionId) { const fu = sessionToFrameUrl.get(sessionId); if (fu) entry.frameUrl = fu; }
      entry.requestBodyKind = request?.hasPostData ? 'string' : 'empty';
      {
        const raw = String(request?.postData || '');
        const fullSize = raw.length;
        const truncated = fullSize > CDP_REQUEST_BODY_CAPTURE_LIMIT;
        entry.requestBodyPreview = truncated ? raw.slice(0, CDP_REQUEST_BODY_CAPTURE_LIMIT) : raw;
        entry.requestBodyFullSize = fullSize;
        entry.requestBodyTruncated = truncated;
      }
      try {
        // follow-up 必须发给产生该 requestId 的同一 session(子 frame 用 {tabId,sessionId})。
        const postData = await chrome.debugger.sendCommand(source, 'Network.getRequestPostData', { requestId }) as { postData?: string };
        if (postData?.postData) {
          const raw = postData.postData;
          const fullSize = raw.length;
          const truncated = fullSize > CDP_REQUEST_BODY_CAPTURE_LIMIT;
          entry.requestBodyKind = 'string';
          entry.requestBodyPreview = truncated ? raw.slice(0, CDP_REQUEST_BODY_CAPTURE_LIMIT) : raw;
          entry.requestBodyFullSize = fullSize;
          entry.requestBodyTruncated = truncated;
        }
      } catch {
        // Optional; some requests do not expose postData.
      }
      return;
    }

    if (method === 'Network.responseReceived') {
      const requestId = String(eventParams?.requestId || '');
      const response = eventParams?.response as {
        url?: string;
        mimeType?: string;
        status?: number;
        headers?: Record<string, unknown>;
      } | undefined;
      // 只富化 requestWillBeSent 已建的 Fetch/XHR entry;静态资源无 entry → 跳过(不补建)。
      const stateEntryIndex = state.requestToIndex.get(reqKey(sessionId, requestId));
      if (stateEntryIndex === undefined) return;
      const entry = state.entries[stateEntryIndex];
      if (!entry) return;
      entry.responseStatus = response?.status;
      entry.responseContentType = response?.mimeType || '';
      entry.responseHeaders = normalizeHeaders(response?.headers);
      return;
    }

    if (method === 'Network.loadingFinished') {
      const requestId = String(eventParams?.requestId || '');
      const stateEntryIndex = state.requestToIndex.get(reqKey(sessionId, requestId));
      if (stateEntryIndex === undefined) return;
      const entry = state.entries[stateEntryIndex];
      if (!entry) return;
      try {
        // follow-up body 必须发给同一 session(子 frame 用 {tabId,sessionId})。
        const body = await chrome.debugger.sendCommand(source, 'Network.getResponseBody', { requestId }) as {
          body?: string;
          base64Encoded?: boolean;
        };
        if (typeof body?.body === 'string') {
          const fullSize = body.body.length;
          const truncated = fullSize > CDP_RESPONSE_BODY_CAPTURE_LIMIT;
          const stored = truncated ? body.body.slice(0, CDP_RESPONSE_BODY_CAPTURE_LIMIT) : body.body;
          entry.responsePreview = body.base64Encoded ? `base64:${stored}` : stored;
          entry.responseBodyFullSize = fullSize;
          entry.responseBodyTruncated = truncated;
        }
      } catch {
        // Optional; bodies are unavailable for some requests (e.g. uploads).
      }
      return;
    }

    // ── WebSocket(kind='cdp-websocket'):握手 + 数据帧 ───────────────────────
    // WS 走专用 Network.webSocket* 事件(不发 requestWillBeSent/responseReceived),
    // 故上面的 Fetch/XHR 过滤不影响它;每个连接一条 entry,帧累积到 webSocketFrames。
    if (method === 'Network.webSocketCreated') {
      const requestId = String(eventParams?.requestId || '');
      const wsEntry = getOrCreateNetworkCaptureEntry(
        tabId,
        reqKey(sessionId, requestId),
        { url: maskUrlAuthTokens(eventParams?.url as string | undefined), method: 'GET' },
        'cdp-websocket',
      );
      if (wsEntry) wsEntry.resourceType = 'WebSocket';
      if (wsEntry && sessionId) {
        wsEntry.frameSessionId = sessionId; // OOPIF 来源标注
        const fu = sessionToFrameUrl.get(sessionId); if (fu) wsEntry.frameUrl = fu;
      }
      return;
    }

    if (method === 'Network.webSocketHandshakeResponseReceived') {
      const requestId = String(eventParams?.requestId || '');
      const idx = state.requestToIndex.get(reqKey(sessionId, requestId));
      if (idx === undefined) return;
      const entry = state.entries[idx];
      if (!entry) return;
      const response = eventParams?.response as { status?: number; headers?: Record<string, unknown> } | undefined;
      entry.responseStatus = response?.status ?? 101;
      entry.responseHeaders = normalizeHeaders(response?.headers);
      return;
    }

    if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
      const requestId = String(eventParams?.requestId || '');
      const idx = state.requestToIndex.get(reqKey(sessionId, requestId));
      if (idx === undefined) return;
      const entry = state.entries[idx];
      if (!entry) return;
      const frame = eventParams?.response as { opcode?: number; payloadData?: string } | undefined;
      const opcode = typeof frame?.opcode === 'number' ? frame.opcode : -1;
      // 只收数据帧(1=text、2=binary);丢弃 control 帧(8 close / 9 ping / 10 pong)。
      if (opcode !== 1 && opcode !== 2) return;
      if (!entry.webSocketFrames) entry.webSocketFrames = [];
      if (entry.webSocketFrames.length >= MAX_WS_FRAMES_PER_CONN) {
        entry.webSocketFramesDropped = (entry.webSocketFramesDropped ?? 0) + 1;
        return;
      }
      const raw = String(frame?.payloadData ?? '');
      const fullSize = raw.length;
      const truncated = fullSize > CDP_WS_FRAME_CAPTURE_LIMIT;
      const stored = truncated ? raw.slice(0, CDP_WS_FRAME_CAPTURE_LIMIT) : raw;
      entry.webSocketFrames.push({
        direction: method === 'Network.webSocketFrameSent' ? 'sent' : 'received',
        opcode,
        payloadPreview: opcode === 2 ? `base64:${stored}` : stored,
        payloadFullSize: fullSize,
        payloadTruncated: truncated,
        timestamp: Date.now(),
      });
      return;
    }
  });
}
