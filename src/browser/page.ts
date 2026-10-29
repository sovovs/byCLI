/**
 * Page abstraction — implements IPage by sending commands to the daemon.
 *
 * All browser operations are ultimately 'exec' (JS evaluation via CDP)
 * plus a few native Chrome Extension APIs (tabs, cookies, navigate).
 *
 * IMPORTANT: After goto(), we remember the page identity (targetId) returned
 * by the navigate action and pass it to all subsequent commands. This ensures
 * page-scoped operations target the correct page without guessing.
 */

import type {
  BrowserCookie,
  BrowserConsoleMessage,
  BrowserDownloadWaitOptions,
  BrowserDownloadWaitResult,
  BrowserEvaluateFunction,
  ScreenshotOptions,
} from '../types.js';
import { fetchDaemonStatus, requestExtensionReconnect, sendCommand, sendCommandFull, sendCommandOnce } from './daemon-client.js';
import { isExtensionCapabilityMissing, recoverExtensionCapability } from './extension-recovery.js';
import { CONSOLE_CAPTURE_CAPABILITY, extensionCapabilityHint, FILE_INPUT_SHADOW_CAPABILITY, FOCUS_WINDOW_CAPABILITY } from './extension-capabilities.js';
import { buildEvaluateExpression } from './utils.js';
import { saveBase64ToFile } from '../utils.js';
import { generateStealthJs } from './stealth.js';
import { waitForDomStableJs } from './dom-helpers.js';
import { BasePage } from './base-page.js';
import { classifyBrowserError } from './errors.js';
import { log } from '../logger.js';
import { resolveTargetJs, boundingRectResolvedJs, type ResolveOptions } from './target-resolver.js';
import { TargetError } from './target-errors.js';

function isUnsupportedNetworkCaptureError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  return (normalized.includes('unknown action') && normalized.includes('network-capture'))
    || (normalized.includes('network capture') && normalized.includes('not supported'));
}

// The extension throws "Page not found: <id> — stale page identity" when our cached
// `_page` targetId no longer maps to a live tab — e.g. the user closed the automation
// window, or a long-running script left the cache pointing at an evicted target.
// Detect that signature so goto() can drop the stale id and let resolveTab fall back
// to the session lease (or create a fresh tab).
function isStalePageIdentityError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('stale page identity');
}

/**
 * Page — implements IPage by talking to the daemon via HTTP.
 */
export class Page extends BasePage {
  private readonly _idleTimeout: number | undefined;

  constructor(
    private readonly session: string,
    idleTimeout?: number,
    public contextId?: string,
    private readonly windowMode?: 'foreground' | 'background',
    private readonly surface: 'browser' | 'adapter' = 'browser',
    private readonly siteSession?: 'ephemeral' | 'persistent',
  ) {
    super();
    this._idleTimeout = idleTimeout;
  }

  setContextId(contextId: string): void {
    this.contextId = contextId;
  }

  /** Active page identity (targetId), set after navigate and used in all subsequent commands */
  private _page: string | undefined;
  private _dialogToken: string | undefined;
  private _networkCaptureUnsupported = false;
  private _networkCaptureWarned = false;

  /** Helper: spread session into command params */
  private _sessionOpts(): { session: string; surface: 'browser' | 'adapter'; idleTimeout?: number; contextId?: string; windowMode?: 'foreground' | 'background'; siteSession?: 'ephemeral' | 'persistent'; dialogToken?: string } {
    return {
      session: this.session,
      surface: this.surface,
      ...(this._dialogToken && { dialogToken: this._dialogToken }),
      ...(this.contextId && { contextId: this.contextId }),
      ...(this._idleTimeout != null && { idleTimeout: this._idleTimeout }),
      ...(this.windowMode && { windowMode: this.windowMode }),
      ...(this.siteSession && { siteSession: this.siteSession }),
    };
  }

  /** Helper: spread session + page identity into command params */
  private _cmdOpts(): Record<string, unknown> {
    return {
      session: this.session,
      surface: this.surface,
      ...(this._dialogToken && { dialogToken: this._dialogToken }),
      ...(this.contextId && { contextId: this.contextId }),
      ...(this._page !== undefined && { page: this._page }),
      ...(this._idleTimeout != null && { idleTimeout: this._idleTimeout }),
      ...(this.windowMode && { windowMode: this.windowMode }),
      ...(this.siteSession && { siteSession: this.siteSession }),
    };
  }

