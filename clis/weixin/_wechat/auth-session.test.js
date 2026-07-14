import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, TimeoutError } from '@sovovs/bycli/errors';
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
    wait: vi.fn(async milliseconds => options.onWait?.(milliseconds)),
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
    vi.mocked(page.evaluate).mockImplementationOnce(async callback => callback());

    await expect(resolveBrowserCredentials(page, { timeoutMs: 0, now: () => 0 }))
      .rejects.toBeInstanceOf(TimeoutError);
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
    vi.mocked(page.evaluate).mockImplementationOnce(async callback => callback());

    await expect(resolveBrowserCredentials(page, { timeoutMs: 0, now: () => 0 }))
      .rejects.toBeInstanceOf(TimeoutError);
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

  it('focuses once before waiting and resolves after login changes to backend state', async () => {
    const page = makePage({
      states: [
        { url: 'https://mp.weixin.qq.com/', hasLoginUi: true },
        { url: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=456', hasLoginUi: false },
      ],
      cookies: [{ name: 'slave_sid', value: 'sid', domain: '.mp.weixin.qq.com' }],
    });

    await expect(resolveBrowserCredentials(page, { now: () => 0 })).resolves.toEqual({
      token: '456', cookie: 'slave_sid=sid',
    });
    expect(page.focusWindow).toHaveBeenCalledTimes(1);
    expect(page.wait).toHaveBeenCalledTimes(1);
    expect(vi.mocked(page.focusWindow).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(page.wait).mock.invocationCallOrder[0] ?? Infinity);
  });

  it('times out without reading cookies when login state never changes', async () => {
    let time = 0;
    const page = makePage({
      states: [{ url: 'https://mp.weixin.qq.com/', hasLoginUi: true }],
      onWait: () => { time += 500; },
    });

    await expect(resolveBrowserCredentials(page, { timeoutMs: 1_000, now: () => time }))
      .rejects.toBeInstanceOf(TimeoutError);
    expect(page.evaluate).toHaveBeenCalledTimes(3);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.focusWindow).toHaveBeenCalledTimes(1);
    expect(page.getCookies).not.toHaveBeenCalled();
  });

  it('reads the latest state after a bounded final wait and accepts login at the deadline', async () => {
    let time = 0;
    const waits = [];
    const page = makePage({
      states: [
        { url: 'https://mp.weixin.qq.com/', hasLoginUi: true },
        { url: 'https://mp.weixin.qq.com/', hasLoginUi: true },
        { url: 'https://mp.weixin.qq.com/cgi-bin/home?token=789', hasLoginUi: false },
      ],
      cookies: [{ name: 'slave_sid', value: 'sid', domain: '.mp.weixin.qq.com' }],
      onWait: milliseconds => { waits.push(milliseconds); time += milliseconds; },
    });

    await expect(resolveBrowserCredentials(page, { timeoutMs: 750, now: () => time }))
      .resolves.toEqual({ token: '789', cookie: 'slave_sid=sid' });
    expect(waits).toEqual([500, 250]);
    expect(page.focusWindow).toHaveBeenCalledTimes(1);
  });
});
