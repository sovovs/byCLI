import { CliError, CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';

const STATE_KEY = '__bycliWechatSearchBizCapture';
const POLL_INTERVAL_MS = 100;
const AUTO_OPEN_POLLS = 50;
const captureQueues = new WeakMap();

function isTrustedSearchBizUrl(url) {
  return url.protocol === 'https:'
    && url.hostname === 'mp.weixin.qq.com'
    && url.port === ''
    && url.username === ''
    && url.password === ''
    && url.pathname === '/cgi-bin/searchbiz';
}

function fingerprintFromNetworkEntries(entries) {
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (!entry || typeof entry.url !== 'string') continue;
    try {
      const url = new URL(entry.url);
      if (!isTrustedSearchBizUrl(url)) continue;
      const fingerprint = url.searchParams.get('fingerprint');
      if (fingerprint) return fingerprint;
    } catch { /* Ignore malformed or unrelated capture entries. */ }
  }
  return null;
}

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
  let browserNetworkCapture = false;
  let lastSubmitDiagnostics = {
    dialogVisible: false,
    inputCount: 0,
    buttonFound: false,
    clickInvoked: false,
  };
  try {
    if (typeof page.startNetworkCapture === 'function' && typeof page.readNetworkCapture === 'function') {
      try {
        browserNetworkCapture = await page.startNetworkCapture('/cgi-bin/searchbiz') !== false;
      } catch { /* In-page request hooks remain the compatibility fallback. */ }
    }
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
          const trusted = url.protocol === 'https:'
            && url.hostname === 'mp.weixin.qq.com'
            && url.port === ''
            && url.username === ''
            && url.password === ''
            && url.pathname === '/cgi-bin/searchbiz';
          if (trusted) state.fingerprint = url.searchParams.get('fingerprint');
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
    let overflowClicked = false;
    let submitted = false;
    let focusedForManualOpen = false;
    let automaticPolls = 0;
    while (Date.now() - startedAt < timeoutMs) {
      if (!submitted) {
        const picker = await page.evaluate(({ operation, allowClick, allowOverflowClick }) => {
          if (operation !== 'open-picker') {
            return { dialogVisible: false, entryClicked: false, overflowClicked: false };
          }
          const root = /** @type {any} */ (window);
          const INSERT_TOOL_LABELS = [
            '图片', '视频', '音频', '超链接', '小程序', '模板', '投票', '搜索', '地理位置',
          ];
          const visible = element => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden'
              && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
          };
          const exactText = element => (element.textContent ?? '').replace(/\s+/g, '').trim();
          const clickable = element => element.closest?.('button, a, [role="button"], [role="menuitem"]') ?? element;
          let dialogs = Array.from(document.querySelectorAll(
            '.weui-desktop-dialog__wrp.profile_dialog',
          )).filter(visible);
          if (dialogs.length === 0) {
            dialogs = Array.from(document.querySelectorAll(
              '[role="dialog"], .weui-desktop-dialog, [class*="dialog"]',
            )).filter(visible).filter(element => /插入账号名片/.test(element.textContent ?? ''));
          }
          if (dialogs.length === 0) {
            const inferred = new Set();
            const titles = Array.from(document.querySelectorAll(
              'h1, h2, h3, h4, [class*="title"], [class*="header"], span, div',
            )).filter(visible).filter(element => exactText(element) === '插入账号名片');
            for (const title of titles) {
              let ancestor = title.parentElement;
              for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
                if (!visible(ancestor) || typeof ancestor.querySelectorAll !== 'function') continue;
                const inputs = Array.from(ancestor.querySelectorAll(
                  'input[type="text"], input[type="search"], input:not([type]), .weui-desktop-search__input',
                )).filter(visible);
                if (inputs.length > 0) {
                  inferred.add(ancestor);
                  break;
                }
              }
            }
            dialogs = Array.from(inferred);
          }
          if (dialogs.length === 1) {
            return { dialogVisible: true, entryClicked: false, overflowClicked: false };
          }

          if (allowClick) {
            const wechatOverflowTriggers = Array.from(document.querySelectorAll('#editor_showmore'))
              .filter(visible);
            if (wechatOverflowTriggers.length === 1) {
              const trigger = wechatOverflowTriggers[0];
              const scopedMenus = Array.from(trigger.querySelectorAll(
                '.editor_showmore_dropdown_menu',
              )).filter(visible);
              if (scopedMenus.length === 1) {
                const profileTargets = new Set(Array.from(scopedMenus[0].querySelectorAll(
                  '#js_editor_insertProfile',
                )).filter(element => visible(element) && exactText(element) === '账号名片')
                  .map(clickable));
                if (profileTargets.size === 1) {
                  const [target] = profileTargets;
                  target.click();
                  return { dialogVisible: false, entryClicked: true, overflowClicked: false };
                }
              } else if (scopedMenus.length === 0 && allowOverflowClick) {
                clickable(trigger).click();
                return { dialogVisible: false, entryClicked: false, overflowClicked: true };
              }
            }

            const menuTargets = new Set();
            const menus = Array.from(document.querySelectorAll(
              '[role="menu"], [class*="menu"], [class*="dropdown"], [class*="popover"]',
            )).filter(visible);
            for (const menu of menus) {
              for (const element of Array.from(menu.querySelectorAll(
                'button, a, [role="button"], [role="menuitem"], li, [class*="item"]',
              ))) {
                if (visible(element) && exactText(element) === '账号名片') {
                  menuTargets.add(clickable(element));
                }
              }
            }
            if (menuTargets.size === 1) {
              const [target] = menuTargets;
              target.click();
              return { dialogVisible: false, entryClicked: true, overflowClicked: false };
            }
          }

          const selector = [
            'header button', 'header a', 'header [role="button"]', 'header [class*="tool"]',
            '[role="banner"] button', '[role="banner"] a', '[role="banner"] [role="button"]',
            '.edui-editor-toolbarbox button', '.edui-editor-toolbarbox a',
            '.edui-editor-toolbarbox [role="button"]', '.edui-editor-toolbarbox [class*="tool"]',
            '.weui-desktop-toolbar button', '.weui-desktop-toolbar a',
            '.weui-desktop-toolbar [role="button"]', '.weui-desktop-toolbar [class*="tool"]',
          ].join(', ');
          const maxHeaderTop = Math.max(160, (Number(root.innerHeight) || 800) * 0.25);
          const targets = new Set();
          for (const element of Array.from(document.querySelectorAll(selector))) {
            if (!visible(element)) continue;
            if (exactText(element) !== '账号名片') continue;
            const rect = element.getBoundingClientRect();
            if (Number(rect.top ?? 0) > maxHeaderTop) continue;
            targets.add(clickable(element));
          }
          const genericEntries = Array.from(document.querySelectorAll(
            'button, a, [role="button"], span, div, li',
          )).filter(element => {
            if (!visible(element) || exactText(element) !== '账号名片') return false;
            const rect = element.getBoundingClientRect();
            if (Number(rect.top ?? 0) > maxHeaderTop) return false;
            let ancestor = element.parentElement;
            for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
              if (!visible(ancestor)) continue;
              const ancestorRect = ancestor.getBoundingClientRect();
              if (Number(ancestorRect.top ?? 0) > maxHeaderTop) continue;
              const ancestorText = exactText(ancestor);
              const score = INSERT_TOOL_LABELS.filter(label => ancestorText.includes(label)).length;
              if (score >= 3) return true;
            }
            return false;
          });
          const innermostEntries = genericEntries.filter(element => !genericEntries.some(other =>
            other !== element && element.contains?.(other)));
          for (const element of innermostEntries) targets.add(clickable(element));
          if (allowClick && targets.size === 1) {
            const [target] = targets;
            target.click();
            return { dialogVisible: false, entryClicked: true, overflowClicked: false };
          }

          if (allowOverflowClick) {
            const candidates = Array.from(new Set(document.querySelectorAll(
              'header, [role="banner"], nav, [class*="toolbar"]',
            ))).filter(visible).map(element => {
              const text = exactText(element);
              const score = INSERT_TOOL_LABELS.filter(label => text.includes(label)).length;
              return { element, score };
            }).filter(candidate => candidate.score >= 3);
            const bestScore = Math.max(0, ...candidates.map(candidate => candidate.score));
            const best = candidates.filter(candidate => candidate.score === bestScore);
            const innermost = best.filter(candidate => !best.some(other =>
              other !== candidate && candidate.element.contains?.(other.element)));
            if (innermost.length === 1) {
              const overflowTargets = new Set();
              for (const element of Array.from(innermost[0].element.querySelectorAll(
                'button, a, [role="button"], [class*="more"], [class*="ellipsis"]',
              ))) {
                if (!visible(element)) continue;
                const text = exactText(element);
                const attributes = ['aria-label', 'title']
                  .map(name => element.getAttribute?.(name) ?? '').join(' ');
                const className = typeof element.className === 'string' ? element.className : '';
                if (!['...', '…', '•••'].includes(text)
                    && !/更多|more|ellipsis/i.test(`${attributes} ${className}`)) continue;
                overflowTargets.add(clickable(element));
              }
              if (overflowTargets.size === 1) {
                const [target] = overflowTargets;
                target.click();
                return { dialogVisible: false, entryClicked: false, overflowClicked: true };
              }
            }
          }
          return { dialogVisible: false, entryClicked: false, overflowClicked: false };
        }, {
          operation: 'open-picker',
          allowClick: !entryClicked,
          allowOverflowClick: !overflowClicked,
        });

        entryClicked ||= picker?.entryClicked === true;
        overflowClicked ||= picker?.overflowClicked === true;
        lastSubmitDiagnostics.dialogVisible = picker?.dialogVisible === true;
        if (picker?.dialogVisible) {
          if (typeof page.fillText === 'function') {
            try {
              await page.fillText(
                '.profile_dialog input.weui-desktop-form__input[placeholder="请输入账号名称或账号ID"]',
                query,
              );
            } catch { /* DOM setter below remains the compatibility fallback. */ }
          }
          const result = await page.evaluate(({ operation, query: searchQuery, stateKey }) => {
            if (operation !== 'submit-search') return { submitted: false, reason: 'operation' };
            const visible = element => {
              const style = window.getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden'
                && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
            };
            const exactText = element => (element.textContent ?? '').replace(/\s+/g, '').trim();
            let dialogs = Array.from(document.querySelectorAll(
              '.weui-desktop-dialog__wrp.profile_dialog',
            )).filter(visible);
            if (dialogs.length === 0) {
              dialogs = Array.from(document.querySelectorAll(
                '[role="dialog"], .weui-desktop-dialog, [class*="dialog"]',
              )).filter(visible).filter(element => /插入账号名片/.test(element.textContent ?? ''));
            }
            if (dialogs.length === 0) {
              const inferred = new Set();
              const titles = Array.from(document.querySelectorAll(
                'h1, h2, h3, h4, [class*="title"], [class*="header"], span, div',
              )).filter(visible).filter(element => exactText(element) === '插入账号名片');
              for (const title of titles) {
                let ancestor = title.parentElement;
                for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
                  if (!visible(ancestor) || typeof ancestor.querySelectorAll !== 'function') continue;
                  const candidates = Array.from(ancestor.querySelectorAll(
                    'input[type="text"], input[type="search"], input:not([type]), .weui-desktop-search__input',
                  )).filter(visible);
                  if (candidates.length > 0) {
                    inferred.add(ancestor);
                    break;
                  }
                }
              }
              dialogs = Array.from(inferred);
            }
            if (dialogs.length !== 1) {
              return { submitted: false, reason: 'dialog', dialogVisible: false, inputCount: 0, buttonFound: false, clickInvoked: false };
            }
            const inputs = Array.from(dialogs[0].querySelectorAll(
              'input[type="text"], input[type="search"], input:not([type]), .weui-desktop-search__input',
            )).filter(visible);
            if (inputs.length !== 1) {
              return { submitted: false, reason: 'input', dialogVisible: true, inputCount: inputs.length, buttonFound: false, clickInvoked: false };
            }
            const input = inputs[0];
            input.focus();
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(input, searchQuery); else input.value = searchQuery;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            const exactClassName = 'weui-desktop-search__btn weui-desktop-icon-button weui-desktop-icon-button_stated';
            const exactSearchTarget = document.getElementsByClassName?.(exactClassName)?.[0]
              ?? dialogs[0].querySelector?.('.weui-desktop-search__btn');
            let buttonFound = false;
            let clickInvoked = false;
            if (exactSearchTarget && visible(exactSearchTarget)) {
              buttonFound = true;
              exactSearchTarget.click();
              clickInvoked = true;
              const fingerprint = /** @type {any} */ (window)[stateKey]?.fingerprint;
              if (typeof fingerprint === 'string' && fingerprint.length > 0) {
                return { submitted: true, dialogVisible: true, inputCount: 1, buttonFound, clickInvoked };
              }
            } else {
              const searchTargets = new Set();
              for (const element of Array.from(dialogs[0].querySelectorAll([
                'button[type="submit"]',
                'button[aria-label*="搜索"]',
                '[role="button"][aria-label*="搜索"]',
                '[title*="搜索"]',
                '.weui-desktop-search__icon',
                '[class*="search"] button',
                '[class*="search"] [role="button"]',
              ].join(', ')))) {
                if (!visible(element)) continue;
                searchTargets.add(element.closest?.('button, a, [role="button"]') ?? element);
              }
              buttonFound = searchTargets.size > 0;
              if (searchTargets.size === 1) {
                const [searchTarget] = searchTargets;
                searchTarget.click();
                clickInvoked = true;
                const fingerprint = /** @type {any} */ (window)[stateKey]?.fingerprint;
                if (typeof fingerprint === 'string' && fingerprint.length > 0) {
                  return { submitted: true, dialogVisible: true, inputCount: 1, buttonFound, clickInvoked };
                }
              }
            }
            for (const type of ['keydown', 'keypress', 'keyup']) {
              input.dispatchEvent(new KeyboardEvent(type, {
                key: 'Enter', code: 'Enter', bubbles: true,
              }));
            }
            return { submitted: true, dialogVisible: true, inputCount: 1, buttonFound, clickInvoked };
          }, { operation: 'submit-search', query, stateKey: STATE_KEY });
          lastSubmitDiagnostics = {
            dialogVisible: result?.dialogVisible === true,
            inputCount: Number(result?.inputCount ?? 0),
            buttonFound: result?.buttonFound === true,
            clickInvoked: result?.clickInvoked === true,
          };
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
        if (browserNetworkCapture) {
          try {
            const fingerprint = fingerprintFromNetworkEntries(await page.readNetworkCapture());
            if (fingerprint) return fingerprint;
          } catch {
            browserNetworkCapture = false;
          }
        }
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
    const diagnostics = [
      `networkCapture=${browserNetworkCapture ? 'browser' : 'page-hook'}`,
      `dialogVisible=${lastSubmitDiagnostics.dialogVisible}`,
      `inputCount=${lastSubmitDiagnostics.inputCount}`,
      `buttonFound=${lastSubmitDiagnostics.buttonFound}`,
      `clickInvoked=${lastSubmitDiagnostics.clickInvoked}`,
    ].join(', ');
    throw new TimeoutError(
      'WeChat account-card search fingerprint capture',
      timeoutMs / 1000,
      `Diagnostics: ${diagnostics}. Retry the command; increase --timeout only if the request is visibly still loading.`,
    );
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