  async withAcceptedDialogs<T>(origin: string, run: () => Promise<T>, timeoutMs = 180000): Promise<T> {
    if (this._dialogToken) throw new Error('A dialog policy is already active on this page');
    const token = crypto.randomUUID();
    try {
      const started = await sendCommandFull('dialog-policy', {
        ...this._cmdOpts(), op: 'start', dialogOrigin: origin, dialogToken: token, timeoutMs,
      });
      if (started.page) this._page = started.page;
      this._dialogToken = token;
      return await run();
    } finally {
      try { await sendCommandOnce('dialog-policy', { ...this._sessionOpts(), op: 'stop', dialogToken: token }); }
      catch { log.warn('Dialog policy cleanup could not be confirmed; it will expire automatically.'); }
      this._dialogToken = undefined;
    }
  }

  async goto(url: string, options?: { waitUntil?: 'load' | 'none'; settleMs?: number; stealth?: boolean }): Promise<void> {
    let result: { data: unknown; page?: string };
    try {
      result = await sendCommandFull('navigate', {
        url,
        ...(options?.waitUntil && { waitUntil: options.waitUntil }),
        ...this._cmdOpts(),
      });
    } catch (err) {
      // If our cached targetId went stale (tab closed externally, identity evicted),
      // drop the dead id and retry without it — the extension will resolve through the
      // session lease or open a fresh automation tab. Without this, subsequent
      // navigations in the same Page instance keep re-sending the same dead targetId
      // and cascade into "Page not found:" failures.
      if (!isStalePageIdentityError(err) || this._page === undefined || this._dialogToken) throw err;
      this._page = undefined;
      result = await sendCommandFull('navigate', {
        url,
        ...(options?.waitUntil && { waitUntil: options.waitUntil }),
        ...this._cmdOpts(),
      });
    }
    // Remember the page identity (targetId) for subsequent calls
    if (result.page) {
      this._page = result.page;
    }
    this._lastUrl = url;
    const refreshUrl = async (): Promise<void> => {
      try {
        const current = await this.evaluate<string>('window.location.href');
        if (typeof current === 'string' && current) this._lastUrl = current;
      } catch {
        // Navigation may still be settling; retain the requested URL as fallback.
      }
    };
    // Inject stealth + settle in a single round-trip instead of two sequential exec calls.
    // Some security-sensitive editors reject runtime environment patches, so callers can
    // retain the normal DOM-settle behavior while opting out of stealth injection.
    const useStealth = options?.stealth !== false;
    if (options?.waitUntil !== 'none') {
      const maxMs = options?.settleMs ?? 1000;
      const settleCode = waitForDomStableJs(maxMs, Math.min(500, maxMs));
      const combinedCode = useStealth ? `${generateStealthJs()};\n${settleCode}` : settleCode;
      const combinedOpts = {
        code: combinedCode,
        ...this._cmdOpts(),
      };
      try {
        await sendCommand('exec', combinedOpts);
      } catch (err) {
        const advice = classifyBrowserError(err);
        // Only settle-retry on target navigation (SPA client-side redirects).
        // Extension/daemon errors are already retried by sendCommandRaw —
        // retrying them here would silently swallow real failures.
        if (advice.kind !== 'target-navigation') throw err;
        try {
          await new Promise((r) => setTimeout(r, advice.delayMs));
          await sendCommand('exec', combinedOpts);
        } catch (retryErr) {
          if (classifyBrowserError(retryErr).kind !== 'target-navigation') throw retryErr;
        }
      }
      await refreshUrl();
    } else if (useStealth) {
      // Even with waitUntil='none', still inject stealth (best-effort)
      try {
        await sendCommand('exec', {
          code: generateStealthJs(),
          ...this._cmdOpts(),
        });
      } catch {
        // Non-fatal: stealth is best-effort
      }
      await refreshUrl();
    }
  }

  /** Get the active page identity (targetId) */
  getActivePage(): string | undefined {
    return this._page;
  }

