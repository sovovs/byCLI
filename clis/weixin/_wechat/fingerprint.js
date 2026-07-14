import { CliError, CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';

const STATE_KEY = '__bycliWechatSearchBizCapture';
const POLL_INTERVAL_MS = 100;

/** @param {any} page @param {string} query @param {number} [timeoutMs] */
export async function captureSearchBizFingerprint(page, query, timeoutMs = 30_000) {
  const startedAt = Date.now();
  try {
    const installed = await page.evaluate(({ operation, query: searchQuery, stateKey }) => {
      if (operation !== 'install') return { submitted: false };
      const root = /** @type {any} */ (window);
      const originalFetch = root.fetch;
      const originalOpen = root.XMLHttpRequest?.prototype?.open;
      const state = { fingerprint: null };
      Object.defineProperty(root, stateKey, { configurable: true, value: state });

      const capture = input => {
        try {
          const url = new URL(typeof input === 'string' ? input : input?.url, window.location.href);
          if (url.pathname === '/cgi-bin/searchbiz') state.fingerprint = url.searchParams.get('fingerprint');
        } catch { /* Ignore unrelated or relative malformed requests. */ }
      };
      if (typeof originalFetch === 'function') {
        const wrappedFetch = function wrappedFetch(input, ...args) {
          capture(input);
          return originalFetch.call(this, input, ...args);
        };
        Object.defineProperty(wrappedFetch, '__bycliOriginalFetch', { value: originalFetch });
        root.fetch = wrappedFetch;
      }
      if (typeof originalOpen === 'function') {
        const wrappedOpen = function wrappedOpen(method, url, ...args) {
          capture(url);
          return originalOpen.call(this, method, url, ...args);
        };
        Object.defineProperty(wrappedOpen, '__bycliOriginalOpen', { value: originalOpen });
        root.XMLHttpRequest.prototype.open = wrappedOpen;
      }

      const visible = element => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden'
          && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const inputs = [
        'input[placeholder*="公众号"]', 'input[placeholder*="搜索"]',
        'input[type="search"]', '.weui-desktop-search__input',
      ];
      const input = inputs.flatMap(selector => Array.from(document.querySelectorAll(selector))).find(visible);
      if (!input) return { submitted: false };
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, searchQuery); else input.value = searchQuery;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const scope = input.closest('form, .weui-desktop-search, .search-box') ?? document;
      const buttons = Array.from(scope.querySelectorAll('button, [role="button"], a'));
      const button = buttons.find(element => visible(element) && /搜索|搜一搜/.test(element.textContent ?? ''));
      if (button) button.click();
      else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      return { submitted: true };
    }, { operation: 'install', query, stateKey: STATE_KEY });

    if (!installed?.submitted) {
      throw new CommandExecutionError(
        'WeChat official-account search control was not found',
        'The WeChat editor page layout or search control may have changed; open the editor and retry',
      );
    }

    while (Date.now() - startedAt < timeoutMs) {
      const fingerprint = await page.evaluate(({ operation, stateKey }) => {
        if (operation !== 'read') return null;
        return /** @type {any} */ (window)[stateKey]?.fingerprint ?? null;
      }, { operation: 'read', stateKey: STATE_KEY });
      if (typeof fingerprint === 'string' && fingerprint.length > 0) return fingerprint;
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) break;
      await page.wait(Math.min(POLL_INTERVAL_MS, remainingMs) / 1000);
    }
    throw new TimeoutError('WeChat search fingerprint capture', timeoutMs / 1000);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CommandExecutionError(`WeChat fingerprint capture failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      await page.evaluate(({ operation, stateKey }) => {
        if (operation !== 'cleanup') return;
        const root = /** @type {any} */ (window);
        const state = root[stateKey];
        if (!state) return;
        const originalFetch = root.fetch?.__bycliOriginalFetch;
        const originalOpen = root.XMLHttpRequest?.prototype?.open?.__bycliOriginalOpen;
        if (originalFetch) root.fetch = originalFetch;
        if (originalOpen && root.XMLHttpRequest?.prototype) {
          root.XMLHttpRequest.prototype.open = originalOpen;
        }
        delete root[stateKey];
      }, { operation: 'cleanup', stateKey: STATE_KEY });
    } catch { /* Cleanup must not hide the primary result or typed error. */ }
  }
}
