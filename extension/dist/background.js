const DAEMON_PORT = 19825;
const DAEMON_HOST = "127.0.0.1";
const DAEMON_WS_URL = `ws://${DAEMON_HOST}:${DAEMON_PORT}/ext`;
const DAEMON_PING_URL = `http://${DAEMON_HOST}:${DAEMON_PORT}/ping`;
const WS_RECONNECT_BASE_DELAY = 2e3;
const WS_RECONNECT_MAX_DELAY = 5e3;

const AUTH_PARAM_SEGMENTS = /* @__PURE__ */ new Set([
  "token",
  "tokens",
  "jwt",
  "secret",
  "fingerprint",
  "signature",
  "sig",
  "sign",
  "csrf",
  "xsrf",
  "session",
  "sessionid",
  "sid",
  "password",
  "passwd",
  "pwd",
  "auth",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "appkey",
  "bearer",
  "credential",
  "credentials"
]);
const JWT_VALUE_RE = /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+$/;
const MASKED = "***";
function paramNameLooksAuth(name) {
  return name.toLowerCase().split(/[-_.]/).some((seg) => AUTH_PARAM_SEGMENTS.has(seg));
}
function maskUrlAuthTokens(url) {
  if (!url) return url ?? "";
  try {
    const u = new URL(url);
    let changed = false;
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (paramNameLooksAuth(k) || JWT_VALUE_RE.test(v)) {
        u.searchParams.set(k, MASKED);
        changed = true;
      }
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

const UI_BINDING_NAME = "__bycli_ui";
const MAX_UI_EVENTS = 2e3;
const ALLOWED_TYPES = ["click", "input", "submit", "keydown", "navigate"];
const clampStr = (v, max) => typeof v === "string" && v.length ? v.slice(0, max) : void 0;
function parseUiEvent(payload) {
  let raw;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const type = raw.type;
  if (!ALLOWED_TYPES.includes(type)) return null;
  const ts = typeof raw.ts === "number" && Number.isFinite(raw.ts) ? raw.ts : Date.now();
  if (type === "navigate") {
    const rawUrl = clampStr(raw.url, 2048);
    if (!rawUrl) return null;
    return { type, ts, selector: "", tag: "document", url: maskUrlAuthTokens(rawUrl).slice(0, 2048) };
  }
  const selector = clampStr(raw.selector, 300);
  if (!selector) return null;
  const ev = { type, ts, selector, tag: clampStr(raw.tag, 24) ?? "unknown" };
  const role = clampStr(raw.role, 40);
  if (role) ev.role = role;
  const text = clampStr(raw.text, 80);
  if (text) ev.text = text;
  const key = clampStr(raw.key, 24);
  if (key) ev.key = key;
  const vs = raw.valueShape;
  if (vs && typeof vs.len === "number" && Number.isFinite(vs.len)) {
    const kind = vs.kind;
    const k = kind === "email" || kind === "url" || kind === "number" ? kind : "text";
    ev.valueShape = { len: Math.max(0, Math.min(1e5, Math.floor(vs.len))), kind: k };
  }
  return ev;
}
const UI_LISTENER_SOURCE = `(function(){
  if (window.__bycli_ui_installed) return; window.__bycli_ui_installed = true;
  var B = ${JSON.stringify(UI_BINDING_NAME)};
  function esc(s){ try { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&'); } catch(e){ return String(s); } }
  function sel(el){
    if(!el||el.nodeType!==1) return '';
    if(el.id) return '#'+esc(el.id);
    var dt = el.getAttribute && el.getAttribute('data-testid'); if(dt) return '[data-testid="'+dt+'"]';
    var parts=[], n=el, depth=0;
    while(n && n.nodeType===1 && depth<5){
      if(n.id){ parts.unshift('#'+esc(n.id)); break; }
      var part=n.tagName.toLowerCase(), p=n.parentElement;
      if(p){ var same=[]; for(var i=0;i<p.children.length;i++){ if(p.children[i].tagName===n.tagName) same.push(p.children[i]); }
        if(same.length>1) part+=':nth-of-type('+(same.indexOf(n)+1)+')'; }
      parts.unshift(part); n=n.parentElement; depth++;
    }
    return parts.join(' > ');
  }
  function tag(el){ return el && el.tagName ? el.tagName.toLowerCase() : 'unknown'; }
  function txt(el){ try { var t=(el.innerText||el.textContent||'').trim(); return t ? t.slice(0,80) : undefined; } catch(e){ return undefined; } }
  function shape(v){ v=String(v==null?'':v); var kind='text';
    if(/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v)) kind='email';
    else if(/^https?:\\/\\//.test(v)) kind='url';
    else if(v!=='' && !isNaN(Number(v))) kind='number';
    return { len: v.length, kind: kind }; }
  function emit(o){ try { o.ts=Date.now(); if(typeof window[B]==='function') window[B](JSON.stringify(o)); } catch(e){} }
  document.addEventListener('click', function(e){ var t=e.target; emit({ type:'click', selector:sel(t), tag:tag(t), role:(t.getAttribute&&t.getAttribute('role'))||undefined, text:txt(t) }); }, { capture:true, passive:true });
  document.addEventListener('change', function(e){ var t=e.target; if(!t||!('value' in t)) return;
    if(t.type==='password'){ emit({ type:'input', selector:sel(t), tag:tag(t) }); return; }
    emit({ type:'input', selector:sel(t), tag:tag(t), valueShape:shape(t.value) }); }, { capture:true, passive:true });
  document.addEventListener('submit', function(e){ emit({ type:'submit', selector:sel(e.target), tag:'form' }); }, { capture:true, passive:true });
  document.addEventListener('keydown', function(e){ if(e.key==='Enter'||e.key==='Escape'){ emit({ type:'keydown', selector:sel(e.target), tag:tag(e.target), key:e.key }); } }, { capture:true, passive:true });
  // 导航录制:整页导航(脚本随新文档重注入,init 即发当前 URL)+ SPA 路由(history/popstate/hashchange)。
  // dedupe 连续相同 URL,避免 replaceState 刷参噪音;脱敏在扩展 parse 侧再做一道,这里只发原始 location.href。
  var lastUrl='';
  function navEmit(){ try { var u=location.href; if(u&&u!==lastUrl){ lastUrl=u; emit({ type:'navigate', url:u }); } } catch(e){} }
  navEmit();
  try { var _ps=history.pushState; history.pushState=function(){ var r=_ps.apply(this,arguments); navEmit(); return r; }; } catch(e){}
  try { var _rs=history.replaceState; history.replaceState=function(){ var r=_rs.apply(this,arguments); navEmit(); return r; }; } catch(e){}
  window.addEventListener('popstate', navEmit, { passive:true });
  window.addEventListener('hashchange', navEmit, { passive:true });
})();`;

const attached = /* @__PURE__ */ new Set();
const tabFrameContexts = /* @__PURE__ */ new Map();
const frameTargets = /* @__PURE__ */ new Map();
const frameTargetKeys = /* @__PURE__ */ new Map();
let frameTargetCleanupRegistered = false;
const sessionToTab = /* @__PURE__ */ new Map();
const sessionToFrameUrl = /* @__PURE__ */ new Map();
const sessionToParent = /* @__PURE__ */ new Map();
const armedChildSessions = /* @__PURE__ */ new Map();
const MAX_CHILD_SESSIONS_PER_TAB = 50;
const tabCaptureGeneration = /* @__PURE__ */ new Map();
function childStateMap(tabId) {
  let m = armedChildSessions.get(tabId);
  if (!m) {
    m = /* @__PURE__ */ new Map();
    armedChildSessions.set(tabId, m);
  }
  return m;
}
function childDebuggee(tabId, sessionId) {
  return { tabId, sessionId };
}
function sessionIdOf(source) {
  return source.sessionId;
}
async function sendSafe(target, method, params = {}) {
  try {
    await chrome.debugger.sendCommand(target, method, params);
    return true;
  } catch {
    return false;
  }
}
function reqKey(sessionId, requestId) {
  return `${sessionId ?? "top"}:${requestId}`;
}
const AUTO_ATTACH_IFRAME_PARAMS = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: "iframe", exclude: false }]
};
const CDP_RESPONSE_BODY_CAPTURE_LIMIT = 8 * 1024 * 1024;
const CDP_REQUEST_BODY_CAPTURE_LIMIT = 1 * 1024 * 1024;
const CDP_WS_FRAME_CAPTURE_LIMIT = 256 * 1024;
const MAX_WS_FRAMES_PER_CONN = 500;
const networkCaptures = /* @__PURE__ */ new Map();
const CAPTURE_RESOURCE_TYPES = /* @__PURE__ */ new Set(["XHR", "Fetch"]);
function isApiResourceType(type) {
  return typeof type === "string" && CAPTURE_RESOURCE_TYPES.has(type);
}
function isStaticAssetContentType(ct) {
  if (!ct) return false;
  const t = ct.toLowerCase().split(";")[0].trim();
  if (t.startsWith("image/") || t.startsWith("font/") || t.startsWith("audio/") || t.startsWith("video/")) return true;
  return t === "text/css" || t === "text/javascript" || t === "application/javascript" || t === "application/x-javascript" || t === "application/ecmascript" || t === "application/font-woff" || t === "application/font-woff2" || t === "application/x-font-ttf" || t === "application/vnd.ms-fontobject";
}
const uiCaptures = /* @__PURE__ */ new Map();
function isDebuggableUrl$1(url) {
  if (!url) return true;
  return url.startsWith("http://") || url.startsWith("https://") || url === "about:blank" || url.startsWith("data:");
}
async function ensureAttached(tabId, aggressiveRetry = false) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isDebuggableUrl$1(tab.url)) {
      attached.delete(tabId);
      throw new Error(`Cannot debug tab ${tabId}: URL is ${tab.url ?? "unknown"}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Cannot debug tab")) throw e;
    attached.delete(tabId);
    throw new Error(`Tab ${tabId} no longer exists`);
  }
  if (attached.has(tabId)) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "1",
        returnByValue: true
      });
      return;
    } catch {
      attached.delete(tabId);
    }
  }
  const MAX_ATTACH_RETRIES = aggressiveRetry ? 5 : 2;
  const RETRY_DELAY_MS = aggressiveRetry ? 1500 : 500;
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTACH_RETRIES; attempt++) {
    try {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
      }
      await chrome.debugger.attach({ tabId }, "1.3");
      lastError = "";
      break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_ATTACH_RETRIES) {
        console.warn(`[bycli] attach attempt ${attempt}/${MAX_ATTACH_RETRIES} failed: ${lastError}, retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        try {
          const tab = await chrome.tabs.get(tabId);
          if (!isDebuggableUrl$1(tab.url)) {
            lastError = `Tab URL changed to ${tab.url} during retry`;
            break;
          }
        } catch {
          lastError = `Tab ${tabId} no longer exists`;
        }
      }
    }
  }
  if (lastError) {
    let finalUrl = "unknown";
    let finalWindowId = "unknown";
    try {
      const tab = await chrome.tabs.get(tabId);
      finalUrl = tab.url ?? "undefined";
      finalWindowId = String(tab.windowId);
    } catch {
    }
    console.warn(`[bycli] attach failed for tab ${tabId}: url=${finalUrl}, windowId=${finalWindowId}, error=${lastError}`);
    const hint = lastError.includes("chrome-extension://") ? ". Tip: another Chrome extension may be interfering — try disabling other extensions" : "";
    throw new Error(`attach failed: ${lastError}${hint}`);
  }
  attached.add(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  } catch {
  }
}
async function evaluate(tabId, expression, aggressiveRetry = false) {
  const MAX_EVAL_RETRIES = aggressiveRetry ? 3 : 2;
  for (let attempt = 1; attempt <= MAX_EVAL_RETRIES; attempt++) {
    try {
      await ensureAttached(tabId, aggressiveRetry);
      const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (result.exceptionDetails) {
        const errMsg = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Eval error";
        throw new Error(errMsg);
      }
      return result.result?.value;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isNavigateError = msg.includes("Inspected target navigated") || msg.includes("Target closed");
      const isAttachError = isNavigateError || msg.includes("attach failed") || msg.includes("Debugger is not attached") || msg.includes("chrome-extension://");
      if (isAttachError && attempt < MAX_EVAL_RETRIES) {
        attached.delete(tabId);
        const retryMs = isNavigateError ? 200 : 500;
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        continue;
      }
      throw e;
    }
  }
  throw new Error("evaluate: max retries exhausted");
}
const evaluateAsync = evaluate;
async function screenshot(tabId, options = {}) {
  await ensureAttached(tabId);
  const format = options.format ?? "png";
  const fullPage = options.fullPage === true;
  const overrideWidth = options.width && options.width > 0 ? Math.ceil(options.width) : void 0;
  const overrideHeight = !fullPage && options.height && options.height > 0 ? Math.ceil(options.height) : void 0;
  const needsOverride = fullPage || overrideWidth !== void 0 || overrideHeight !== void 0;
  if (needsOverride) {
    if (overrideWidth !== void 0 && fullPage) {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
        mobile: false,
        width: overrideWidth,
        height: 0,
        deviceScaleFactor: 1
      });
    }
    let finalWidth = overrideWidth ?? 0;
    let finalHeight = overrideHeight ?? 0;
    if (fullPage) {
      const metrics = await chrome.debugger.sendCommand({ tabId }, "Page.getLayoutMetrics");
      const size = metrics.cssContentSize || metrics.contentSize;
      if (size) {
        if (finalWidth === 0) finalWidth = Math.ceil(size.width);
        finalHeight = Math.ceil(size.height);
      }
    }
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
      mobile: false,
      width: finalWidth,
      height: finalHeight,
      deviceScaleFactor: 1
    });
  }
  try {
    const params = { format };
    if (format === "jpeg" && options.quality !== void 0) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }
    const result = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", params);
    return result.data;
  } finally {
    if (needsOverride) {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride").catch(() => {
      });
    }
  }
}
async function setFileInputFiles(tabId, files, selector) {
  await ensureAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
  const doc = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument");
  const query = selector || 'input[type="file"]';
  const result = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: query
  });
  if (!result.nodeId) {
    throw new Error(`No element found matching selector: ${query}`);
  }
  await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
    files,
    nodeId: result.nodeId
  });
}
function matchesDownloadPattern(item, pattern) {
  if (!pattern) return true;
  const haystack = [
    item.filename,
    item.url,
    item.finalUrl,
    item.mime
  ].filter(Boolean).join("\n").toLowerCase();
  return haystack.includes(pattern.toLowerCase());
}
function downloadResult(item, startedAt) {
  return {
    downloaded: item.state === "complete",
    id: item.id,
    filename: item.filename,
    url: item.url,
    finalUrl: item.finalUrl,
    mime: item.mime,
    totalBytes: item.totalBytes,
    state: item.state,
    danger: item.danger,
    error: item.error,
    elapsedMs: Date.now() - startedAt
  };
}
async function waitForDownload(pattern = "", timeoutMs = 3e4) {
  const startedAt = Date.now();
  const timeout = Math.max(1, timeoutMs);
  return await new Promise((resolve) => {
    let done = false;
    const inProgressIds = /* @__PURE__ */ new Set();
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(result);
    };
    const inspectById = async (id) => {
      const items = await chrome.downloads.search({ id });
      const item = items[0];
      if (!item || !matchesDownloadPattern(item, pattern)) return;
      inProgressIds.add(id);
      if (item.state === "complete" || item.state === "interrupted") finish(downloadResult(item, startedAt));
    };
    const onCreated = (item) => {
      if (!matchesDownloadPattern(item, pattern)) return;
      inProgressIds.add(item.id);
      if (item.state === "complete" || item.state === "interrupted") finish(downloadResult(item, startedAt));
    };
    const onChanged = (delta) => {
      if (!delta.id) return;
      if (!inProgressIds.has(delta.id) && !delta.filename && !delta.url) return;
      if (delta.filename?.current || delta.url?.current) {
        void inspectById(delta.id);
        return;
      }
      if (delta.state?.current === "complete" || delta.state?.current === "interrupted") {
        void inspectById(delta.id);
      }
    };
    const timer = setTimeout(() => {
      finish({
        downloaded: false,
        state: "interrupted",
        error: `No download matched "${pattern || "*"}" within ${timeout}ms`,
        elapsedMs: Date.now() - startedAt
      });
    }, timeout);
    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
    void chrome.downloads.search({
      limit: 50,
      orderBy: ["-startTime"],
      startedAfter: new Date(startedAt - Math.max(timeout, 1e3)).toISOString()
    }).then((recent) => {
      if (done) return;
      const completed = recent.find((item) => item.state === "complete" && matchesDownloadPattern(item, pattern));
      if (completed) {
        finish(downloadResult(completed, startedAt));
        return;
      }
      for (const item of recent) {
        if (item.state === "in_progress" && matchesDownloadPattern(item, pattern)) inProgressIds.add(item.id);
      }
    }).catch((err) => {
      finish({
        downloaded: false,
        state: "interrupted",
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - startedAt
      });
    });
  });
}
function frameTargetKey(tabId, frameId) {
  return `${tabId}:${frameId}`;
}
function registerFrameTargetCleanup() {
  if (frameTargetCleanupRegistered) return;
  frameTargetCleanupRegistered = true;
  chrome.debugger.onEvent.addListener((_source, method, params) => {
    if (method === "Target.detachedFromTarget") {
      const targetId = String(params?.targetId || "");
      clearFrameTarget(targetId);
    }
  });
}
function clearFrameTarget(targetId) {
  if (!targetId) return;
  const key = frameTargetKeys.get(targetId);
  if (key) frameTargets.delete(key);
  frameTargetKeys.delete(targetId);
}
async function ensureFrameTarget(tabId, frameId, aggressiveRetry = false, targetUrl) {
  registerFrameTargetCleanup();
  await ensureAttached(tabId, aggressiveRetry);
  const key = frameTargetKey(tabId, frameId);
  const existing = frameTargets.get(key);
  if (existing) return existing;
  await chrome.debugger.sendCommand({ tabId }, "Target.setDiscoverTargets", { discover: true }).catch(() => {
  });
  const captureActive = networkCaptures.has(tabId) || uiCaptures.has(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: captureActive,
    flatten: true,
    filter: [{ type: "iframe", exclude: false }]
  }).catch(() => {
  });
  const targetId = await resolveFrameTargetId(tabId, frameId, targetUrl);
  try {
    await chrome.debugger.attach({ targetId }, "1.3");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("Another debugger is already attached")) throw err;
  }
  frameTargets.set(key, targetId);
  frameTargetKeys.set(targetId, key);
  return targetId;
}
async function resolveFrameTargetId(tabId, frameId, targetUrl) {
  const result = await chrome.debugger.sendCommand({ tabId }, "Target.getTargets").catch(() => null);
  const targets = result?.targetInfos ?? [];
  const frameTarget = targets.find((candidate) => {
    const candidateId = candidate.targetId || candidate.id;
    return candidate.type === "iframe" && (candidateId === frameId || !!targetUrl && candidate.url === targetUrl);
  });
  const targetId = frameTarget?.targetId || frameTarget?.id;
  if (targetId) return targetId;
  const candidates = targets.filter((target) => target.type === "iframe").map((target) => `${target.targetId || target.id || "?"} ${target.url || ""}`).join("; ");
  throw new Error(`No iframe target found for frame ${frameId}${targetUrl ? ` (${targetUrl})` : ""}. Candidates: ${candidates || "none"}`);
}
async function sendCommandInFrameTarget(tabId, frameId, method, params = {}, aggressiveRetry = false, _timeoutMs = 3e4, targetUrl) {
  const targetId = await ensureFrameTarget(tabId, frameId, aggressiveRetry, targetUrl);
  const target = { targetId };
  return chrome.debugger.sendCommand(target, method, params);
}
async function insertText(tabId, text) {
  await ensureAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text });
}
function registerFrameTracking() {
  registerFrameTargetCleanup();
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (!tabId) return;
    if (sessionIdOf(source)) return;
    if (method === "Runtime.executionContextCreated") {
      const context = params.context;
      if (!context?.auxData?.frameId || context.auxData.isDefault !== true) return;
      const frameId = context.auxData.frameId;
      if (!tabFrameContexts.has(tabId)) {
        tabFrameContexts.set(tabId, /* @__PURE__ */ new Map());
      }
      tabFrameContexts.get(tabId).set(frameId, context.id);
    }
    if (method === "Runtime.executionContextDestroyed") {
      const ctxId = params.executionContextId;
      const contexts = tabFrameContexts.get(tabId);
      if (contexts) {
        for (const [fid, cid] of contexts) {
          if (cid === ctxId) {
            contexts.delete(fid);
            break;
          }
        }
      }
    }
    if (method === "Runtime.executionContextsCleared") {
      tabFrameContexts.delete(tabId);
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabFrameContexts.delete(tabId);
  });
}
async function getFrameTree(tabId) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree");
}
async function evaluateInFrame(tabId, expression, frameId, aggressiveRetry = false) {
  await ensureAttached(tabId, aggressiveRetry);
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable").catch(() => {
  });
  const contexts = tabFrameContexts.get(tabId);
  const contextId = contexts?.get(frameId);
  if (contextId === void 0) {
    await sendCommandInFrameTarget(tabId, frameId, "Runtime.enable", {}, aggressiveRetry).catch(() => void 0);
    const result2 = await sendCommandInFrameTarget(tabId, frameId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, aggressiveRetry);
    if (result2.exceptionDetails) {
      const errMsg = result2.exceptionDetails.exception?.description || result2.exceptionDetails.text || "Eval error";
      throw new Error(errMsg);
    }
    return result2.result?.value;
  }
  const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Eval error";
    throw new Error(errMsg);
  }
  return result.result?.value;
}
function normalizeCapturePatterns(pattern) {
  return String(pattern || "").split("|").map((part) => part.trim()).filter(Boolean);
}
function shouldCaptureUrl(url, patterns) {
  if (!url) return false;
  if (!patterns.length) return true;
  return patterns.some((pattern) => url.includes(pattern));
}
function normalizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[String(key)] = String(value);
  }
  return out;
}
function getOrCreateNetworkCaptureEntry(tabId, key, fallback, kind = "cdp") {
  const state = networkCaptures.get(tabId);
  if (!state) return null;
  const existingIndex = state.requestToIndex.get(key);
  if (existingIndex !== void 0) {
    return state.entries[existingIndex] || null;
  }
  const url = fallback?.url || "";
  if (!shouldCaptureUrl(url, state.patterns)) return null;
  const entry = {
    kind,
    url,
    method: fallback?.method || "GET",
    requestHeaders: fallback?.requestHeaders || {},
    timestamp: Date.now()
  };
  state.entries.push(entry);
  state.requestToIndex.set(key, state.entries.length - 1);
  return entry;
}
async function armChildSession(tabId, sessionId) {
  const states = childStateMap(tabId);
  let st = states.get(sessionId);
  const isNew = st === void 0;
  if (isNew && states.size >= MAX_CHILD_SESSIONS_PER_TAB) {
    states.set(sessionId, { autoAttach: false, network: false, ui: false, overCap: true });
    sessionToTab.set(sessionId, tabId);
    await sendSafe(childDebuggee(tabId, sessionId), "Runtime.runIfWaitingForDebugger", {});
    return;
  }
  if (!st) {
    st = { autoAttach: false, network: false, ui: false, overCap: false };
    states.set(sessionId, st);
  }
  if (st.overCap) return;
  sessionToTab.set(sessionId, tabId);
  const child = childDebuggee(tabId, sessionId);
  try {
    if (!st.autoAttach) {
      if (await sendSafe(child, "Target.setAutoAttach", { ...AUTO_ATTACH_IFRAME_PARAMS })) st.autoAttach = true;
    }
    if (networkCaptures.has(tabId) && !st.network) {
      if (await sendSafe(child, "Network.enable", {})) st.network = true;
    }
    if (uiCaptures.has(tabId) && !st.ui) {
      const ok = await sendSafe(child, "Runtime.enable", {}) && await sendSafe(child, "Page.enable", {}) && await sendSafe(child, "Runtime.addBinding", { name: UI_BINDING_NAME }) && await sendSafe(child, "Page.addScriptToEvaluateOnNewDocument", { source: UI_LISTENER_SOURCE });
      await sendSafe(child, "Runtime.evaluate", { expression: UI_LISTENER_SOURCE });
      if (ok) st.ui = true;
    }
  } finally {
    if (isNew) await sendSafe(child, "Runtime.runIfWaitingForDebugger", {});
  }
}
async function rearmChildSessions(tabId) {
  const states = armedChildSessions.get(tabId);
  if (!states) return;
  const gen = tabCaptureGeneration.get(tabId) ?? 0;
  for (const sessionId of [...states.keys()]) {
    if ((tabCaptureGeneration.get(tabId) ?? 0) !== gen) return;
    if (armedChildSessions.get(tabId) !== states) return;
    if (!states.has(sessionId)) continue;
    await armChildSession(tabId, sessionId);
  }
}
async function enableIframeAutoAttach(tabId) {
  await sendSafe({ tabId }, "Target.setAutoAttach", { ...AUTO_ATTACH_IFRAME_PARAMS });
}
async function startNetworkCapture(tabId, pattern) {
  await ensureAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  networkCaptures.set(tabId, {
    patterns: normalizeCapturePatterns(pattern),
    entries: [],
    requestToIndex: /* @__PURE__ */ new Map()
  });
  await enableIframeAutoAttach(tabId);
  await rearmChildSessions(tabId);
}
async function readNetworkCapture(tabId, filter) {
  const state = networkCaptures.get(tabId);
  if (!state) return [];
  let entries = state.entries.filter(
    (e) => e.kind === "cdp-websocket" || !isStaticAssetContentType(e.responseContentType)
  );
  if (filter) {
    const r = applyFrameFilter(tabId, entries, filter);
    if (r.resolve.kind === "ambiguous") throw new AmbiguousIframeTargetError(r.resolve.candidates.length);
    entries = r.items;
  }
  state.entries = [];
  state.requestToIndex.clear();
  return entries;
}
class AmbiguousIframeTargetError extends Error {
  code = "ambiguous_iframe_target";
  constructor(count) {
    super(`ambiguous iframe target: ${count} candidate frames matched`);
  }
}
function normalizeUrlForMatch(raw) {
  try {
    const u = new URL(raw);
    const pathname = u.pathname.replace(/\/+$/, "") || "/";
    return { href: `${u.origin}${pathname}${u.search}`, origin: u.origin, pathname };
  } catch {
    return null;
  }
}
function resolveTargetFrameSessions(tabId, targetFrameUrl) {
  const target = normalizeUrlForMatch(maskUrlAuthTokens(targetFrameUrl));
  if (!target) return { kind: "none" };
  const states = armedChildSessions.get(tabId);
  if (!states || states.size === 0) return { kind: "none" };
  const candidates = [];
  for (const sid of states.keys()) {
    const frameUrl = sessionToFrameUrl.get(sid);
    if (!frameUrl) continue;
    candidates.push({ sid, norm: normalizeUrlForMatch(frameUrl) });
  }
  const exact = candidates.filter((c) => c.norm && c.norm.href === target.href);
  if (exact.length === 1) return { kind: "ok", sessionIds: collectDescendants(tabId, exact[0].sid) };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact.map((c) => c.sid) };
  const loose = candidates.filter((c) => c.norm && c.norm.origin === target.origin && c.norm.pathname === target.pathname);
  if (loose.length === 1) return { kind: "ok", sessionIds: collectDescendants(tabId, loose[0].sid) };
  if (loose.length > 1) return { kind: "ambiguous", candidates: loose.map((c) => c.sid) };
  const sameOrigin = candidates.filter((c) => c.norm && c.norm.origin === target.origin);
  if (sameOrigin.length === 1) return { kind: "ok", sessionIds: collectDescendants(tabId, sameOrigin[0].sid) };
  if (sameOrigin.length > 1) return { kind: "ambiguous", candidates: sameOrigin.map((c) => c.sid) };
  const all = /* @__PURE__ */ new Set();
  for (const sid of states.keys()) for (const d of collectDescendants(tabId, sid)) all.add(d);
  if (all.size > 0) return { kind: "ok", sessionIds: all };
  return { kind: "none" };
}
function collectDescendants(tabId, rootSid) {
  const out = /* @__PURE__ */ new Set([rootSid]);
  const states = armedChildSessions.get(tabId);
  if (!states) return out;
  let grew = true;
  while (grew) {
    grew = false;
    for (const sid of states.keys()) {
      if (out.has(sid)) continue;
      const parent = sessionToParent.get(sid);
      if (parent !== void 0 && out.has(parent)) {
        out.add(sid);
        grew = true;
      }
    }
  }
  return out;
}
function applyFrameFilter(tabId, items, filter) {
  const resolve = resolveTargetFrameSessions(tabId, filter.targetFrameUrl);
  if (resolve.kind !== "ok") return { items: [], resolve };
  const allow = resolve.sessionIds;
  return { items: items.filter((it) => it.frameSessionId !== void 0 && allow.has(it.frameSessionId)), resolve };
}
function hasActiveNetworkCapture(tabId) {
  return networkCaptures.has(tabId);
}
async function startUiCapture(tabId) {
  await ensureAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  await chrome.debugger.sendCommand({ tabId }, "Runtime.addBinding", { name: UI_BINDING_NAME });
  await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", { source: UI_LISTENER_SOURCE });
  try {
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: UI_LISTENER_SOURCE });
  } catch {
  }
  uiCaptures.set(tabId, { events: [], dropped: 0 });
  await enableIframeAutoAttach(tabId);
  await rearmChildSessions(tabId);
}
async function readUiCapture(tabId, filter) {
  const state = uiCaptures.get(tabId);
  if (!state) return { events: [], dropped: 0 };
  let events = state.events.slice();
  if (filter) {
    const r = applyFrameFilter(tabId, events, filter);
    if (r.resolve.kind === "ambiguous") throw new AmbiguousIframeTargetError(r.resolve.candidates.length);
    events = r.items;
  }
  const out = { events, dropped: state.dropped };
  state.events = [];
  state.dropped = 0;
  return out;
}
const fetchGuards = /* @__PURE__ */ new Map();
let fetchListenerRegistered = false;
function ensureFetchListener() {
  if (fetchListenerRegistered) return;
  fetchListenerRegistered = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (!tabId) return;
    const guard = fetchGuards.get(tabId);
    if (!guard) return;
    const p = params;
    if (method === "Fetch.requestPaused") {
      const requestId = p?.requestId;
      const url = p?.request?.url ?? "";
      const resourceType = p?.resourceType;
      if (resourceType !== "Document") {
        chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", { requestId }).catch(() => {
        });
        return;
      }
      if (guard.allow(url)) {
        chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", { requestId }).catch(() => {
        });
      } else {
        guard.blocked.push(url);
        chrome.debugger.sendCommand({ tabId }, "Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {
        });
      }
      return;
    }
    if (method === "Network.responseReceived") {
      const ip = p?.response?.remoteIPAddress;
      if (ip) guard.observedIps.push(ip);
    }
  });
}
async function armFetchGuard(tabId, allow, aggressiveRetry = false) {
  await ensureAttached(tabId, aggressiveRetry);
  ensureFetchListener();
  const state = { allow, blocked: [], observedIps: [] };
  fetchGuards.set(tabId, state);
  try {
    await chrome.debugger.sendCommand({ tabId }, "Network.enable").catch(() => {
    });
    await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", {
      patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }]
    });
  } catch (e) {
    fetchGuards.delete(tabId);
    throw e;
  }
  return state;
}
function clearFrameTargetsForTab(tabId) {
  for (const [key, targetId] of [...frameTargets.entries()]) {
    if (!key.startsWith(`${tabId}:`)) continue;
    frameTargets.delete(key);
    frameTargetKeys.delete(targetId);
    chrome.debugger.detach({ targetId }).catch(() => {
    });
  }
}
function clearChildSessionsForTab(tabId) {
  tabCaptureGeneration.set(tabId, (tabCaptureGeneration.get(tabId) ?? 0) + 1);
  const states = armedChildSessions.get(tabId);
  if (states) {
    for (const sid of states.keys()) {
      sessionToTab.delete(sid);
      sessionToFrameUrl.delete(sid);
      sessionToParent.delete(sid);
    }
    armedChildSessions.delete(tabId);
  }
}
async function detach(tabId) {
  clearFrameTargetsForTab(tabId);
  clearChildSessionsForTab(tabId);
  networkCaptures.delete(tabId);
  uiCaptures.delete(tabId);
  fetchGuards.delete(tabId);
  tabFrameContexts.delete(tabId);
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
  }
}
function registerListeners() {
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
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.url && !isDebuggableUrl$1(info.url)) {
      await detach(tabId);
    }
  });
  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    if (method === "Target.attachedToTarget") {
      const ap = params;
      const childSessionId = ap?.sessionId;
      const parentTabId = source.tabId;
      if (!childSessionId || !parentTabId) return;
      if (ap?.targetInfo?.type !== "iframe") {
        await sendSafe(childDebuggee(parentTabId, childSessionId), "Runtime.runIfWaitingForDebugger", {});
        return;
      }
      if (typeof ap.targetInfo.url === "string") {
        sessionToFrameUrl.set(childSessionId, maskUrlAuthTokens(ap.targetInfo.url));
      }
      sessionToParent.set(childSessionId, sessionIdOf(source) ?? "");
      await armChildSession(parentTabId, childSessionId);
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const dp = params;
      const sid = dp?.sessionId;
      if (sid) {
        const owner = sessionToTab.get(sid);
        sessionToTab.delete(sid);
        sessionToFrameUrl.delete(sid);
        sessionToParent.delete(sid);
        if (owner !== void 0) armedChildSessions.get(owner)?.delete(sid);
      }
      return;
    }
    if (method === "Target.targetInfoChanged") {
      const cp = params;
      const ti = cp?.targetInfo;
      const sid = sessionIdOf(source);
      if (sid && ti?.type === "iframe" && typeof ti.url === "string" && ti.url) {
        sessionToFrameUrl.set(sid, maskUrlAuthTokens(ti.url));
      }
      return;
    }
    const eventSessionId = sessionIdOf(source);
    const tabId = source.tabId ?? (eventSessionId ? sessionToTab.get(eventSessionId) : void 0);
    if (!tabId) return;
    const sessionId = eventSessionId;
    if (method === "Runtime.bindingCalled") {
      const bp = params;
      if (bp?.name === UI_BINDING_NAME) {
        const ui = uiCaptures.get(tabId);
        if (ui) {
          const ev = parseUiEvent(String(bp.payload ?? ""));
          if (ev) {
            if (sessionId) {
              ev.frameSessionId = sessionId;
              const fu = sessionToFrameUrl.get(sessionId);
              if (fu) ev.frameUrl = fu;
            }
            if (ui.events.length < MAX_UI_EVENTS) ui.events.push(ev);
            else ui.dropped++;
          }
        }
      }
      return;
    }
    const state = networkCaptures.get(tabId);
    if (!state) return;
    const eventParams = params;
    if (method === "Network.requestWillBeSent") {
      if (!isApiResourceType(eventParams?.type)) return;
      const requestId = String(eventParams?.requestId || "");
      const request = eventParams?.request;
      const entry = getOrCreateNetworkCaptureEntry(tabId, reqKey(sessionId, requestId), {
        url: maskUrlAuthTokens(request?.url),
        method: request?.method,
        requestHeaders: normalizeHeaders(request?.headers)
      });
      if (!entry) return;
      if (typeof eventParams?.type === "string") entry.resourceType = eventParams.type;
      const initiator = eventParams?.initiator;
      if (initiator?.type) entry.initiatorType = initiator.type;
      const frameId = eventParams?.frameId;
      if (typeof frameId === "string") entry.frameId = frameId;
      if (sessionId) entry.frameSessionId = sessionId;
      if (sessionId) {
        const fu = sessionToFrameUrl.get(sessionId);
        if (fu) entry.frameUrl = fu;
      }
      entry.requestBodyKind = request?.hasPostData ? "string" : "empty";
      {
        const raw = String(request?.postData || "");
        const fullSize = raw.length;
        const truncated = fullSize > CDP_REQUEST_BODY_CAPTURE_LIMIT;
        entry.requestBodyPreview = truncated ? raw.slice(0, CDP_REQUEST_BODY_CAPTURE_LIMIT) : raw;
        entry.requestBodyFullSize = fullSize;
        entry.requestBodyTruncated = truncated;
      }
      try {
        const postData = await chrome.debugger.sendCommand(source, "Network.getRequestPostData", { requestId });
        if (postData?.postData) {
          const raw = postData.postData;
          const fullSize = raw.length;
          const truncated = fullSize > CDP_REQUEST_BODY_CAPTURE_LIMIT;
          entry.requestBodyKind = "string";
          entry.requestBodyPreview = truncated ? raw.slice(0, CDP_REQUEST_BODY_CAPTURE_LIMIT) : raw;
          entry.requestBodyFullSize = fullSize;
          entry.requestBodyTruncated = truncated;
        }
      } catch {
      }
      return;
    }
    if (method === "Network.responseReceived") {
      const requestId = String(eventParams?.requestId || "");
      const response = eventParams?.response;
      const stateEntryIndex = state.requestToIndex.get(reqKey(sessionId, requestId));
      if (stateEntryIndex === void 0) return;
      const entry = state.entries[stateEntryIndex];
      if (!entry) return;
      entry.responseStatus = response?.status;
      entry.responseContentType = response?.mimeType || "";
      entry.responseHeaders = normalizeHeaders(response?.headers);
      return;
    }
    if (method === "Network.loadingFinished") {
      const requestId = String(eventParams?.requestId || "");
      const stateEntryIndex = state.requestToIndex.get(reqKey(sessionId, requestId));
      if (stateEntryIndex === void 0) return;
      const entry = state.entries[stateEntryIndex];
      if (!entry) return;
      try {
        const body = await chrome.debugger.sendCommand(source, "Network.getResponseBody", { requestId });
        if (typeof body?.body === "string") {
          const fullSize = body.body.length;
          const truncated = fullSize > CDP_RESPONSE_BODY_CAPTURE_LIMIT;
          const stored = truncated ? body.body.slice(0, CDP_RESPONSE_BODY_CAPTURE_LIMIT) : body.body;
          entry.responsePreview = body.base64Encoded ? `base64:${stored}` : stored;
          entry.responseBodyFullSize = fullSize;
          entry.responseBodyTruncated = truncated;
        }
      } catch {
      }
      return;
    }
    if (method === "Network.webSocketCreated") {
      const requestId = String(eventParams?.requestId || "");
      const wsEntry = getOrCreateNetworkCaptureEntry(
        tabId,
        reqKey(sessionId, requestId),
        { url: maskUrlAuthTokens(eventParams?.url), method: "GET" },
        "cdp-websocket"
      );
      if (wsEntry) wsEntry.resourceType = "WebSocket";
      if (wsEntry && sessionId) {
        wsEntry.frameSessionId = sessionId;
        const fu = sessionToFrameUrl.get(sessionId);
        if (fu) wsEntry.frameUrl = fu;
      }
      return;
    }
    if (method === "Network.webSocketHandshakeResponseReceived") {
      const requestId = String(eventParams?.requestId || "");
      const idx = state.requestToIndex.get(reqKey(sessionId, requestId));
      if (idx === void 0) return;
      const entry = state.entries[idx];
      if (!entry) return;
      const response = eventParams?.response;
      entry.responseStatus = response?.status ?? 101;
      entry.responseHeaders = normalizeHeaders(response?.headers);
      return;
    }
    if (method === "Network.webSocketFrameSent" || method === "Network.webSocketFrameReceived") {
      const requestId = String(eventParams?.requestId || "");
      const idx = state.requestToIndex.get(reqKey(sessionId, requestId));
      if (idx === void 0) return;
      const entry = state.entries[idx];
      if (!entry) return;
      const frame = eventParams?.response;
      const opcode = typeof frame?.opcode === "number" ? frame.opcode : -1;
      if (opcode !== 1 && opcode !== 2) return;
      if (!entry.webSocketFrames) entry.webSocketFrames = [];
      if (entry.webSocketFrames.length >= MAX_WS_FRAMES_PER_CONN) {
        entry.webSocketFramesDropped = (entry.webSocketFramesDropped ?? 0) + 1;
        return;
      }
      const raw = String(frame?.payloadData ?? "");
      const fullSize = raw.length;
      const truncated = fullSize > CDP_WS_FRAME_CAPTURE_LIMIT;
      const stored = truncated ? raw.slice(0, CDP_WS_FRAME_CAPTURE_LIMIT) : raw;
      entry.webSocketFrames.push({
        direction: method === "Network.webSocketFrameSent" ? "sent" : "received",
        opcode,
        payloadPreview: opcode === 2 ? `base64:${stored}` : stored,
        payloadFullSize: fullSize,
        payloadTruncated: truncated,
        timestamp: Date.now()
      });
      return;
    }
  });
}