  /** Bind this Page instance to a specific page identity (targetId). */
  setActivePage(page?: string): void {
    this._page = page;
    this._lastUrl = null;
  }
  private _markUnsupportedNetworkCapture(): void {
    this._networkCaptureUnsupported = true;
    if (this._networkCaptureWarned) return;
    this._networkCaptureWarned = true;
    log.warn(
      'Browser Bridge extension does not support network capture; continuing without it. ' +
      'Explore output may miss API endpoints until you reload or reinstall the extension.',
    );
  }

  async evaluate<T = unknown>(js: string): Promise<T>;
  async evaluate<Args extends unknown[], T>(fn: BrowserEvaluateFunction<Args, T>, ...args: Args): Promise<Awaited<T>>;
  async evaluate(input: string | BrowserEvaluateFunction<unknown[], unknown>, ...args: unknown[]): Promise<unknown> {
    const code = buildEvaluateExpression(input, args);
    try {
      return await sendCommand('exec', { code, ...this._cmdOpts() });
    } catch (err) {
      const advice = classifyBrowserError(err);
      if (advice.kind !== 'target-navigation') throw err;
      await new Promise((resolve) => setTimeout(resolve, advice.delayMs));
      return sendCommand('exec', { code, ...this._cmdOpts() });
    }
  }

  async evaluateOnce<T = unknown>(js: string): Promise<T> {
    return await sendCommandOnce('exec', { code: buildEvaluateExpression(js, []), ...this._cmdOpts() }) as T;
  }


  async getCookies(opts: { domain?: string; url?: string } = {}): Promise<BrowserCookie[]> {
    const result = await sendCommand('cookies', { ...this._sessionOpts(), ...opts });
    return Array.isArray(result) ? result : [];
  }

  async focusWindow(): Promise<void> {
    const status = await fetchDaemonStatus(this.contextId ? { contextId: this.contextId } : undefined);
    const selectedExtensionIsConnected = status?.extensionConnected === true
      && status.profileRequired !== true
      && status.profileDisconnected !== true;
    const capabilities = status?.extensionCapabilities;
    const capabilityListIsDefinitive = Array.isArray(capabilities);
    if (selectedExtensionIsConnected
      && capabilityListIsDefinitive
      && !capabilities.includes(FOCUS_WINDOW_CAPABILITY)) {
      throw new Error(
        `Connected Browser Bridge does not advertise ${FOCUS_WINDOW_CAPABILITY}. ${extensionCapabilityHint(FOCUS_WINDOW_CAPABILITY)}`,
      );
    }
    await sendCommandFull('tabs', {
      op: 'focus',
      ...this._cmdOpts(),
      ...this._sessionOpts(),
    });
  }

  async consoleMessages(level: string = 'all'): Promise<BrowserConsoleMessage[]> {
    const status = await fetchDaemonStatus(this.contextId ? { contextId: this.contextId } : undefined);
    const hint = extensionCapabilityHint(CONSOLE_CAPTURE_CAPABILITY);
    if (status?.extensionConnected === true && !status.profileRequired && !status.profileDisconnected
      && Array.isArray(status.extensionCapabilities) && !status.extensionCapabilities.includes(CONSOLE_CAPTURE_CAPABILITY)) {
      throw new Error(`Connected Browser Bridge does not advertise ${CONSOLE_CAPTURE_CAPABILITY}. ${hint}`);
    }
    try {
      const data = await sendCommand('console-messages', { ...this._cmdOpts(), level });
      if (!Array.isArray(data)) throw new Error('Browser Bridge returned an invalid console snapshot.');
      return data;
    } catch (err) {
      if (/unknown action.*console-messages/i.test(err instanceof Error ? err.message : String(err))) {
        throw new Error(`Browser Bridge does not support ${CONSOLE_CAPTURE_CAPABILITY}. ${hint}`, { cause: err });
      }
      throw err;
    }
  }

  /** Release the current browser session lease in the extension */
  async closeWindow(): Promise<void> {
    try {
      await sendCommand('close-window', { ...this._sessionOpts() });
    } catch {
      // Window may already be closed or daemon may be down
    } finally {
      this._page = undefined;
      this._lastUrl = null;
      this._networkCaptureUnsupported = false;
      this._networkCaptureWarned = false;
    }
  }

