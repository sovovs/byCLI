import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';
import { captureSearchBizFingerprint } from './fingerprint.js';

function makePage({ submitted = true, fingerprint = 'fp-value', failPoll = false } = {}) {
  let reads = 0;
  return {
    evaluate: vi.fn(async (_callback, argument) => {
      if (argument?.operation === 'install') return { submitted };
      if (argument?.operation === 'read') {
        reads += 1;
        if (failPoll) throw new Error('poll failed');
        return reads > 1 ? fingerprint : null;
      }
      if (argument?.operation === 'cleanup') return undefined;
      throw new Error('unexpected operation');
    }),
    wait: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeRealPage({ triggerRequest = true } = {}) {
  const originalFetch = vi.fn(async () => ({ ok: true }));
  const originalOpen = vi.fn();
  class FakeXHR {}
  FakeXHR.prototype.open = originalOpen;
  const input = {
    value: '',
    focus: vi.fn(),
    dispatchEvent: vi.fn(),
    closest: vi.fn(() => null),
    getBoundingClientRect: () => ({ width: 100, height: 24 }),
  };
  const button = {
    textContent: '搜索',
    getBoundingClientRect: () => ({ width: 40, height: 24 }),
    click: vi.fn(() => {
      if (triggerRequest) window.fetch('https://mp.weixin.qq.com/cgi-bin/searchbiz?action=search_biz&fingerprint=fp-real&token=token-secret');
    }),
  };
  vi.stubGlobal('window', {
    location: { href: 'https://mp.weixin.qq.com/cgi-bin/appmsg?token=token-secret' },
    fetch: originalFetch,
    XMLHttpRequest: FakeXHR,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  });
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('HTMLInputElement', class HTMLInputElement {});
  vi.stubGlobal('Event', class Event { constructor(type, options) { this.type = type; this.options = options; } });
  vi.stubGlobal('KeyboardEvent', class KeyboardEvent {});
  vi.stubGlobal('document', {
    querySelectorAll: selector => selector.startsWith('input') ? [input] : selector.includes('button') ? [button] : [],
  });
  const page = {
    evaluate: vi.fn(async (callback, argument) => callback(argument)),
    wait: vi.fn(async () => undefined),
  };
  return { page, originalFetch, originalOpen };
}

describe('captureSearchBizFingerprint', () => {
  it('polls with page.wait seconds and always cleans up after success', async () => {
    const page = makePage();
    await expect(captureSearchBizFingerprint(page, '微信派', 1_000)).resolves.toBe('fp-value');
    expect(page.wait).toHaveBeenCalledWith(0.1);
    expect(page.evaluate.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ operation: 'cleanup' }));
  });

  it('reports a page-change hint when no visible search control was submitted', async () => {
    const page = makePage({ submitted: false });
    const error = await captureSearchBizFingerprint(page, '微信派').catch(value => value);
    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(error.hint).toMatch(/page|layout|control/i);
    expect(page.evaluate.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ operation: 'cleanup' }));
  });

  it('maps polling failure to CommandExecutionError and cleans up', async () => {
    const page = makePage({ failPoll: true });
    await expect(captureSearchBizFingerprint(page, '微信派')).rejects.toBeInstanceOf(CommandExecutionError);
    expect(page.evaluate.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ operation: 'cleanup' }));
  });

  it('times out with TimeoutError and cleans up', async () => {
    let now = 0;
    const page = makePage({ fingerprint: null });
    page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await expect(captureSearchBizFingerprint(page, '微信派', 200)).rejects.toBeInstanceOf(TimeoutError);
    expect(page.evaluate.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ operation: 'cleanup' }));
    vi.restoreAllMocks();
  });

  it('captures a matching request in a real page context and restores both wrappers', async () => {
    const { page, originalFetch, originalOpen } = makeRealPage();
    let capturedState;
    page.evaluate.mockImplementation(async (callback, argument) => {
      const result = callback(argument);
      if (argument.operation === 'install') {
        const stateKey = Object.getOwnPropertyNames(window).find(key => key.startsWith('__bycliWechat'));
        capturedState = window[stateKey];
      }
      return result;
    });
    await expect(captureSearchBizFingerprint(page, '微信派', 1_000)).resolves.toBe('fp-real');
    expect(capturedState).toEqual({ fingerprint: 'fp-real' });
    expect(JSON.stringify(capturedState)).not.toMatch(/searchbiz|token-secret|cookie/i);
    expect(window.fetch).toBe(originalFetch);
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(Object.getOwnPropertyNames(window).some(key => key.startsWith('__bycliWechat'))).toBe(false);
  });

  it('restores real wrappers and deletes temporary state after timeout', async () => {
    let now = 0;
    const { page, originalFetch, originalOpen } = makeRealPage({ triggerRequest: false });
    page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await expect(captureSearchBizFingerprint(page, '微信派', 100)).rejects.toBeInstanceOf(TimeoutError);
    expect(window.fetch).toBe(originalFetch);
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(Object.getOwnPropertyNames(window).some(key => key.startsWith('__bycliWechat'))).toBe(false);
  });
});
