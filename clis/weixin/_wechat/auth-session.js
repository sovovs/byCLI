import { AuthRequiredError, BrowserConnectError, CommandExecutionError } from '@sovovs/bycli/errors';

const DOMAIN = 'mp.weixin.qq.com';
const LOGIN_URL = `https://${DOMAIN}/`;

/**
 * @typedef {{token: string, cookie: string, fingerprint?: string}} WechatCredentials
 * @typedef {{url: string | null, hasLoginUi: boolean}} PreflightState
 * @typedef {{now?: () => number}} ResolveBrowserCredentialsOptions
 * @typedef {Pick<import('@sovovs/bycli/types').IPage, 'evaluate' | 'getCookies' | 'goto' | 'wait' | 'focusWindow'>} AuthPage
 */

/**
 * @param {boolean} needsFingerprint
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {WechatCredentials}
 */
export function readEnvironmentCredentials(needsFingerprint, env = process.env) {
  const token = env.WECHAT_TOKEN?.trim() ?? '';
  const cookie = env.WECHAT_COOKIE?.trim() ?? '';
  const fingerprint = env.WECHAT_FINGERPRINT?.trim() ?? '';

  if (!token || !cookie || (needsFingerprint && !fingerprint)) {
    throw new AuthRequiredError(
      DOMAIN,
      needsFingerprint
        ? 'WECHAT_TOKEN, WECHAT_COOKIE, and WECHAT_FINGERPRINT are required for env search'
        : 'WECHAT_TOKEN and WECHAT_COOKIE are required for env crawling',
    );
  }

  return { token, cookie, ...(fingerprint ? { fingerprint } : {}) };
}

/** @param {PreflightState} state @returns {boolean} */
export function isLoggedInPreflight(state) {
  if (state.url === null || state.hasLoginUi) return false;

  try {
    const url = new URL(state.url);
    return url.origin === `https://${DOMAIN}`
      && url.pathname.startsWith('/cgi-bin/')
      && Boolean(url.searchParams.get('token')?.trim());
  } catch {
    return false;
  }
}

/** @param {PreflightState} state @returns {boolean} */
export function isLoggedInMiniProgramPreflight(state) {
  if (state.url === null || state.hasLoginUi) return false;

  try {
    const url = new URL(state.url);
    return url.origin === `https://${DOMAIN}`
      && url.pathname.startsWith('/wxamp/')
      && Boolean(url.searchParams.get('token')?.trim());
  } catch {
    return false;
  }
}

/** @param {AuthPage} page @returns {Promise<PreflightState>} */
async function readPreflight(page) {
  const result = await page.evaluate(() => {
    const selectors = [
      'form[action*="login"]',
      'img[src*="qrcode"]',
      'canvas[class*="qrcode"]',
    ];
    const isVisible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0
        && rect.width > 0
        && rect.height > 0;
    };
    const hasVisibleSelector = selectors.some(selector =>
      Array.from(document.querySelectorAll(selector)).some(isVisible));
    const hasLoginText = /扫码登录|使用微信扫码/.test(document.body?.innerText ?? '');

    return {
      href: window.location.href,
      hasLoginUi: hasVisibleSelector || hasLoginText,
    };
  });

  return { url: result.href, hasLoginUi: result.hasLoginUi };
}

/** @param {string} cookieDomain @returns {boolean} */
function matchesDomain(cookieDomain) {
  const normalized = cookieDomain.toLowerCase().replace(/^\./, '');
  return normalized === DOMAIN || normalized.endsWith(`.${DOMAIN}`);
}

/**
 * @param {AuthPage | null} page
 * @param {ResolveBrowserCredentialsOptions} [options]
 * @returns {Promise<WechatCredentials>}
 */
export async function resolveBrowserCredentials(page, options = {}) {
  if (page === null) {
    throw new BrowserConnectError('No browser page is connected for WeChat authentication');
  }

  const now = options.now ?? Date.now;
  let state = await readPreflight(page);

  if (!isLoggedInPreflight(state)) {
    await page.goto(LOGIN_URL);
    state = await readPreflight(page);

    if (!isLoggedInPreflight(state)) {
      if (isLoggedInMiniProgramPreflight(state)) {
        throw new CommandExecutionError(
          'The connected WeChat session is authenticated as a Mini Program account',
          'Switch to a WeChat Official Account in the same browser profile before running bycli weixin commands.',
        );
      }
      if (!page.focusWindow) {
        throw new BrowserConnectError(
          'The connected browser cannot be focused for WeChat login',
          'Upgrade to byCLI 2.1 or newer to support interactive browser login',
        );
      }

      await page.focusWindow();

      throw new AuthRequiredError(
        DOMAIN,
        'WeChat login is required. The login tab is open; complete QR-code login and run the command again.',
      );
    }
  }

  const finalUrl = state.url;
  const token = finalUrl === null ? '' : new URL(finalUrl).searchParams.get('token')?.trim() ?? '';
  const cookies = await page.getCookies({ url: LOGIN_URL });
  const nowSeconds = now() / 1000;
  const cookie = cookies
    .filter(item => matchesDomain(item.domain))
    .filter(item => item.expirationDate === undefined || item.expirationDate > nowSeconds)
    .map(item => `${item.name}=${item.value}`)
    .join('; ');

  if (!token || !cookie) {
    throw new AuthRequiredError(DOMAIN, 'A logged-in WeChat session with a token and cookies is required');
  }

  await page.goto(
    `https://${DOMAIN}/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=10&token=${encodeURIComponent(token)}&lang=zh_CN`,
  );

  return { token, cookie };
}