  async tabs(): Promise<unknown[]> {
    const result = await sendCommand('tabs', { op: 'list', ...this._sessionOpts() });
    return Array.isArray(result) ? result : [];
  }

  async newTab(url?: string): Promise<string | undefined> {
    const result = await sendCommandFull('tabs', {
      op: 'new',
      ...(url !== undefined && { url }),
      ...this._sessionOpts(),
    });
    this._lastUrl = null;
    return result.page;
  }

  async closeTab(target?: number | string): Promise<void> {
    const params: Record<string, unknown> = { op: 'close', ...this._sessionOpts() };
    if (typeof target === 'number') params.index = target;
    else if (typeof target === 'string') params.page = target;
    else if (this._page !== undefined) params.page = this._page;

    const result = await sendCommand('tabs', params) as { closed?: string } | null;
    const closedPage = typeof result?.closed === 'string' ? result.closed : undefined;

    if ((closedPage && closedPage === this._page) || (!closedPage && (target === undefined || target === this._page))) {
      this._page = undefined;
      this._lastUrl = null;
    }
  }

  async selectTab(target: number | string): Promise<void> {
    const result = await sendCommandFull('tabs', {
      op: 'select',
      ...(typeof target === 'number' ? { index: target } : { page: target }),
      ...this._sessionOpts(),
    });
    if (result.page) this._page = result.page;
    this._lastUrl = null;
  }

  /**
   * Capture a screenshot via CDP Page.captureScreenshot.
   */
  async screenshot(options: ScreenshotOptions = {}): Promise<string> {
    const base64 = await sendCommand('screenshot', {
      ...this._cmdOpts(),
      format: options.format,
      quality: options.quality,
      fullPage: options.fullPage,
      width: options.width,
      height: options.height,
      dpr: options.dpr,
    }) as string;

    if (options.path) {
      await saveBase64ToFile(base64, options.path);
    }

    return base64;
  }

  async startNetworkCapture(pattern: string = ''): Promise<boolean> {
    if (this._networkCaptureUnsupported) return false;
    try {
      await sendCommand('network-capture-start', {
        pattern,
        ...this._cmdOpts(),
      });
      return true;
    } catch (err) {
      if (!isUnsupportedNetworkCaptureError(err)) throw err;
      this._markUnsupportedNetworkCapture();
      return false;
    }
  }

  async readNetworkCapture(): Promise<unknown[]> {
    if (this._networkCaptureUnsupported) return [];
    try {
      const result = await sendCommand('network-capture-read', {
        ...this._cmdOpts(),
      });
      return Array.isArray(result) ? result : [];
    } catch (err) {
      if (!isUnsupportedNetworkCaptureError(err)) throw err;
      this._markUnsupportedNetworkCapture();
      return [];
    }
  }

  async startImaAuthCapture(): Promise<void> {
    await sendCommand('ima-auth-start', this._cmdOpts());
  }

  async readImaAuth(): Promise<{ authId: string } | null> {
    const result = await sendCommand('ima-auth-read', this._cmdOpts());
    if (!result || typeof result !== 'object' || typeof (result as { authId?: unknown }).authId !== 'string') return null;
    return { authId: (result as { authId: string }).authId };
  }

  async requestImaReader(authId: string, path: string, body: Record<string, unknown>): Promise<unknown> {
    return sendCommand('ima-reader-request', {
      authId,
      readerPath: path,
      readerBody: body,
      ...this._cmdOpts(),
    });
  }

  async requestImaMedia(authId: string, body: Record<string, unknown>): Promise<unknown> {
    return sendCommand('ima-media-request', { authId, mediaBody: body, ...this._cmdOpts() });
  }

  async releaseImaAuth(authId: string): Promise<void> {
    await sendCommand('ima-auth-release', { authId, ...this._cmdOpts() });
  }

