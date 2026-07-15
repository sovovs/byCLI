import { CliError, CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';

const STATE_KEY = '__bycliWechatSearchBizCapture';
const POLL_INTERVAL_MS = 100;
const AUTO_OPEN_POLLS = 50;
const captureQueues = new WeakMap();

/** @param {any} page @param {string} query @param {number} [timeoutMs] */
export function captureSearchBizFingerprint(page, query, timeoutMs = 30_000) {
  const previous = captureQueues.get(page) ?? Promise.resolve();
  const run = previous.catch(() => undefined)
    .then(() => captureSearchBizFingerprintOwned(page, query, timeoutMs));
  const tail = run.then(() => undefined, () => undefined);
  captureQueues.set(page, tail);
  return run.finally(() => {
    if (captureQueues.get(page) === tail) captureQueues.delete(page);
  });
}

/** @param {any} page @param {string} query @param {number} timeoutMs */
async function captureSearchBizFingerprintOwned(page, query, timeoutMs) {
  const startedAt = Date.now();
  try {
    await page.evaluate(({ operation, stateKey }) => {
      if (operation !== 'install') return { installed: false };
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
      return { installed: true };
    }, { operation: 'install', stateKey: STATE_KEY });

    let entryClicked = false;
    let submitted = false;
    let focusedForManualOpen = false;
    let automaticPolls = 0;
    while (Date.now() - startedAt < timeoutMs) {
      if (!submitted) {
        const picker = await page.evaluate(({ operation, allowClick }) => {
          if (operation !== 'open-picker') return { dialogVisible: false, entryClicked: false };
          const root = /** @type {any} */ (window);
          const visible = element => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden'
              && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
          };
          const dialogs = Array.from(document.querySelectorAll(
            '[role="dialog"], .weui-desktop-dialog, [class*="dialog"]',
          )).filter(visible).filter(element => /插入账号名片/.test(element.textContent ?? ''));
          if (dialogs.length === 1) return { dialogVisible: true, entryClicked: false };
          if (!allowClick) return { dialogVisible: false, entryClicked: false };

          const selector = [
            'header button', 'header a', 'header [role="button"]', 'header [class*="tool"]',
            '[role="banner"] button', '[role="banner"] a', '[role="banner"] [role="button"]',
            '.edui-editor-toolbarbox button', '.edui-editor-toolbarbox a',
            '.edui-editor-toolbarbox [role="button"]', '.edui-editor-toolbarbox [class*="tool"]',
            '.weui-desktop-toolbar button', '.weui-desktop-toolbar a',
            '.weui-desktop-toolbar [role="button"]', '.weui-desktop-toolbar [class*="tool"]',
            'button', 'a', '[role="button"]',
          ].join(', ');
          const maxHeaderTop = Math.max(160, (Number(root.innerHeight) || 800) * 0.25);
          const targets = new Set();
          for (const element of Array.from(document.querySelectorAll(selector))) {
            if (!visible(element)) continue;
            if ((element.textContent ?? '').replace(/\s+/g, '').trim() !== '账号名片') continue;
            const rect = element.getBoundingClientRect();
            if (Number(rect.top ?? 0) > maxHeaderTop) continue;
            targets.add(element.closest('button, a, [role="button"]') ?? element);
          }
          if (targets.size !== 1) return { dialogVisible: false, entryClicked: false };
          const [target] = targets;
          target.click();
          return { dialogVisible: false, entryClicked: true };
        }, { operation: 'open-picker', allowClick: !entryClicked });

        entryClicked ||= picker?.entryClicked === true;
        if (picker?.dialogVisible) {
          const result = await page.evaluate(({ operation, query: searchQuery }) => {
            if (operation !== 'submit-search') return { submitted: false, reason: 'operation' };
            const visible = element => {
              const style = window.getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden'
                && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
            };
            const dialogs = Array.from(document.querySelectorAll(
              '[role="dialog"], .weui-desktop-dialog, [class*="dialog"]',
            )).filter(visible).filter(element => /插入账号名片/.test(element.textContent ?? ''));
            if (dialogs.length !== 1) return { submitted: false, reason: 'dialog' };
            const inputs = Array.from(dialogs[0].querySelectorAll(
              'input[type="text"], input[type="search"], input:not([type]), .weui-desktop-search__input',
            )).filter(visible);
            if (inputs.length !== 1) {
              return { submitted: false, reason: 'input', inputCount: inputs.length };
            }
            const input = inputs[0];
            input.focus();
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(input, searchQuery); else input.value = searchQuery;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            for (const type of ['keydown', 'keypress', 'keyup']) {
              input.dispatchEvent(new KeyboardEvent(type, {
                key: 'Enter', code: 'Enter', bubbles: true,
              }));
            }
            return { submitted: true };
          }, { operation: 'submit-search', query });
          if (!result?.submitted && result?.reason === 'input') {
            throw new CommandExecutionError(
              'WeChat account-card search input was not found',
              'The WeChat account-card dialog layout may have changed; close it and retry',
            );
          }
          submitted = result?.submitted === true;
        } else {
          automaticPolls += 1;
          if (!focusedForManualOpen && automaticPolls >= AUTO_OPEN_POLLS) {
            if (typeof page.focusWindow === 'function') await page.focusWindow();
            focusedForManualOpen = true;
          }
        }
      }

      if (submitted) {
        const fingerprint = await page.evaluate(({ operation, stateKey }) => {
          if (operation !== 'read') return null;
          return /** @type {any} */ (window)[stateKey]?.fingerprint ?? null;
        }, { operation: 'read', stateKey: STATE_KEY });
        if (typeof fingerprint === 'string' && fingerprint.length > 0) return fingerprint;
      }

      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) break;
      await page.wait(Math.min(POLL_INTERVAL_MS, remainingMs) / 1000);
    }
    throw new TimeoutError('WeChat account-card search fingerprint capture', timeoutMs / 1000);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CommandExecutionError(
      'WeChat fingerprint capture failed',
      'The WeChat editor page or browser bridge failed while capturing the official-account search request; retry the search',
    );
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