const targetToTab = /* @__PURE__ */ new Map();
const tabToTarget = /* @__PURE__ */ new Map();
async function resolveTargetId(tabId) {
  const cached = tabToTarget.get(tabId);
  if (cached) return cached;
  await refreshMappings();
  const result = tabToTarget.get(tabId);
  if (!result) throw new Error(`No targetId for tab ${tabId} — page may have been closed`);
  return result;
}
async function resolveTabId$1(targetId) {
  const cached = targetToTab.get(targetId);
  if (cached !== void 0) return cached;
  await refreshMappings();
  const result = targetToTab.get(targetId);
  if (result === void 0) throw new Error(`Page not found: ${targetId} — stale page identity`);
  return result;
}
function evictTab(tabId) {
  const targetId = tabToTarget.get(tabId);
  if (targetId) targetToTab.delete(targetId);
  tabToTarget.delete(tabId);
}
async function refreshMappings() {
  const targets = await chrome.debugger.getTargets();
  targetToTab.clear();
  tabToTarget.clear();
  for (const t of targets) {
    if (t.type === "page" && t.tabId !== void 0) {
      targetToTab.set(t.id, t.tabId);
      tabToTarget.set(t.tabId, t.id);
    }
  }
}

const ALLOWED_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:"]);
function classifyIp(s) {
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s)) {
    if (s.split(".").every((o) => Number(o) <= 255)) return 4;
  }
  if (s.includes(":") && /^[0-9a-fA-F:.]+$/.test(s) && ipv6Groups(s) !== null) return 6;
  return 0;
}
function parseIpv4Loose(host) {
  if (host.length === 0) return null;
  const parts = host.split(".");
  if (parts.length > 4) return null;
  if (parts.some((p) => p.length === 0)) return null;
  const numbers = [];
  for (const part of parts) {
    const n = parseRadixPart(part);
    if (n === null) return null;
    numbers.push(n);
  }
  for (let i = 0; i < numbers.length - 1; i++) {
    if (numbers[i] > 255) return null;
  }
  const last = numbers[numbers.length - 1];
  const maxLast = 256 ** (5 - numbers.length);
  if (last >= maxLast) return null;
  let ipv4 = last;
  for (let i = 0; i < numbers.length - 1; i++) ipv4 += numbers[i] * 256 ** (3 - i);
  if (ipv4 > 4294967295) return null;
  return [ipv4 >>> 24 & 255, ipv4 >>> 16 & 255, ipv4 >>> 8 & 255, ipv4 & 255].join(".");
}
function parseRadixPart(part) {
  let radix = 10;
  let digits = part;
  if (/^0[xX]/.test(part)) {
    radix = 16;
    digits = part.slice(2);
    if (digits.length === 0 || !/^[0-9a-fA-F]+$/.test(digits)) return null;
  } else if (part.length > 1 && part[0] === "0") {
    radix = 8;
    digits = part.slice(1);
    if (!/^[0-7]+$/.test(digits)) return null;
  } else if (!/^[0-9]+$/.test(part)) {
    return null;
  }
  const n = parseInt(digits, radix);
  return Number.isNaN(n) ? null : n;
}
function asIpLiteral(host) {
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const v = classifyIp(unbracketed);
  if (v === 4 || v === 6) return unbracketed;
  return parseIpv4Loose(host);
}
const FORBIDDEN_IPV4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
];
function ipv4ToInt(ip) {
  const p = ip.split(".").map((x) => parseInt(x, 10));
  return (p[0] << 24 | p[1] << 16 | p[2] << 8 | p[3]) >>> 0;
}
function ipv4InForbiddenRange(ip) {
  const addr = ipv4ToInt(ip);
  for (const [net, bits] of FORBIDDEN_IPV4) {
    const mask = bits === 0 ? 0 : 4294967295 << 32 - bits >>> 0;
    if ((addr & mask) === (ipv4ToInt(net) & mask)) return true;
  }
  return false;
}
function ipv6Groups(ip) {
  let addr = ip;
  const lastColon = addr.lastIndexOf(":");
  const tail = addr.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (classifyIp(tail) !== 4) return null;
    const v4 = ipv4ToInt(tail);
    addr = addr.slice(0, lastColon + 1) + (v4 >>> 16 & 65535).toString(16) + ":" + (v4 & 65535).toString(16);
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0].length ? halves[0].split(":") : [];
  const back = halves.length === 2 ? halves[1].length ? halves[1].split(":") : [] : null;
  const parse = (groups) => {
    const out = [];
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const headNums = parse(head);
  if (headNums === null) return null;
  if (back === null) return headNums.length === 8 ? headNums : null;
  const backNums = parse(back);
  if (backNums === null) return null;
  const fill = 8 - headNums.length - backNums.length;
  if (fill < 0) return null;
  return [...headNums, ...new Array(fill).fill(0), ...backNums];
}
function ipv6InForbiddenRange(ip) {
  const g = ipv6Groups(ip);
  if (!g) return false;
  if (g.every((x) => x === 0)) return true;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 65535) {
    const v4 = `${g[6] >> 8 & 255}.${g[6] & 255}.${g[7] >> 8 & 255}.${g[7] & 255}`;
    return ipv4InForbiddenRange(v4);
  }
  const first = g[0];
  if ((first & 65024) === 64512) return true;
  if ((first & 65472) === 65152) return true;
  if ((first & 65280) === 65280) return true;
  return false;
}
function isForbiddenIp(ip) {
  const v = classifyIp(ip);
  if (v === 4) return ipv4InForbiddenRange(ip);
  if (v === 6) return ipv6InForbiddenRange(ip);
  const canon = parseIpv4Loose(ip);
  return canon ? ipv4InForbiddenRange(canon) : false;
}
function checkUrlSyntax(input, opts = {}) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, reason: "empty_host", detail: "unparseable URL" };
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: "forbidden_protocol", detail: `protocol ${parsed.protocol} not allowed` };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "userinfo_present", detail: "userinfo (user:pass@) not allowed" };
  }
  let hostname = parsed.hostname;
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (hostname === "") return { ok: false, reason: "empty_host", detail: "empty host" };
  const ipLiteral = asIpLiteral(hostname);
  if (ipLiteral !== null) {
    if (isForbiddenIp(ipLiteral)) {
      return { ok: false, reason: "forbidden_ip", detail: `literal IP ${ipLiteral} is forbidden` };
    }
    if (!opts.allowLiteralIp) {
      return { ok: false, reason: "literal_ip_host", detail: `literal IP host ${ipLiteral} not allowed for navigation` };
    }
    return { ok: true, url: parsed.toString(), hostname: ipLiteral, isIpLiteral: true };
  }
  return { ok: true, url: parsed.toString(), hostname, isIpLiteral: false };
}