  async waitForDownload(
    pattern: string = '',
    timeoutMs: number = 30_000,
    options?: BrowserDownloadWaitOptions,
  ): Promise<BrowserDownloadWaitResult> {
    const result = await sendCommand('wait-download', {
      pattern,
      timeoutMs,
      ...(options?.includeRecent === undefined ? {} : { includeRecent: options.includeRecent }),
      ...(options?.startedAfterMs === undefined ? {} : { startedAfterMs: options.startedAfterMs }),
      ...this._cmdOpts(),
    });
    return result as BrowserDownloadWaitResult;
  }

  /**
   * Set local file paths on a file input element via CDP DOM.setFileInputFiles.
   * Chrome reads the files directly from the local filesystem, avoiding the
   * payload size limits of base64-in-evaluate.
   */
  async setFileInput(files: string[], selector?: string): Promise<void> {
    try {
      await this.#setFileInputOnce(files, selector);
    } catch (err) {
      if (!isExtensionCapabilityMissing(err) || !(err instanceof Error) || !err.message.includes(FILE_INPUT_SHADOW_CAPABILITY)) throw err;
      // Pin recovery to the profile that handled the upload, even when no profile was explicit.
      const status = await fetchDaemonStatus(this.contextId ? { contextId: this.contextId } : undefined).catch(() => undefined);
      const contextId = this.contextId ?? status?.contextId;
      if (!contextId) throw err;
      const recovered = await recoverExtensionCapability(FILE_INPUT_SHADOW_CAPABILITY, {
        contextId,
        requestReconnect: () => requestExtensionReconnect({ contextId }),
        fetchCapabilities: async () => {
          const status = await fetchDaemonStatus({ contextId });
          return Array.isArray(status?.extensionCapabilities) ? status.extensionCapabilities : undefined;
        },
      });
      if (!recovered) throw err;
      await this.#setFileInputOnce(files, selector, contextId);
    }
  }

