import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthRequiredError } from '@sovovs/bycli/errors';
import {
  isLoggedInPreflight,
  readEnvironmentCredentials,
  resolveBrowserCredentials,
} from './auth-session.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function makePage(options = {}) {
  const states = options.states ?? [{
    url: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=123',
    hasLoginUi: false,
  }];
  let stateIndex = 0;

  return {
    getCurrentUrl: vi.fn(async () => states[Math.min(stateIndex, states.length - 1)]?.url ?? null),
    evaluate: vi.fn(async () => {
      const state = states[Math.min(stateIndex, states.length - 1)] ?? { url: null, hasLoginUi: false };
      stateIndex += 1;
      return { href: state.url, hasLoginUi: state.hasLoginUi };
    }),
    getCookies: vi.fn(async () => options.cookies ?? []),
    goto: vi.fn(async () => undefined),
    wait: vi.fn(async seconds => options.onWait?.(seconds)),
    focusWindow: vi.fn(async () => undefined),
  };
}

describe('readEnvironmentCredentials', () => {
  it('requires both crawling environment values', () => {
    expect(() => readEnvironmentCredentials(false, { WECHAT_TOKEN: 'token-only' }))
      .toThrow(AuthRequiredError);
  });

  it('returns trimmed search environment values including fingerprint', () => {
    expect(readEnvironmentCredentials(true, {
      WECHAT_TOKEN: ' token ',
      WECHAT_COOKIE: ' cookie ',
      WECHAT_FINGERPRINT: ' fingerprint ',
    })).toEqual({ token: 'token', cookie: 'cookie', fingerprint: 'fingerprint' });
  });

  it('is an explicit environment-only source', () => {
    const page = makePage();
    expect(() => readEnvironmentCredentials(false, {})).toThrow(AuthRequiredError);
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(page.getCookies).not.toHaveBeenCalled();
  });
});

describe('isLoggedInPreflight', () => {
  it('accepts a backend URL with a token and no visible login UI', () => {
    expect(isLoggedInPreflight({
      url: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=123',
      hasLoginUi: false,
    })).toBe(true);
  });

  it('rejects the root login page with visible login UI', () => {
    expect(isLoggedInPreflight({ url: 'https://mp.weixin.qq.com/', hasLoginUi: true })).toBe(false);
  });

  it('returns false for malformed URLs', () => {
    expect(isLoggedInPreflight({ url: 'not a URL', hasLoginUi: false })).toBe(false);
  });

  it.each([
    'http://mp.weixin.qq.com/cgi-bin/home?token=123',
    'https://mp.weixin.qq.com:8443/cgi-bin/home?token=123',
  ])('rejects a backend URL outside the standard HTTPS origin: %s', url => {
    expect(isLoggedInPreflight({ url, hasLoginUi: false })).toBe(false);
  });
});

describe('login DOM preflight', () => {
  it('executes the evaluated callback and detects a visible QR image selector', async () => {
    const queriedSelectors = [];
    const qrElement = { getBoundingClientRect: () => ({ width: 128, height: 128 }) };
    vi.stubGlobal('window', {
      location: { href: 'https://mp.weixin.qq.com/' },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    });
    vi.stubGlobal('document', {
      querySelectorAll: selector => {
        queriedSelectors.push(selector);
        return selector === 'img[src*="qrcode"]' ? [qrElement] : [];
      },
      body: { innerText: '' },
    });
    const page = makePage({ cookies: [] });
    vi.mocked(page.evaluate).mockImplementation(async callback => callback());

    await expect(resolveBrowserCredentials(page, { now: () => 0 }))
      .rejects.toBeInstanceOf(AuthRequiredError);
    expect(queriedSelectors).toContain('img[src*="qrcode"]');
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.focusWindow).toHaveBeenCalledTimes(1);
  });

  it('ignores an invisible QR element but detects the login text', async () => {
    const qrElement = { getBoundingClientRect: () => ({ width: 0, height: 0 }) };
    vi.stubGlobal('window', {
      location: { href: 'https://mp.weixin.qq.com/' },
      getComputedStyle: () => ({ display: 'none', visibility: 'visible', opacity: '1' }),
    });
    vi.stubGlobal('document', {
      querySelectorAll: selector => selector === 'canvas[class*="qrcode"]' ? [qrElement] : [],
      body: { innerText: '请使用微信扫码登录' },
    });
    const page = makePage({ cookies: [] });
    vi.mocked(page.evaluate).mockImplementation(async callback => callback());

    await expect(resolveBrowserCredentials(page, { now: () => 0 }))
      .rejects.toBeInstanceOf(AuthRequiredError);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.focusWindow).toHaveBeenCalledTimes(1);
  });
});

describe('resolveBrowserCredentials', () => {
  it('retains HttpOnly target cookies and excludes expired, foreign, and suffix-confusion cookies', async () => {
    const page = makePage({
      cookies: [
        { name: 'slave_sid', value: 'sid', domain: '.mp.weixin.qq.com', httpOnly: true, expirationDate: 4_000_000_000 },
        { name: 'expired', value: 'old', domain: 'mp.weixin.qq.com', expirationDate: 1 },
        { name: 'foreign', value: 'no', domain: '.example.com', expirationDate: 4_000_000_000 },
        { name: 'suffix', value: 'no', domain: 'evilmp.weixin.qq.com', expirationDate: 4_000_000_000 },
      ],
    });

    await expect(resolveBrowserCredentials(page, { now: () => 2_000_000_000_000 }))
      .resolves.toEqual({ token: '123', cookie: 'slave_sid=sid' });
    expect(page.goto).toHaveBeenLastCalledWith(expect.stringContaining('type=10'));
  });

  it('opens and focuses login, then immediately reports authentication pending', async () => {
    const page = makePage({
      states: [
        { url: 'https://mp.weixin.qq.com/', hasLoginUi: true },
        { url: 'https://mp.weixin.qq.com/', hasLoginUi: true },
      ],
      cookies: [{ name: 'slave_sid', value: 'sid', domain: '.mp.weixin.qq.com' }],
    });

    await expect(resolveBrowserCredentials(page, { now: () => 0 }))
      .rejects.toBeInstanceOf(AuthRequiredError);
    expect(page.focusWindow).toHaveBeenCalledTimes(1);
    expect(page.wait).not.toHaveBeenCalled();
    expect(page.getCookies).not.toHaveBeenCalled();
  });

  it('continues when navigation from a fresh tab reuses cookies and reaches the backend', async () => {
    const page = makePage({
      states: [
        { url: 'about:blank', hasLoginUi: false },
        { url: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=456', hasLoginUi: false },
      ],
      cookies: [{ name: 'slave_sid', value: 'sid', domain: '.mp.weixin.qq.com' }],
    });

    await expect(resolveBrowserCredentials(page, { now: () => 0 })).resolves.toEqual({
      token: '456', cookie: 'slave_sid=sid',
    });
    expect(page.goto).toHaveBeenNthCalledWith(1, 'https://mp.weixin.qq.com/');
    expect(page.focusWindow).not.toHaveBeenCalled();
  });
});