const EXTENSION_CAPABILITIES = ["focus-window-v1"];
let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const CONTEXT_ID_KEY = "bycli_context_id_v1";
let currentContextId = "default";
let contextIdPromise = null;
let connectInFlight = null;
async function getCurrentContextId() {
  if (contextIdPromise) return contextIdPromise;
  contextIdPromise = (async () => {
    try {
      const local = chrome.storage?.local;
      if (!local) return currentContextId;
      const raw = await local.get(CONTEXT_ID_KEY);
      const existing = raw[CONTEXT_ID_KEY];
      if (typeof existing === "string" && existing.trim()) {
        currentContextId = existing.trim();
        return currentContextId;
      }
      const generated = generateContextId();
      await local.set({ [CONTEXT_ID_KEY]: generated });
      currentContextId = generated;
      return currentContextId;
    } catch {
      return currentContextId;
    }
  })();
  return contextIdPromise;
}
function generateContextId() {
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  const maxUnbiasedByte = Math.floor(256 / alphabet.length) * alphabet.length;
  let id = "";
  while (id.length < 8) {
    const bytes = new Uint8Array(8);
    try {
      crypto.getRandomValues(bytes);
    } catch {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    for (const byte of bytes) {
      if (byte >= maxUnbiasedByte) continue;
      id += alphabet[byte % alphabet.length];
      if (id.length === 8) break;
    }
  }
  return id;
}
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
function forwardLog(level, args) {
  try {
    const msg = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    safeSend(ws, { type: "log", level, msg, ts: Date.now() });
  } catch {
  }
}
function safeSend(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}
console.log = (...args) => {
  _origLog(...args);
  forwardLog("info", args);
};
console.warn = (...args) => {
  _origWarn(...args);
  forwardLog("warn", args);
};
console.error = (...args) => {
  _origError(...args);
  forwardLog("error", args);
};
function isDaemonSocketActive(socket = ws) {
  return socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING;
}
function connect() {
  if (isDaemonSocketActive()) return Promise.resolve();
  if (connectInFlight) return connectInFlight;
  connectInFlight = connectAttempt().finally(() => {
    connectInFlight = null;
  });
  return connectInFlight;
}
async function connectAttempt() {
  if (isDaemonSocketActive()) return;
  try {
    const res = await fetch(DAEMON_PING_URL, { signal: AbortSignal.timeout(1e3) });
    if (!res.ok) return;
  } catch {
    return;
  }
  if (isDaemonSocketActive()) return;
  let thisWs;
  try {
    const contextId = await getCurrentContextId();
    if (isDaemonSocketActive()) return;
    thisWs = new WebSocket(DAEMON_WS_URL);
    ws = thisWs;
    currentContextId = contextId;
  } catch {
    scheduleReconnect();
    return;
  }
  thisWs.onopen = () => {
    if (ws !== thisWs) return;
    console.log("[bycli] Connected to daemon");
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    safeSend(thisWs, {
      type: "hello",
      contextId: currentContextId,
      version: chrome.runtime.getManifest().version,
      compatRange: ">=1.7.0",
      capabilities: EXTENSION_CAPABILITIES
    });
  };
  thisWs.onmessage = async (event) => {
    if (ws !== thisWs) return;
    try {
      const command = JSON.parse(event.data);
      const result = await handleCommand(command);
      if (ws !== thisWs) return;
      safeSend(thisWs, result);
    } catch (err) {
      console.error("[bycli] Message handling error:", err);
    }
  };
  thisWs.onclose = () => {
    if (ws !== thisWs) return;
    console.log("[bycli] Disconnected from daemon");
    ws = null;
    scheduleReconnect();
  };
  thisWs.onerror = () => {
    thisWs.close();
  };
}
const MAX_EAGER_ATTEMPTS = 6;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts++;
  if (reconnectAttempts > MAX_EAGER_ATTEMPTS) return;
  const delay = Math.min(WS_RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1), WS_RECONNECT_MAX_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}