  async #setFileInputOnce(files: string[], selector?: string, contextId?: string): Promise<void> {
    const result = await sendCommand('set-file-input', {
      files,
      selector,
      ...this._cmdOpts(),
      ...(contextId ? { contextId } : {}),
    }) as { count?: number };
    if (!result?.count) {
      throw new Error('setFileInput returned no count — command may not be supported by the extension');
    }
  }

  async insertText(text: string): Promise<void> {
    const result = await sendCommand('insert-text', {
      text,
      ...this._cmdOpts(),
    }) as { inserted?: boolean };
    if (!result?.inserted) {
      throw new Error('insertText returned no inserted flag — command may not be supported by the extension');
    }
  }

  async frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string }>> {
    const result = await sendCommand('frames', { ...this._cmdOpts() });
    return Array.isArray(result) ? result : [];
  }

  async evaluateInFrame(js: string, frameIndex: number): Promise<unknown> {
    const code = buildEvaluateExpression(js);
    return sendCommand('exec', { code, frameIndex, ...this._cmdOpts() });
  }

  async cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return sendCommand('cdp', {
      cdpMethod: method,
      cdpParams: params,
      ...this._cmdOpts(),
    });
  }

  async handleJavaScriptDialog(accept: boolean, promptText?: string): Promise<void> {
    await this.cdp('Page.handleJavaScriptDialog', {
      accept,
      ...(promptText !== undefined && { promptText }),
    });
  }

  /** CDP native click fallback — called when JS el.click() fails */
  protected override async tryNativeClick(x: number, y: number): Promise<boolean> {
    try {
      await this.nativeClick(x, y);
      return true;
    } catch {
      return false;
    }
  }

  /** Precise click using DOM.getContentQuads/getBoxModel for inline elements */
  async clickWithQuads(ref: string): Promise<void> {
    const safeRef = JSON.stringify(ref);
    const cssSelector = `[data-bycli-ref="${ref.replace(/"/g, '\\"')}"]`;

    // Scroll element into view first
    await this.evaluate(`
      (() => {
        const el = document.querySelector('[data-bycli-ref="' + ${safeRef} + '"]');
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
        return !!el;
      })()
    `);

    try {
      // Find DOM node via CDP
      const doc = await this.cdp('DOM.getDocument', {}) as { root: { nodeId: number } };
      const result = await this.cdp('DOM.querySelectorAll', {
        nodeId: doc.root.nodeId,
        selector: cssSelector,
      }) as { nodeIds: number[] };

      if (!result.nodeIds?.length) throw new Error('DOM node not found');

      const nodeId = result.nodeIds[0];

      // Try getContentQuads first (precise for inline elements)
      try {
        const quads = await this.cdp('DOM.getContentQuads', { nodeId }) as { quads: number[][] };
        if (quads.quads?.length) {
          const q = quads.quads[0];
          const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
          const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
          await this.nativeClick(Math.round(cx), Math.round(cy));
          return;
        }
      } catch { /* fallthrough */ }

      // Try getBoxModel
      try {
        const box = await this.cdp('DOM.getBoxModel', { nodeId }) as { model: { content: number[] } };
        if (box.model?.content) {
          const c = box.model.content;
          const cx = (c[0] + c[2] + c[4] + c[6]) / 4;
          const cy = (c[1] + c[3] + c[5] + c[7]) / 4;
          await this.nativeClick(Math.round(cx), Math.round(cy));
          return;
        }
      } catch { /* fallthrough */ }
    } catch { /* fallthrough */ }

    // Final fallback: regular click
    await this.evaluate(`
      (() => {
        const el = document.querySelector('[data-bycli-ref="' + ${safeRef} + '"]');
        if (!el) throw new Error('Element not found: ' + ${safeRef});
        el.click();
        return 'clicked';
      })()
    `);
  }

  async nativeClick(x: number, y: number): Promise<void> {
    await this.cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
    await this.cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x, y,
      button: 'left',
      clickCount: 1,
    });
    await this.cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x, y,
      button: 'left',
      clickCount: 1,
    });
  }

  async nativeClickOnce(x: number, y: number): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
      throw new Error('Native click requires finite nonnegative viewport coordinates');
    }
    const dispatch = (params: Record<string, unknown>) => sendCommandOnce('cdp', {
      cdpMethod: 'Input.dispatchMouseEvent', cdpParams: { x, y, ...params }, ...this._cmdOpts(),
    });
    await dispatch({ type: 'mouseMoved' });
    // Release even if the press response is lost: finish the same gesture,
    // without another press or leaving the shared browser button held down.
    let pressError: unknown;
    try { await dispatch({ type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 }); }
    catch (error) { pressError = error; }
    try { await dispatch({ type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 }); }
    catch (error) { if (!pressError) throw error; }
    if (pressError) throw pressError;
  }

  async clickOnce(ref: string, opts: ResolveOptions = {}): Promise<void> {
    const target = await this.evaluate(resolveTargetJs(ref, opts)) as { ok: boolean; code: ConstructorParameters<typeof TargetError>[0]['code']; message: string; hint: string };
    if (!target.ok) throw new TargetError(target);
    const rect = await this.evaluate(boundingRectResolvedJs()) as { x: number; y: number; visible: boolean } | null;
    if (!rect?.visible) throw new Error('Single-execution click requires a visible, connected target');
    const hit = await this.evaluate(`(() => {
      const el = window.__resolved;
      if (!el?.isConnected) return false;
      let node = document.elementFromPoint(${rect.x}, ${rect.y});
      for (;;) { const inner = node?.shadowRoot?.elementFromPoint?.(${rect.x}, ${rect.y}); if (!inner || inner === node) break; node = inner; }
      return !!node && (el === node || el.contains(node));
    })()`);
    if (!hit) throw new Error('Single-execution click target is detached or obscured');
    await this.nativeClickOnce(rect.x, rect.y);
  }

  async nativeType(text: string): Promise<void> {
    // Use Input.insertText for reliable Unicode/CJK text insertion
    await this.cdp('Input.insertText', { text });
  }

  async nativeKeyPress(key: string, modifiers: string[] = []): Promise<void> {
    let modifierFlags = 0;
    for (const mod of modifiers) {
      if (mod === 'Alt') modifierFlags |= 1;
      if (mod === 'Ctrl' || mod === 'Control') modifierFlags |= 2;
      if (mod === 'Meta') modifierFlags |= 4;
      if (mod === 'Shift') modifierFlags |= 8;
    }
    await this.cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      modifiers: modifierFlags,
    });
    await this.cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      modifiers: modifierFlags,
    });
  }
}