const automationSessions = /* @__PURE__ */ new Map();
const leaseRevisions = /* @__PURE__ */ new Map();
const leaseIdleGenerations = /* @__PURE__ */ new Map();
const leaseOperationTails = /* @__PURE__ */ new Map();
const IDLE_TIMEOUT_DEFAULT = 3e4;
const IDLE_TIMEOUT_INTERACTIVE = 6e5;
const IDLE_TIMEOUT_NONE = -1;
const REGISTRY_KEY = "bycli_target_lease_registry_v2";
const LEASE_IDLE_ALARM_PREFIX = "bycli:lease-idle:";
const CONTAINER_TAB_GROUP_TITLE = {
  interactive: "byCLI Browser",
  automation: "byCLI Adapter"
};
const LEGACY_AUTOMATION_TAB_GROUP_TITLE = "byCLI";
const AUTOMATION_TAB_GROUP_COLOR = "orange";
let leaseMutationQueue = Promise.resolve();
const ownedContainers = {
  interactive: { windowId: null, groupId: null, promise: null, groupPromise: null },
  automation: { windowId: null, groupId: null, promise: null, groupPromise: null }
};
class CommandFailure extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = "CommandFailure";
  }
}
const sessionTimeoutOverrides = /* @__PURE__ */ new Map();
const sessionWindowModeOverrides = /* @__PURE__ */ new Map();
const sessionLifecycleOverrides = /* @__PURE__ */ new Map();
const LEASE_KEY_SEPARATOR = "\0";
function getLeaseKey(session, surface) {
  return `${surface}${LEASE_KEY_SEPARATOR}${encodeURIComponent(session)}`;
}
function getSessionName(session) {
  const raw = session?.trim();
  if (!raw) throw new CommandFailure(
    "session_required",
    "Browser session is required.",
    "Pass a browser session name, e.g. bycli browser <session> <command>."
  );
  return raw;
}
function getCommandSurface(cmd) {
  return cmd.surface === "adapter" ? "adapter" : "browser";
}
function getSurfaceFromKey(key) {
  return key.split(LEASE_KEY_SEPARATOR, 1)[0] === "adapter" ? "adapter" : "browser";
}
function getSessionFromKey(key) {
  const idx = key.indexOf(LEASE_KEY_SEPARATOR);
  if (idx === -1) return key;
  try {
    return decodeURIComponent(key.slice(idx + 1));
  } catch {
    return key.slice(idx + 1);
  }
}
function getIdleTimeout(key) {
  const session = automationSessions.get(key);
  if (session?.kind === "bound") return IDLE_TIMEOUT_NONE;
  const adapterPersistent = getSurfaceFromKey(key) === "adapter" && (session?.lifecycle === "persistent" || sessionLifecycleOverrides.get(key) === "persistent");
  if (adapterPersistent) return IDLE_TIMEOUT_NONE;
  const override = sessionTimeoutOverrides.get(key);
  if (override !== void 0) return override;
  return getSurfaceFromKey(key) === "browser" ? IDLE_TIMEOUT_INTERACTIVE : IDLE_TIMEOUT_DEFAULT;
}
function getLeaseLifecycle(key, kind) {
  if (kind === "bound") return "pinned";
  const override = sessionLifecycleOverrides.get(key);
  if (override) return override;
  return getSurfaceFromKey(key) === "browser" ? "persistent" : "ephemeral";
}
function getOwnedWindowRole(key) {
  return getSurfaceFromKey(key) === "browser" ? "interactive" : "automation";
}
function getWindowRole(key, ownership) {
  return ownership === "borrowed" ? "borrowed-user" : getOwnedWindowRole(key);
}
function getWindowMode(key) {
  return sessionWindowModeOverrides.get(key) ?? "foreground";
}
function getWindowModeForOwnedPage(key, url) {
  if (getSurfaceFromKey(key) === "browser" && url === BLANK_PAGE) return "background";
  return getWindowMode(key);
}
function makeAlarmName(leaseKey) {
  return `${LEASE_IDLE_ALARM_PREFIX}${encodeURIComponent(leaseKey)}`;
}
function leaseKeyFromAlarmName(name) {
  if (!name.startsWith(LEASE_IDLE_ALARM_PREFIX)) return null;
  try {
    return decodeURIComponent(name.slice(LEASE_IDLE_ALARM_PREFIX.length));
  } catch {
    return null;
  }
}
function withLeaseMutation(fn) {
  const run = leaseMutationQueue.then(fn, fn);
  leaseMutationQueue = run.then(() => void 0, () => void 0);
  return run;
}
function invalidateLease(leaseKey) {
  leaseRevisions.set(leaseKey, (leaseRevisions.get(leaseKey) ?? 0) + 1);
}
function withLeaseLock(leaseKey, fn) {
  const previous = leaseOperationTails.get(leaseKey) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(() => void 0, () => void 0);
  leaseOperationTails.set(leaseKey, tail);
  void tail.then(() => {
    if (leaseOperationTails.get(leaseKey) === tail) leaseOperationTails.delete(leaseKey);
  });
  return run;
}
function deleteAutomationSession(leaseKey) {
  invalidateLease(leaseKey);
  automationSessions.delete(leaseKey);
}
function storeAutomationSession(leaseKey, session) {
  invalidateLease(leaseKey);
  automationSessions.set(leaseKey, session);
}
function clearAutomationSessions() {
  for (const leaseKey of automationSessions.keys()) invalidateLease(leaseKey);
  automationSessions.clear();
}
function makeSession(key, session) {
  const ownership = session.owned ? "owned" : "borrowed";
  return {
    ...session,
    contextId: currentContextId,
    ownership,
    lifecycle: getLeaseLifecycle(key, session.kind),
    windowRole: getWindowRole(key, ownership)
  };
}
function emptyRegistry() {
  return {
    version: 2,
    contextId: currentContextId,
    ownedContainers: {
      interactive: {
        windowId: ownedContainers.interactive.windowId,
        groupId: ownedContainers.interactive.groupId
      },
      automation: {
        windowId: ownedContainers.automation.windowId,
        groupId: ownedContainers.automation.groupId
      }
    },
    leases: {}
  };
}
async function readRegistry() {
  try {
    const local = chrome.storage?.local;
    if (!local) return emptyRegistry();
    const raw = await local.get(REGISTRY_KEY);
    const stored = raw[REGISTRY_KEY];
    if (!stored || stored.version !== 2 || typeof stored.leases !== "object") return emptyRegistry();
    const storedContainers = stored.ownedContainers && typeof stored.ownedContainers === "object" ? stored.ownedContainers : emptyRegistry().ownedContainers;
    return {
      version: 2,
      contextId: currentContextId,
      ownedContainers: {
        interactive: {
          windowId: typeof storedContainers.interactive?.windowId === "number" ? storedContainers.interactive.windowId : null,
          groupId: typeof storedContainers.interactive?.groupId === "number" ? storedContainers.interactive.groupId : null
        },
        automation: {
          windowId: typeof storedContainers.automation?.windowId === "number" ? storedContainers.automation.windowId : null,
          groupId: typeof storedContainers.automation?.groupId === "number" ? storedContainers.automation.groupId : null
        }
      },
      leases: stored.leases
    };
  } catch {
    return emptyRegistry();
  }
}
async function writeRegistry(registry) {
  try {
    await chrome.storage?.local?.set({ [REGISTRY_KEY]: registry });
  } catch {
  }
}
async function persistRuntimeState() {
  const leases = {};
  for (const [leaseKey, session] of automationSessions.entries()) {
    leases[leaseKey] = {
      session: session.session,
      surface: session.surface,
      kind: session.kind,
      windowId: session.windowId,
      owned: session.owned,
      preferredTabId: session.preferredTabId,
      contextId: session.contextId,
      ownership: session.ownership,
      lifecycle: session.lifecycle,
      windowRole: session.windowRole,
      idleDeadlineAt: session.idleDeadlineAt,
      updatedAt: Date.now()
    };
  }
  await writeRegistry({
    version: 2,
    contextId: currentContextId,
    ownedContainers: {
      interactive: {
        windowId: ownedContainers.interactive.windowId,
        groupId: ownedContainers.interactive.groupId
      },
      automation: {
        windowId: ownedContainers.automation.windowId,
        groupId: ownedContainers.automation.groupId
      }
    },
    leases
  });
}
function nextIdleGeneration(leaseKey) {
  const generation = (leaseIdleGenerations.get(leaseKey) ?? 0) + 1;
  leaseIdleGenerations.set(leaseKey, generation);
  return generation;
}
function scheduleIdleAlarmAt(leaseKey, deadline) {
  const alarmName = makeAlarmName(leaseKey);
  try {
    if (deadline > 0) {
      chrome.alarms?.create?.(alarmName, { when: deadline });
    } else {
      chrome.alarms?.clear?.(alarmName);
    }
  } catch {
  }
}
function cancelIdleExpiry(leaseKey) {
  nextIdleGeneration(leaseKey);
  scheduleIdleAlarmAt(leaseKey, 0);
}
async function safeDetach(tabId) {
  try {
    const detach$1 = detach;
    if (typeof detach$1 === "function") await detach$1(tabId);
  } catch {
  }
}
async function removeLeaseSession(leaseKey, expected = automationSessions.get(leaseKey)) {
  const existing = expected;
  if (automationSessions.get(leaseKey) !== existing) return;
  if (existing?.idleTimer) clearTimeout(existing.idleTimer);
  deleteAutomationSession(leaseKey);
  sessionTimeoutOverrides.delete(leaseKey);
  sessionWindowModeOverrides.delete(leaseKey);
  sessionLifecycleOverrides.delete(leaseKey);
  cancelIdleExpiry(leaseKey);
  await persistRuntimeState();
}
async function releaseLeaseIfIdleExpired(leaseKey, expectedSession, expectedGeneration, expectedDeadline, reason) {
  await withLeaseLock(leaseKey, async () => {
    const current = automationSessions.get(leaseKey);
    if (current !== expectedSession) return;
    if (leaseIdleGenerations.get(leaseKey) !== expectedGeneration) return;
    if (current.idleDeadlineAt !== expectedDeadline) return;
    if (expectedDeadline <= 0 || Date.now() < expectedDeadline) return;
    await releaseLeaseUnlocked(leaseKey, reason);
  });
}
function resetWindowIdleTimer(leaseKey) {
  const session = automationSessions.get(leaseKey);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  const timeout = getIdleTimeout(leaseKey);
  const generation = nextIdleGeneration(leaseKey);
  if (timeout <= 0) {
    session.idleTimer = null;
    session.idleDeadlineAt = 0;
    scheduleIdleAlarmAt(leaseKey, 0);
    void persistRuntimeState();
    return;
  }
  const deadline = Date.now() + timeout;
  session.idleDeadlineAt = deadline;
  scheduleIdleAlarmAt(leaseKey, deadline);
  void persistRuntimeState();
  session.idleTimer = setTimeout(async () => {
    await releaseLeaseIfIdleExpired(leaseKey, session, generation, deadline, "idle timeout");
  }, timeout);
}
async function getOwnedContainerGroupId(role, windowId) {
  const container = ownedContainers[role];
  if (container.groupId !== null) {
    try {
      const group = await chrome.tabGroups.get(container.groupId);
      if (group.windowId === windowId) return container.groupId;
    } catch {
    }
    container.groupId = null;
  }
  for (const title of getOwnedContainerGroupTitles(role)) {
    const groups = await chrome.tabGroups.query({ windowId, title });
    const existing = groups[0];
    if (existing) {
      container.groupId = existing.id;
      return existing.id;
    }
  }
  return null;
}
function getOwnedContainerGroupTitles(role) {
  return role === "automation" ? [CONTAINER_TAB_GROUP_TITLE.automation, LEGACY_AUTOMATION_TAB_GROUP_TITLE] : [CONTAINER_TAB_GROUP_TITLE.interactive];
}
async function focusOwnedWindowIfRequested(windowId, mode) {
  if (mode !== "foreground") return;
  const updateWindow = chrome.windows.update;
  if (typeof updateWindow === "function") await updateWindow(windowId, { focused: true }).catch(() => {
  });
}
async function toOwnedContainerDiscoveryCandidate(group) {
  try {
    const chromeWindow = await chrome.windows.get(group.windowId);
    const reusableTabId = await findReusableOwnedContainerTab(group.windowId, group.id);
    return {
      windowId: group.windowId,
      groupId: group.id,
      focused: !!chromeWindow.focused,
      hasReusableTab: reusableTabId !== void 0
    };
  } catch {
    return null;
  }
}
function selectOwnedContainerDiscoveryCandidate(candidates) {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    if (a.focused !== b.focused) return a.focused ? -1 : 1;
    if (a.hasReusableTab !== b.hasReusableTab) return a.hasReusableTab ? -1 : 1;
    return a.groupId - b.groupId;
  })[0];
}
async function discoverOwnedContainerFromTabGroup(role) {
  const container = ownedContainers[role];
  if (container.groupId !== null) {
    try {
      const group = await chrome.tabGroups.get(container.groupId);
      await chrome.windows.get(group.windowId);
      container.windowId = group.windowId;
      return { windowId: group.windowId, groupId: group.id };
    } catch {
      container.windowId = null;
      container.groupId = null;
    }
  }
  for (const title of getOwnedContainerGroupTitles(role)) {
    const groups = await chrome.tabGroups.query({ title });
    const candidates = (await Promise.all(groups.map(toOwnedContainerDiscoveryCandidate))).filter((candidate) => candidate !== null);
    const selected = selectOwnedContainerDiscoveryCandidate(candidates);
    if (!selected) continue;
    container.windowId = selected.windowId;
    container.groupId = selected.groupId;
    return { windowId: selected.windowId, groupId: selected.groupId };
  }
  return null;
}
async function ensureOwnedContainerTabGroup(role, windowId, tabIds) {
  const ids = [...new Set(tabIds.filter((id) => id !== void 0))];
  if (ids.length === 0) return;
  const container = ownedContainers[role];
  const previousGroupPromise = container.groupPromise ?? Promise.resolve();
  const nextGroupPromise = previousGroupPromise.catch(() => void 0).then(() => ensureOwnedContainerTabGroupUnlocked(role, windowId, ids));
  const trackedGroupPromise = nextGroupPromise.finally(() => {
    if (container.groupPromise === trackedGroupPromise) container.groupPromise = null;
  });
  container.groupPromise = trackedGroupPromise;
  return trackedGroupPromise;
}
async function ensureOwnedContainerTabGroupUnlocked(role, windowId, ids) {
  try {
    const existingGroupId = await getOwnedContainerGroupId(role, windowId);
    if (existingGroupId !== null) {
      const tabs = await chrome.tabs.query({ windowId });
      const alreadyGrouped = new Set(
        tabs.filter((tab) => tab.id !== void 0 && ids.includes(tab.id) && tab.groupId === existingGroupId).map((tab) => tab.id)
      );
      const missing = ids.filter((id) => !alreadyGrouped.has(id));
      if (missing.length > 0) await chrome.tabs.group({ groupId: existingGroupId, tabIds: missing });
      return;
    }
    const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
    ownedContainers[role].groupId = groupId;
    await chrome.tabGroups.update(groupId, {
      color: AUTOMATION_TAB_GROUP_COLOR,
      title: CONTAINER_TAB_GROUP_TITLE[role],
      collapsed: false
    });
  } catch (err) {
    console.warn(`[bycli] Failed to mark ${role} tab group: ${err instanceof Error ? err.message : String(err)}`);
  }
}
async function ensureOwnedContainerWindow(role, initialUrl, mode = "background") {
  const container = ownedContainers[role];
  if (container.promise) return container.promise;
  container.promise = ensureOwnedContainerWindowUnlocked(role, initialUrl, mode).finally(() => {
    container.promise = null;
  });
  return container.promise;
}
async function ensureOwnedContainerWindowUnlocked(role, initialUrl, mode = "background") {
  const container = ownedContainers[role];
  if (container.windowId !== null) {
    try {
      await chrome.windows.get(container.windowId);
      await focusOwnedWindowIfRequested(container.windowId, mode);
      const initialTabId2 = await findReusableOwnedContainerTab(container.windowId, await getOwnedContainerGroupId(role, container.windowId));
      await ensureOwnedContainerTabGroup(role, container.windowId, [initialTabId2]);
      return {
        windowId: container.windowId,
        initialTabId: initialTabId2
      };
    } catch {
      container.windowId = null;
      container.groupId = null;
    }
  }
  const discovered = await discoverOwnedContainerFromTabGroup(role);
  if (discovered) {
    await focusOwnedWindowIfRequested(discovered.windowId, mode);
    const initialTabId2 = await findReusableOwnedContainerTab(discovered.windowId, discovered.groupId);
    await ensureOwnedContainerTabGroup(role, discovered.windowId, [initialTabId2]);
    await persistRuntimeState();
    return {
      windowId: discovered.windowId,
      initialTabId: initialTabId2
    };
  }
  const startUrl = initialUrl && isSafeNavigationUrl(initialUrl) ? initialUrl : BLANK_PAGE;
  const win = await chrome.windows.create({
    url: startUrl,
    focused: mode === "foreground",
    width: 1280,
    height: 900,
    type: "normal"
  });
  container.windowId = win.id;
  console.log(`[bycli] Created owned ${role} window ${container.windowId} (start=${startUrl})`);
  const tabs = await chrome.tabs.query({ windowId: win.id });
  const initialTabId = tabs[0]?.id;
  if (initialTabId) {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 500);
      const listener = (tabId, info) => {
        if (tabId === initialTabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        }
      };
      if (tabs[0].status === "complete") {
        clearTimeout(timeout);
        resolve();
      } else {
        chrome.tabs.onUpdated.addListener(listener);
      }
    });
  }
  await ensureOwnedContainerTabGroup(role, container.windowId, [initialTabId]);
  await persistRuntimeState();
  return { windowId: container.windowId, initialTabId };
}
async function findReusableOwnedContainerTab(windowId, groupId) {
  if (groupId === null) return void 0;
  try {
    const tabs = await chrome.tabs.query({ windowId, groupId });
    const reusable = tabs.find(
      (tab) => tab.id !== void 0 && initialTabIsAvailable(tab.id) && isDebuggableUrl(tab.url)
    );
    return reusable?.id;
  } catch {
    return void 0;
  }
}
function initialTabIsAvailable(tabId) {
  if (tabId === void 0) return false;
  for (const session of automationSessions.values()) {
    if (session.owned && session.preferredTabId === tabId) return false;
  }
  return true;
}
async function createOwnedTabLeaseUnlocked(leaseKey, initialUrl, blankFirst = false) {
  return withLeaseMutation(() => createOwnedTabLeaseMutationUnlocked(leaseKey, initialUrl, blankFirst));
}
async function createOwnedTabLeaseMutationUnlocked(leaseKey, initialUrl, blankFirst = false) {
  const createUrl = blankFirst ? BLANK_PAGE : initialUrl && isSafeNavigationUrl(initialUrl) ? initialUrl : BLANK_PAGE;
  const role = getOwnedWindowRole(leaseKey);
  const windowMode = getWindowModeForOwnedPage(leaseKey, createUrl);
  const { windowId, initialTabId } = await ensureOwnedContainerWindow(role, blankFirst ? void 0 : initialUrl, windowMode);
  let tab;
  if (initialTabIsAvailable(initialTabId)) {
    tab = await chrome.tabs.get(initialTabId);
    if (!blankFirst && !isTargetUrl(tab.url, createUrl)) {
      tab = await chrome.tabs.update(initialTabId, { url: createUrl });
      await new Promise((resolve) => setTimeout(resolve, 300));
      tab = await chrome.tabs.get(initialTabId);
    }
  } else {
    const activateTab = windowMode === "foreground";
    tab = await chrome.tabs.create({ windowId, url: createUrl, active: activateTab });
  }
  if (!tab.id) throw new Error("Failed to create tab lease in automation container");
  await ensureOwnedContainerTabGroup(role, windowId, [tab.id]);
  setLeaseSession(leaseKey, {
    session: getSessionFromKey(leaseKey),
    surface: getSurfaceFromKey(leaseKey),
    kind: "owned",
    windowId,
    owned: true,
    preferredTabId: tab.id
  });
  resetWindowIdleTimer(leaseKey);
  return { tabId: tab.id, tab };
}
async function getAutomationWindow(leaseKey, initialUrl) {
  const existing = automationSessions.get(leaseKey);
  if (existing) {
    if (!existing.owned) {
      throw new CommandFailure(
        "bound_window_operation_blocked",
        `Session "${existing.session}" is bound to a user tab and does not own an byCLI tab lease.`,
        "Use page commands on the bound tab, or unbind the session first."
      );
    }
    try {
      const tabId = existing.preferredTabId;
      if (tabId !== null) {
        const tab = await chrome.tabs.get(tabId);
        if (isDebuggableUrl(tab.url)) return tab.windowId;
      }
      await chrome.windows.get(existing.windowId);
      return existing.windowId;
    } catch {
      await removeLeaseSession(leaseKey);
    }
  }
  const role = getOwnedWindowRole(leaseKey);
  const url = initialUrl && isSafeNavigationUrl(initialUrl) ? initialUrl : BLANK_PAGE;
  return (await ensureOwnedContainerWindow(role, initialUrl, getWindowModeForOwnedPage(leaseKey, url))).windowId;
}
chrome.windows.onRemoved.addListener(async (windowId) => {
  for (const container of Object.values(ownedContainers)) {
    if (container.windowId === windowId) {
      container.windowId = null;
      container.groupId = null;
    }
  }
  for (const [leaseKey, expected] of [...automationSessions.entries()]) {
    if (expected.windowId === windowId) await withLeaseLock(leaseKey, async () => {
      const session = automationSessions.get(leaseKey);
      if (!session || session !== expected || session.windowId !== windowId) return;
      console.log(`[bycli] ${session.surface} container closed (session=${session.session})`);
      if (session.idleTimer) clearTimeout(session.idleTimer);
      deleteAutomationSession(leaseKey);
      sessionTimeoutOverrides.delete(leaseKey);
      sessionWindowModeOverrides.delete(leaseKey);
      sessionLifecycleOverrides.delete(leaseKey);
      cancelIdleExpiry(leaseKey);
    });
  }
  await persistRuntimeState();
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  evictTab(tabId);
  for (const [leaseKey, expected] of [...automationSessions.entries()]) {
    if (expected.preferredTabId === tabId) await withLeaseLock(leaseKey, async () => {
      const session = automationSessions.get(leaseKey);
      if (!session || session !== expected || session.preferredTabId !== tabId) return;
      if (session.idleTimer) clearTimeout(session.idleTimer);
      deleteAutomationSession(leaseKey);
      sessionTimeoutOverrides.delete(leaseKey);
      sessionWindowModeOverrides.delete(leaseKey);
      sessionLifecycleOverrides.delete(leaseKey);
      cancelIdleExpiry(leaseKey);
      console.log(`[bycli] Session ${session.session} detached from tab ${tabId} (tab closed)`);
    });
  }
  await persistRuntimeState();
});
let initialized = false;
function initialize() {
  if (initialized) return;
  initialized = true;
  chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
  registerListeners();
  try {
    const registerFrameTracking$1 = registerFrameTracking;
    registerFrameTracking$1?.();
  } catch {
  }
  void (async () => {
    await getCurrentContextId();
    await reconcileTargetLeaseRegistry();
    await connect();
  })();
  console.log("[bycli] byCLI extension initialized");
}
chrome.runtime.onInstalled.addListener(() => {
  initialize();
});
chrome.runtime.onStartup.addListener(() => {
  initialize();
});
initialize();
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "keepalive") void connect();
  const leaseKey = leaseKeyFromAlarmName(alarm.name);
  if (leaseKey) {
    const session = automationSessions.get(leaseKey);
    if (!session) return;
    const generation = leaseIdleGenerations.get(leaseKey) ?? 0;
    const deadline = Number.isFinite(alarm.scheduledTime) && alarm.scheduledTime > 0 ? alarm.scheduledTime : session.idleDeadlineAt;
    await releaseLeaseIfIdleExpired(leaseKey, session, generation, deadline, "idle alarm");
  }
});
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "getStatus") {
    void (async () => {
      const contextId = await getCurrentContextId();
      const connected = ws?.readyState === WebSocket.OPEN;
      const extensionVersion = chrome.runtime.getManifest().version;
      const daemonVersion = connected ? await fetchDaemonVersion() : null;
      sendResponse({
        connected,
        reconnecting: reconnectTimer !== null,
        contextId,
        extensionVersion,
        daemonVersion
      });
    })();
    return true;
  }
  return false;
});
async function fetchDaemonVersion() {
  try {
    const res = await fetch(`http://${DAEMON_HOST}:${DAEMON_PORT}/status`, {
      method: "GET",
      headers: { "X-byCLI": "1" },
      signal: AbortSignal.timeout(1500)
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.daemonVersion === "string" ? body.daemonVersion : null;
  } catch {
    return null;
  }
}
async function handleCommand(cmd) {
  const session = getSessionName(cmd.session);
  const surface = getCommandSurface(cmd);
  const leaseKey = getLeaseKey(session, surface);
  if (cmd.windowMode === "foreground" || cmd.windowMode === "background") {
    sessionWindowModeOverrides.set(leaseKey, cmd.windowMode);
  }
  if (surface === "adapter" && (cmd.siteSession === "persistent" || cmd.siteSession === "ephemeral")) {
    sessionLifecycleOverrides.set(leaseKey, cmd.siteSession);
  }
  if (cmd.idleTimeout != null && cmd.idleTimeout > 0) {
    sessionTimeoutOverrides.set(leaseKey, cmd.idleTimeout * 1e3);
  }
  resetWindowIdleTimer(leaseKey);
  try {
    switch (cmd.action) {
      case "exec":
        return await handleExec(cmd, leaseKey);
      case "navigate":
        return await handleNavigate(cmd, leaseKey);
      case "tabs":
        return await handleTabs(cmd, leaseKey);
      case "cookies":
        return await handleCookies(cmd);
      case "screenshot":
        return await handleScreenshot(cmd, leaseKey);
      case "close-window":
        return await handleCloseWindow(cmd, leaseKey);
      case "cdp":
        return await handleCdp(cmd, leaseKey);
      case "set-file-input":
        return await handleSetFileInput(cmd, leaseKey);
      case "insert-text":
        return await handleInsertText(cmd, leaseKey);
      case "bind":
        return await handleBind(cmd, leaseKey);
      case "network-capture-start":
        return await handleNetworkCaptureStart(cmd, leaseKey);
      case "network-capture-read":
        return await handleNetworkCaptureRead(cmd, leaseKey);
      case "ui-capture-start":
        return await handleUiCaptureStart(cmd, leaseKey);
      case "ui-capture-read":
        return await handleUiCaptureRead(cmd, leaseKey);
      case "wait-download":
        return await handleWaitDownload(cmd);
      case "frames":
        return await handleFrames(cmd, leaseKey);
      default:
        return { id: cmd.id, ok: false, error: `Unknown action: ${cmd.action}` };
    }
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...err instanceof CommandFailure ? { errorCode: err.code } : {},
      ...err instanceof CommandFailure && err.hint ? { errorHint: err.hint } : {}
    };
  }
}
const BLANK_PAGE = "about:blank";
function isDebuggableUrl(url) {
  if (!url) return true;
  return url.startsWith("http://") || url.startsWith("https://") || url === "about:blank" || url.startsWith("data:");
}
function isSafeNavigationUrl(url) {
  return url.startsWith("http://") || url.startsWith("https://");
}
function normalizeUrlForComparison(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && parsed.port === "443" || parsed.protocol === "http:" && parsed.port === "80") {
      parsed.port = "";
    }
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}
function isTargetUrl(currentUrl, targetUrl) {
  return normalizeUrlForComparison(currentUrl) === normalizeUrlForComparison(targetUrl);
}
function getUrlOrigin(url) {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
function enumerateCrossOriginFrames(tree) {
  const frames = [];
  function collect(node, accessibleOrigin) {
    for (const child of node.childFrames || []) {
      const frame = child.frame;
      const frameUrl = frame.url || frame.unreachableUrl || "";
      const frameOrigin = getUrlOrigin(frameUrl);
      if (accessibleOrigin && frameOrigin && frameOrigin === accessibleOrigin) {
        collect(child, frameOrigin);
        continue;
      }
      frames.push({
        index: frames.length,
        frameId: frame.id,
        url: frameUrl,
        name: frame.name || ""
      });
    }
  }
  const rootFrame = tree?.frameTree?.frame;
  const rootUrl = rootFrame?.url || rootFrame?.unreachableUrl || "";
  collect(tree.frameTree, getUrlOrigin(rootUrl));
  return frames;
}
function setLeaseSession(leaseKey, session) {
  const existing = automationSessions.get(leaseKey);
  if (existing?.idleTimer) clearTimeout(existing.idleTimer);
  const timeout = getIdleTimeout(leaseKey);
  storeAutomationSession(leaseKey, {
    ...makeSession(leaseKey, session),
    idleTimer: null,
    idleDeadlineAt: timeout <= 0 ? 0 : Date.now() + timeout
  });
  void persistRuntimeState();
}
async function resolveCommandTabId(cmd) {
  if (cmd.page) return resolveTabId$1(cmd.page);
  return void 0;
}
async function resolveTab(tabId, leaseKey, initialUrl, blankFirst = false) {
  return withLeaseLock(leaseKey, () => resolveTabUnlocked(tabId, leaseKey, initialUrl, blankFirst));
}
async function resolveTabUnlocked(tabId, leaseKey, initialUrl, blankFirst = false) {
  const existingSession = automationSessions.get(leaseKey);
  if (tabId !== void 0) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const session = existingSession;
      const matchesSession = session ? session.preferredTabId !== null ? session.preferredTabId === tabId : tab.windowId === session.windowId : false;
      if (isDebuggableUrl(tab.url) && matchesSession) return { tabId, tab };
      if (session && !session.owned) {
        throw new CommandFailure(
          matchesSession ? "bound_tab_not_debuggable" : "bound_tab_mismatch",
          matchesSession ? `Bound tab for session "${session.session}" is not debuggable (${tab.url ?? "unknown URL"}).` : `Target tab is not the tab bound to session "${session.session}".`,
          'Run "bycli browser bind" again on a debuggable http(s) tab.'
        );
      }
      if (session && !matchesSession && session.preferredTabId === null && isDebuggableUrl(tab.url)) {
        console.warn(`[bycli] Tab ${tabId} drifted to window ${tab.windowId}, moving back to ${session.windowId}`);
        try {
          await chrome.tabs.move(tabId, { windowId: session.windowId, index: -1 });
          const moved = await chrome.tabs.get(tabId);
          if (moved.windowId === session.windowId && isDebuggableUrl(moved.url)) {
            return { tabId, tab: moved };
          }
        } catch (moveErr) {
          console.warn(`[bycli] Failed to move tab back: ${moveErr}`);
        }
      } else if (!isDebuggableUrl(tab.url)) {
        console.warn(`[bycli] Tab ${tabId} URL is not debuggable (${tab.url}), re-resolving`);
      }
    } catch (err) {
      if (err instanceof CommandFailure) throw err;
      if (existingSession && !existingSession.owned) {
        await removeLeaseSession(leaseKey, existingSession);
        throw new CommandFailure(
          "bound_tab_gone",
          `Bound tab for session "${existingSession.session}" no longer exists.`,
          'Run "bycli browser bind" again, then retry the command.'
        );
      }
      console.warn(`[bycli] Tab ${tabId} no longer exists, re-resolving`);
    }
  }
  const existingPreferredTabId = existingSession?.preferredTabId ?? null;
  if (existingSession && existingPreferredTabId !== null) {
    const session = existingSession;
    try {
      const preferredTab = await chrome.tabs.get(existingPreferredTabId);
      if (isDebuggableUrl(preferredTab.url)) return { tabId: preferredTab.id, tab: preferredTab };
      if (!session.owned) {
        throw new CommandFailure(
          "bound_tab_not_debuggable",
          `Bound tab for session "${session.session}" is not debuggable (${preferredTab.url ?? "unknown URL"}).`,
          'Switch the tab to an http(s) page or run "bycli browser bind" on another tab.'
        );
      }
    } catch (err) {
      if (err instanceof CommandFailure) throw err;
      await removeLeaseSession(leaseKey, session);
      if (!session.owned) {
        throw new CommandFailure(
          "bound_tab_gone",
          `Bound tab for session "${session.session}" no longer exists.`,
          'Run "bycli browser bind" again, then retry the command.'
        );
      }
      return createOwnedTabLeaseUnlocked(leaseKey, initialUrl, blankFirst);
    }
  }
  if (!existingSession || existingSession.owned && existingSession.preferredTabId === null) {
    return createOwnedTabLeaseUnlocked(leaseKey, initialUrl, blankFirst);
  }
  const windowId = await getAutomationWindow(leaseKey, initialUrl);
  const tabs = await chrome.tabs.query({ windowId });
  const debuggableTab = tabs.find((t) => t.id && isDebuggableUrl(t.url));
  if (debuggableTab?.id) return { tabId: debuggableTab.id, tab: debuggableTab };
  const reuseTab = tabs.find((t) => t.id);
  if (reuseTab?.id) {
    await chrome.tabs.update(reuseTab.id, { url: BLANK_PAGE });
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const updated = await chrome.tabs.get(reuseTab.id);
      if (isDebuggableUrl(updated.url)) return { tabId: reuseTab.id, tab: updated };
      console.warn(`[bycli] data: URI was intercepted (${updated.url}), creating fresh tab`);
    } catch {
    }
  }
  const newTab = await chrome.tabs.create({
    windowId,
    url: BLANK_PAGE,
    active: getWindowModeForOwnedPage(leaseKey, BLANK_PAGE) === "foreground"
  });
  if (!newTab.id) throw new Error("Failed to create tab in automation container");
  return { tabId: newTab.id, tab: newTab };
}
async function pageScopedResult(id, tabId, data) {
  const page = await resolveTargetId(tabId);
  return { id, ok: true, data, page };
}
async function resolveTabId(tabId, leaseKey, initialUrl) {
  const resolved = await resolveTab(tabId, leaseKey, initialUrl);
  return resolved.tabId;
}
async function resolveTabIdUnlocked(tabId, leaseKey, initialUrl) {
  const resolved = await resolveTabUnlocked(tabId, leaseKey, initialUrl);
  return resolved.tabId;
}
async function listAutomationTabsUnlocked(leaseKey) {
  const session = automationSessions.get(leaseKey);
  if (!session) return [];
  if (session.preferredTabId !== null) {
    try {
      return [await chrome.tabs.get(session.preferredTabId)];
    } catch {
      await removeLeaseSession(leaseKey, session);
      return [];
    }
  }
  try {
    return await chrome.tabs.query({ windowId: session.windowId });
  } catch {
    await removeLeaseSession(leaseKey, session);
    return [];
  }
}
async function listAutomationWebTabs(leaseKey) {
  return withLeaseLock(leaseKey, () => listAutomationWebTabsUnlocked(leaseKey));
}
async function listAutomationWebTabsUnlocked(leaseKey) {
  const tabs = await listAutomationTabsUnlocked(leaseKey);
  return tabs.filter((tab) => isDebuggableUrl(tab.url));
}
async function handleExec(cmd, leaseKey) {
  if (!cmd.code) return { id: cmd.id, ok: false, error: "Missing code" };
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const aggressive = getSurfaceFromKey(leaseKey) === "browser";
    if (cmd.frameIndex != null) {
      const tree = await getFrameTree(tabId);
      const frames = enumerateCrossOriginFrames(tree);
      if (cmd.frameIndex < 0 || cmd.frameIndex >= frames.length) {
        return { id: cmd.id, ok: false, error: `Frame index ${cmd.frameIndex} out of range (${frames.length} cross-origin frames available)` };
      }
      const data2 = await evaluateInFrame(tabId, cmd.code, frames[cmd.frameIndex].frameId, aggressive);
      return pageScopedResult(cmd.id, tabId, data2);
    }
    const data = await evaluateAsync(tabId, cmd.code, aggressive);
    return pageScopedResult(cmd.id, tabId, data);
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function handleFrames(cmd, leaseKey) {
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const tree = await getFrameTree(tabId);
    return { id: cmd.id, ok: true, data: enumerateCrossOriginFrames(tree) };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function handleNavigate(cmd, leaseKey) {
  return withLeaseLock(leaseKey, () => handleNavigateUnlocked(cmd, leaseKey));
}
async function handleNavigateUnlocked(cmd, leaseKey) {
  if (!cmd.url) return { id: cmd.id, ok: false, error: "Missing url" };
  if (!isSafeNavigationUrl(cmd.url)) {
    return { id: cmd.id, ok: false, error: "Blocked URL scheme -- only http:// and https:// are allowed" };
  }
  const pre = checkUrlSyntax(cmd.url);
  if (!pre.ok) {
    return {
      id: cmd.id,
      ok: false,
      errorCode: "navigation_blocked_by_policy",
      error: `Navigation blocked by URL policy: ${pre.detail}`
    };
  }
  const cmdTabId = await resolveCommandTabId(cmd);
  const resolved = await resolveTabUnlocked(cmdTabId, leaseKey, cmd.url, true);
  const tabId = resolved.tabId;
  const beforeTab = resolved.tab ?? await chrome.tabs.get(tabId);
  const beforeNormalized = normalizeUrlForComparison(beforeTab.url);
  const targetUrl = cmd.url;
  if (beforeTab.status === "complete" && isTargetUrl(beforeTab.url, targetUrl)) {
    return pageScopedResult(cmd.id, tabId, { title: beforeTab.title, url: beforeTab.url, timedOut: false });
  }
  if (!hasActiveNetworkCapture(tabId)) {
    await detach(tabId);
  }
  const aggressive = getSurfaceFromKey(leaseKey) === "browser";
  let guard;
  try {
    guard = await armFetchGuard(tabId, (url) => checkUrlSyntax(url).ok, aggressive);
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      errorCode: "navigation_redirect_requires_interception",
      error: `Cannot arm navigation request interception: ${err instanceof Error ? err.message : String(err)}`,
      errorHint: "Navigation is refused because redirects cannot be checked before send."
    };
  }
  await chrome.tabs.update(tabId, { url: targetUrl });
  let timedOut = false;
  await new Promise((resolve) => {
    let settled = false;
    let checkTimer = null;
    let blockTimer = null;
    let timeoutTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (checkTimer) clearTimeout(checkTimer);
      if (blockTimer) clearInterval(blockTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    };
    const isNavigationDone = (url) => {
      return isTargetUrl(url, targetUrl) || normalizeUrlForComparison(url) !== beforeNormalized;
    };
    const listener = (id, info, tab2) => {
      if (id !== tabId) return;
      if (info.status === "complete" && isNavigationDone(tab2.url ?? info.url)) {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    checkTimer = setTimeout(async () => {
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (currentTab.status === "complete" && isNavigationDone(currentTab.url)) {
          finish();
        }
      } catch {
      }
    }, 100);
    blockTimer = setInterval(() => {
      if ((guard?.blocked.length ?? 0) > 0) {
        finish();
      }
    }, 100);
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.warn(`[bycli] Navigate to ${targetUrl} timed out after 15s`);
      finish();
    }, 15e3);
  });
  if ((guard?.blocked.length ?? 0) > 0) {
    return {
      id: cmd.id,
      ok: false,
      errorCode: "navigation_blocked_by_policy",
      error: `Navigation blocked by URL policy on redirect: ${guard?.blocked.join(", ")}`,
      errorHint: "A redirected main-frame request resolved to a forbidden target and was blocked before send."
    };
  }
  let tab = await chrome.tabs.get(tabId);
  const postNavigationSession = automationSessions.get(leaseKey);
  if (postNavigationSession && tab.windowId !== postNavigationSession.windowId) {
    console.warn(`[bycli] Tab ${tabId} drifted to window ${tab.windowId} during navigation, moving back to ${postNavigationSession.windowId}`);
    try {
      await chrome.tabs.move(tabId, { windowId: postNavigationSession.windowId, index: -1 });
      tab = await chrome.tabs.get(tabId);
    } catch (moveErr) {
      console.warn(`[bycli] Failed to recover drifted tab: ${moveErr}`);
    }
  }
  const navWindowMode = getWindowModeForOwnedPage(leaseKey, targetUrl);
  await focusOwnedWindowIfRequested(tab.windowId, navWindowMode);
  if (navWindowMode === "foreground") {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {
    });
  }
  return pageScopedResult(cmd.id, tabId, {
    title: tab.title,
    url: tab.url,
    timedOut,
    // M1: interception evidence for acceptance/observability. Extension capture form
    // is ip-observed-only per ADR-0006 (no DNS in SW; rebinding not closed here).
    interception: {
      armed: true,
      tier: "ip-observed-only",
      blocked: guard?.blocked ?? [],
      observedIps: guard?.observedIps ?? []
    }
  });
}
function captureFocusLease(leaseKey, lease) {
  if (!lease.owned || lease.preferredTabId === null) return null;
  return {
    revision: leaseRevisions.get(leaseKey) ?? 0,
    session: lease.session,
    surface: lease.surface,
    kind: lease.kind,
    windowId: lease.windowId,
    preferredTabId: lease.preferredTabId,
    contextId: lease.contextId,
    ownership: lease.ownership,
    lifecycle: lease.lifecycle,
    windowRole: lease.windowRole,
    windowMode: getWindowMode(leaseKey)
  };
}
function isFocusLeaseCurrent(leaseKey, expected) {
  const current = automationSessions.get(leaseKey);
  return (leaseRevisions.get(leaseKey) ?? 0) === expected.revision && current?.owned === true && current.session === expected.session && current.surface === expected.surface && current.kind === expected.kind && current.windowId === expected.windowId && current.preferredTabId === expected.preferredTabId && current.contextId === expected.contextId && current.ownership === expected.ownership && current.lifecycle === expected.lifecycle && current.windowRole === expected.windowRole && getWindowMode(leaseKey) === expected.windowMode;
}
function focusLeaseChangedResult(id) {
  return { id, ok: false, error: "Current automation lease changed during focus; no further focus action was performed" };
}
async function handleFocusUnlocked(cmd, leaseKey) {
  const currentSession = automationSessions.get(leaseKey);
  const focusLease = currentSession ? captureFocusLease(leaseKey, currentSession) : null;
  if (!focusLease) {
    return { id: cmd.id, ok: false, error: "No owned tab is leased to the current automation session" };
  }
  const cmdTabId = await resolveCommandTabId(cmd);
  if (!isFocusLeaseCurrent(leaseKey, focusLease)) return focusLeaseChangedResult(cmd.id);
  const tabId = cmdTabId ?? focusLease.preferredTabId;
  if (tabId !== focusLease.preferredTabId) {
    return { id: cmd.id, ok: false, error: "Page is not leased to the current automation session" };
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { id: cmd.id, ok: false, error: "Current automation session tab no longer exists" };
  }
  if (!isFocusLeaseCurrent(leaseKey, focusLease)) return focusLeaseChangedResult(cmd.id);
  if (!Number.isInteger(tab.windowId) || tab.windowId < 0 || tab.windowId !== focusLease.windowId) {
    return { id: cmd.id, ok: false, error: "Current automation session tab is outside its owned window" };
  }
  const updateWindow = chrome.windows.update;
  if (typeof updateWindow !== "function") throw new Error("chrome.windows.update is unavailable");
  const activatedTab = await chrome.tabs.update(tabId, { active: true });
  if (!isFocusLeaseCurrent(leaseKey, focusLease)) return focusLeaseChangedResult(cmd.id);
  if (activatedTab.id !== tabId || activatedTab.windowId !== focusLease.windowId) {
    return { id: cmd.id, ok: false, error: "Current automation session tab changed window during focus" };
  }
  await updateWindow(focusLease.windowId, { focused: true });
  if (!isFocusLeaseCurrent(leaseKey, focusLease)) return focusLeaseChangedResult(cmd.id);
  return { id: cmd.id, ok: true, data: { focused: true } };
}
async function handleTabNewUnlocked(cmd, leaseKey) {
  const currentSession = automationSessions.get(leaseKey);
  if (currentSession && !currentSession.owned) {
    return boundTabMutationResult(cmd, currentSession);
  }
  if (cmd.url && !isSafeNavigationUrl(cmd.url)) {
    return { id: cmd.id, ok: false, error: "Blocked URL scheme -- only http:// and https:// are allowed" };
  }
  if (!automationSessions.has(leaseKey)) {
    const created = await createOwnedTabLeaseUnlocked(leaseKey, cmd.url);
    return pageScopedResult(cmd.id, created.tabId, { url: created.tab?.url });
  }
  const newTabUrl = cmd.url ?? BLANK_PAGE;
  const windowId = await getAutomationWindow(leaseKey, cmd.url);
  const activateNewTab = getWindowModeForOwnedPage(leaseKey, newTabUrl) === "foreground";
  const tab = await chrome.tabs.create({ windowId, url: newTabUrl, active: activateNewTab });
  if (!tab.id) return { id: cmd.id, ok: false, error: "Failed to create tab" };
  await ensureOwnedContainerTabGroup(getOwnedWindowRole(leaseKey), windowId, [tab.id]);
  setLeaseSession(leaseKey, {
    session: getSessionFromKey(leaseKey),
    surface: getSurfaceFromKey(leaseKey),
    kind: "owned",
    windowId: tab.windowId,
    owned: true,
    preferredTabId: tab.id
  });
  resetWindowIdleTimer(leaseKey);
  return pageScopedResult(cmd.id, tab.id, { url: tab.url });
}
async function handleTabCloseUnlocked(cmd, leaseKey) {
  const lockedSession = automationSessions.get(leaseKey);
  if (lockedSession && !lockedSession.owned) {
    return boundTabMutationResult(cmd, lockedSession);
  }
  if (cmd.index !== void 0) {
    const tabs = await listAutomationWebTabsUnlocked(leaseKey);
    const target = tabs[cmd.index];
    if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
    const closedPage2 = await resolveTargetId(target.id).catch(() => void 0);
    const currentSession2 = automationSessions.get(leaseKey);
    if (currentSession2?.preferredTabId === target.id) {
      await releaseLeaseUnlocked(leaseKey, "tab close");
    } else {
      await safeDetach(target.id);
      await chrome.tabs.remove(target.id);
    }
    return { id: cmd.id, ok: true, data: { closed: closedPage2 } };
  }
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabIdUnlocked(cmdTabId, leaseKey);
  const closedPage = await resolveTargetId(tabId).catch(() => void 0);
  const currentSession = automationSessions.get(leaseKey);
  if (currentSession?.preferredTabId === tabId) {
    await releaseLeaseUnlocked(leaseKey, "tab close");
  } else {
    await safeDetach(tabId);
    await chrome.tabs.remove(tabId);
  }
  return { id: cmd.id, ok: true, data: { closed: closedPage } };
}
function boundTabMutationResult(cmd, session) {
  return {
    id: cmd.id,
    ok: false,
    errorCode: "bound_tab_mutation_blocked",
    error: `Session "${session.session}" is bound to a user tab; tab new/select/close/focus requires an owned byCLI session.`,
    errorHint: "Unbind the session first, or use a different session for owned byCLI tabs."
  };
}
async function handleTabSelectUnlocked(cmd, leaseKey) {
  const lockedSession = automationSessions.get(leaseKey);
  if (lockedSession && !lockedSession.owned) {
    return boundTabMutationResult(cmd, lockedSession);
  }
  if (cmd.index === void 0 && cmd.page === void 0) {
    return { id: cmd.id, ok: false, error: "Missing index or page" };
  }
  const cmdTabId = await resolveCommandTabId(cmd);
  if (cmdTabId !== void 0) {
    const session = automationSessions.get(leaseKey);
    let tab;
    try {
      tab = await chrome.tabs.get(cmdTabId);
    } catch {
      return { id: cmd.id, ok: false, error: "Page no longer exists" };
    }
    if (!session || tab.windowId !== session.windowId) {
      return { id: cmd.id, ok: false, error: "Page is not in the automation container" };
    }
    await chrome.tabs.update(cmdTabId, { active: true });
    return pageScopedResult(cmd.id, cmdTabId, { selected: true });
  }
  const tabs = await listAutomationWebTabsUnlocked(leaseKey);
  const target = tabs[cmd.index];
  if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
  await chrome.tabs.update(target.id, { active: true });
  return pageScopedResult(cmd.id, target.id, { selected: true });
}
async function handleTabs(cmd, leaseKey) {
  const session = automationSessions.get(leaseKey);
  if (session && !session.owned && cmd.op !== "list") {
    return boundTabMutationResult(cmd, session);
  }
  switch (cmd.op) {
    case "list": {
      const tabs = await listAutomationWebTabs(leaseKey);
      const data = await Promise.all(tabs.map(async (t, i) => {
        let page;
        try {
          page = t.id ? await resolveTargetId(t.id) : void 0;
        } catch {
        }
        return { index: i, page, url: t.url, title: t.title, active: t.active };
      }));
      return { id: cmd.id, ok: true, data };
    }
    case "new":
      return withLeaseLock(leaseKey, () => handleTabNewUnlocked(cmd, leaseKey));
    case "close":
      return withLeaseLock(leaseKey, () => handleTabCloseUnlocked(cmd, leaseKey));
    case "select":
      return withLeaseLock(leaseKey, () => handleTabSelectUnlocked(cmd, leaseKey));
    case "focus":
      return withLeaseLock(leaseKey, () => handleFocusUnlocked(cmd, leaseKey));
    default:
      return { id: cmd.id, ok: false, error: `Unknown tabs op: ${cmd.op}` };
  }
}
async function handleCookies(cmd) {
  if (!cmd.domain && !cmd.url) {
    return { id: cmd.id, ok: false, error: "Cookie scope required: provide domain or url to avoid dumping all cookies" };
  }
  const details = {};
  if (cmd.domain) details.domain = cmd.domain;
  if (cmd.url) details.url = cmd.url;
  const cookies = await chrome.cookies.getAll(details);
  const data = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: c.expirationDate
  }));
  return { id: cmd.id, ok: true, data };
}
async function handleScreenshot(cmd, leaseKey) {
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const data = await screenshot(tabId, {
      format: cmd.format,
      quality: cmd.quality,
      fullPage: cmd.fullPage,
      width: cmd.width,
      height: cmd.height
    });
    return pageScopedResult(cmd.id, tabId, data);
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
const CDP_ALLOWLIST = /* @__PURE__ */ new Set([
  // Agent DOM context
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.focus",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.scrollIntoViewIfNeeded",
  "DOMSnapshot.captureSnapshot",
  // Native input events
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  // 投屏滚动:synthesizeScrollGesture 真正驱动合成器滚动(dispatchMouseEvent mouseWheel 只发事件、很多页面不滚)。
  "Input.synthesizeScrollGesture",
  // Page metrics & screenshots
  "Page.getLayoutMetrics",
  "Page.captureScreenshot",
  "Page.getFrameTree",
  "Page.handleJavaScriptDialog",
  // Runtime.enable needed for CDP attach setup (Runtime.evaluate goes through 'exec' action)
  "Runtime.enable",
  // Emulation (used by screenshot full-page)
  "Emulation.setDeviceMetricsOverride",
  "Emulation.clearDeviceMetricsOverride"
]);
async function handleCdp(cmd, leaseKey) {
  if (!cmd.cdpMethod) return { id: cmd.id, ok: false, error: "Missing cdpMethod" };
  if (!CDP_ALLOWLIST.has(cmd.cdpMethod)) {
    return { id: cmd.id, ok: false, error: `CDP method not permitted: ${cmd.cdpMethod}` };
  }
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const aggressive = getSurfaceFromKey(leaseKey) === "browser";
    await ensureAttached(tabId, aggressive);
    const params = cmd.cdpParams ?? {};
    const routeFrameId = typeof params.frameId === "string" && params.sessionId === "target" ? params.frameId : void 0;
    const routeTargetUrl = typeof params.targetUrl === "string" ? params.targetUrl : void 0;
    const data = routeFrameId ? await sendCommandInFrameTarget(tabId, routeFrameId, cmd.cdpMethod, stripbyCliFrameRoutingParams(params, true), aggressive, 3e4, routeTargetUrl) : await chrome.debugger.sendCommand(
      { tabId },
      cmd.cdpMethod,
      stripbyCliFrameRoutingParams(params, false)
    );
    return pageScopedResult(cmd.id, tabId, data);
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function stripbyCliFrameRoutingParams(params, stripFrameId) {
  const { sessionId, frameId, targetUrl, ...rest } = params;
  if (!stripFrameId && frameId !== void 0) return { ...rest, frameId };
  return rest;
}
async function handleCloseWindow(cmd, leaseKey) {
  const sessionName = automationSessions.get(leaseKey)?.session ?? getSessionFromKey(leaseKey);
  await releaseLease(leaseKey, "explicit close");
  return { id: cmd.id, ok: true, data: { closed: true, session: sessionName } };
}
async function handleSetFileInput(cmd, leaseKey) {
  if (!cmd.files || !Array.isArray(cmd.files) || cmd.files.length === 0) {
    return { id: cmd.id, ok: false, error: "Missing or empty files array" };
  }
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    await setFileInputFiles(tabId, cmd.files, cmd.selector);
    return pageScopedResult(cmd.id, tabId, { count: cmd.files.length });
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function handleInsertText(cmd, leaseKey) {
  if (typeof cmd.text !== "string") {
    return { id: cmd.id, ok: false, error: "Missing text payload" };
  }
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    await insertText(tabId, cmd.text);
    return pageScopedResult(cmd.id, tabId, { inserted: true });
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function handleNetworkCaptureStart(cmd, leaseKey) {
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    await startNetworkCapture(tabId, cmd.pattern);
    return pageScopedResult(cmd.id, tabId, { started: true });
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function errorCodeOf(err) {
  const c = err?.code;
  return typeof c === "string" ? c : void 0;
}
async function handleNetworkCaptureRead(cmd, leaseKey) {
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const data = await readNetworkCapture(tabId, cmd.targetFrameUrl ? { targetFrameUrl: cmd.targetFrameUrl } : void 0);
    return pageScopedResult(cmd.id, tabId, data);
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err), errorCode: errorCodeOf(err) };
  }
}
async function handleUiCaptureStart(cmd, leaseKey) {
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    await startUiCapture(tabId);
    return pageScopedResult(cmd.id, tabId, { started: true });
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function handleUiCaptureRead(cmd, leaseKey) {
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const data = await readUiCapture(tabId, cmd.targetFrameUrl ? { targetFrameUrl: cmd.targetFrameUrl } : void 0);
    return pageScopedResult(cmd.id, tabId, data);
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err), errorCode: errorCodeOf(err) };
  }
}
async function handleWaitDownload(cmd) {
  try {
    const data = await waitForDownload(cmd.pattern ?? "", cmd.timeoutMs ?? 3e4);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function releaseLease(leaseKey, reason = "released") {
  return withLeaseLock(leaseKey, () => releaseLeaseUnlocked(leaseKey, reason));
}
async function releaseLeaseUnlocked(leaseKey, reason) {
  const session = automationSessions.get(leaseKey);
  if (!session) {
    sessionTimeoutOverrides.delete(leaseKey);
    sessionWindowModeOverrides.delete(leaseKey);
    sessionLifecycleOverrides.delete(leaseKey);
    cancelIdleExpiry(leaseKey);
    await persistRuntimeState();
    return;
  }
  if (session.idleTimer) clearTimeout(session.idleTimer);
  cancelIdleExpiry(leaseKey);
  if (session.owned) {
    const tabId = session.preferredTabId;
    if (tabId !== null) {
      const hasOtherOwnedLease = [...automationSessions.entries()].some(
        ([otherLease, otherSession]) => otherLease !== leaseKey && otherSession.owned && otherSession.windowId === session.windowId && otherSession.preferredTabId !== null
      );
      await safeDetach(tabId);
      evictTab(tabId);
      if (hasOtherOwnedLease) {
        await chrome.tabs.remove(tabId).catch(() => {
        });
        console.log(`[bycli] Released owned tab lease ${tabId} (session=${session.session}, surface=${session.surface}, ${reason})`);
      } else {
        try {
          const tab = await chrome.tabs.update(tabId, {
            url: BLANK_PAGE,
            active: getWindowModeForOwnedPage(leaseKey, BLANK_PAGE) === "foreground"
          });
          await ensureOwnedContainerTabGroup(getOwnedWindowRole(leaseKey), session.windowId, [tab.id ?? tabId]);
          console.log(`[bycli] Released owned tab lease ${tabId} as reusable placeholder (session=${session.session}, surface=${session.surface}, ${reason})`);
        } catch {
          await chrome.tabs.remove(tabId).catch(() => {
          });
          console.log(`[bycli] Released owned tab lease ${tabId} (session=${session.session}, surface=${session.surface}, ${reason})`);
        }
      }
    } else {
      console.log(`[bycli] Released legacy owned window lease ${session.windowId} without closing container (session=${session.session}, surface=${session.surface}, ${reason})`);
    }
  } else if (session.preferredTabId !== null) {
    await safeDetach(session.preferredTabId);
    console.log(`[bycli] Detached borrowed tab lease ${session.preferredTabId} (session=${session.session}, surface=${session.surface}, ${reason})`);
  }
  if (automationSessions.get(leaseKey) === session) {
    deleteAutomationSession(leaseKey);
    sessionTimeoutOverrides.delete(leaseKey);
    sessionWindowModeOverrides.delete(leaseKey);
    sessionLifecycleOverrides.delete(leaseKey);
  }
  await persistRuntimeState();
}
async function reconcileTargetLeaseRegistry() {
  const registry = await readRegistry();
  for (const role of Object.keys(ownedContainers)) {
    ownedContainers[role].windowId = registry.ownedContainers[role]?.windowId ?? null;
    ownedContainers[role].groupId = registry.ownedContainers[role]?.groupId ?? null;
    const windowId = ownedContainers[role].windowId;
    if (windowId !== null) {
      try {
        await chrome.windows.get(windowId);
      } catch {
        ownedContainers[role].windowId = null;
        ownedContainers[role].groupId = null;
      }
    }
  }
  clearAutomationSessions();
  for (const [leaseKey, stored] of Object.entries(registry.leases)) {
    const tabId = stored.preferredTabId;
    if (tabId === null) continue;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isDebuggableUrl(tab.url)) continue;
      if (stored.lifecycle === "ephemeral" || stored.lifecycle === "persistent" || stored.lifecycle === "pinned") {
        sessionLifecycleOverrides.set(leaseKey, stored.lifecycle);
      }
      const session = makeSession(leaseKey, {
        session: typeof stored.session === "string" ? stored.session : getSessionFromKey(leaseKey),
        surface: stored.surface === "adapter" ? "adapter" : getSurfaceFromKey(leaseKey),
        kind: stored.kind === "bound" || stored.owned === false ? "bound" : "owned",
        windowId: tab.windowId,
        owned: stored.owned,
        preferredTabId: tabId
      });
      const timeout = getIdleTimeout(leaseKey);
      storeAutomationSession(leaseKey, {
        ...session,
        idleTimer: null,
        idleDeadlineAt: stored.idleDeadlineAt
      });
      if (session.owned) {
        const role = getOwnedWindowRole(leaseKey);
        if (ownedContainers[role].windowId === null) ownedContainers[role].windowId = tab.windowId;
        await ensureOwnedContainerTabGroup(role, tab.windowId, [tabId]);
      }
      const remaining = stored.idleDeadlineAt > 0 ? stored.idleDeadlineAt - Date.now() : timeout;
      if (timeout > 0) {
        if (remaining <= 0) {
          await releaseLease(leaseKey, "reconciled idle expiry");
        } else {
          resetWindowIdleTimer(leaseKey);
        }
      }
    } catch {
    }
  }
  await persistRuntimeState();
}
async function handleBind(cmd, leaseKey) {
  return withLeaseLock(leaseKey, () => handleBindUnlocked(cmd, leaseKey));
}
async function handleBindUnlocked(cmd, leaseKey) {
  const existing = automationSessions.get(leaseKey);
  if (existing?.owned) {
    await releaseLeaseUnlocked(leaseKey, "rebind");
  }
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const fallbackTabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const boundTab = activeTabs.find((tab) => isDebuggableUrl(tab.url)) ?? fallbackTabs.find((tab) => isDebuggableUrl(tab.url));
  if (!boundTab?.id) {
    return {
      id: cmd.id,
      ok: false,
      errorCode: "bound_tab_not_found",
      error: "No debuggable tab found in the current window",
      errorHint: "Focus the target Chrome tab/window, then retry bind."
    };
  }
  const current = automationSessions.get(leaseKey);
  if (current && !current.owned && current.preferredTabId !== null && current.preferredTabId !== boundTab.id) {
    await detach(current.preferredTabId).catch(() => {
    });
  }
  setLeaseSession(leaseKey, {
    session: getSessionFromKey(leaseKey),
    surface: getSurfaceFromKey(leaseKey),
    kind: "bound",
    windowId: boundTab.windowId,
    owned: false,
    preferredTabId: boundTab.id
  });
  resetWindowIdleTimer(leaseKey);
  console.log(`[bycli] Session ${getSessionFromKey(leaseKey)} explicitly bound to tab ${boundTab.id} (${boundTab.url})`);
  return pageScopedResult(cmd.id, boundTab.id, {
    url: boundTab.url,
    title: boundTab.title,
    session: getSessionFromKey(leaseKey)
  });
}
