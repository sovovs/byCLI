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

function makeRealPage({ triggerRequest = true, trustedContainer = true, includeUnrelatedButton = false } = {}) {
  const originalFetch = vi.fn(async () => ({ ok: true }));
  const originalOpen = vi.fn();
  class FakeXHR {}
  FakeXHR.prototype.open = originalOpen;
  const scope = { querySelectorAll: selector => selector.includes('button') ? [button] : [] };
  const input = {
    value: '',
    focus: vi.fn(),
    dispatchEvent: vi.fn(),
    closest: vi.fn(() => trustedContainer ? scope : null),
    getBoundingClientRect: () => ({ width: 100, height: 24 }),
  };
  const button = {
    textContent: '搜索',
    getBoundingClientRect: () => ({ width: 40, height: 24 }),
    click: vi.fn(() => {
      if (triggerRequest) window.fetch(`https://mp.weixin.qq.com/cgi-bin/searchbiz?action=search_biz&fingerprint=${encodeURIComponent(input.value)}-fp&token=token-secret`);
    }),
  };
  vi.stubGlobal('window', {
    location: { href: 'https://mp.weixin.qq.com/cgi-bin/appmsg' },
    fetch: originalFetch,
    XMLHttpRequest: FakeXHR,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  });
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('HTMLInputElement', class HTMLInputElement {});
  vi.stubGlobal('Event', class Event { constructor(type, options) { this.type = type; this.options = options; } });
  vi.stubGlobal('KeyboardEvent', class KeyboardEvent {});
  vi.stubGlobal('document', {
    querySelectorAll: selector => selector.startsWith('input') ? [input] : includeUnrelatedButton && selector.includes('button') ? [button] : [],
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
    await expect(captureSearchBizFingerprint(page, '微信派', 1_000)).resolves.toBe('微信派-fp');
    expect(capturedState).toEqual({ fingerprint: '微信派-fp' });
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

  it('executes real cleanup after a polling error without retaining request secrets', async () => {
    const { page, originalFetch, originalOpen } = makeRealPage({ triggerRequest: false });
    page.evaluate.mockImplementation(async (callback, argument) => {
      if (argument.operation === 'read') {
        throw new Error('trigger failed after https://mp.weixin.qq.com/cgi-bin/searchbiz?token=token-secret&fingerprint=fp-secret');
      }
      return callback(argument);
    });

    const error = await captureSearchBizFingerprint(page, '微信派', 1_000).catch(value => value);

    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(window.fetch).toBe(originalFetch);
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(Object.getOwnPropertyNames(window).some(key => key.startsWith('__bycliWechat'))).toBe(false);
    expect(JSON.stringify(window)).not.toMatch(/searchbiz|token-secret|fp-secret|cookie/i);
    expect(page.evaluate.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ operation: 'cleanup' }));
    expect(`${error.message} ${error.hint ?? ''}`).not.toMatch(/searchbiz|token-secret|fp-secret|cookie/i);
  });

  it('serializes concurrent captures on the same page and releases ownership', async () => {
    const { page, originalFetch, originalOpen } = makeRealPage();
    await expect(Promise.all([
      captureSearchBizFingerprint(page, 'first', 1_000),
      captureSearchBizFingerprint(page, 'second', 1_000),
    ])).resolves.toEqual(['first-fp', 'second-fp']);
    expect(window.fetch).toBe(originalFetch);
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(Object.getOwnPropertyNames(window).some(key => key.startsWith('__bycliWechat'))).toBe(false);
  });

  it('does not let a failed capture block the next capture on the same page', async () => {
    const { page, originalFetch, originalOpen } = makeRealPage();
    let failNextRead = true;
    page.evaluate.mockImplementation(async (callback, argument) => {
      if (argument.operation === 'read' && failNextRead) {
        failNextRead = false;
        throw new Error('bridge failed');
      }
      return callback(argument);
    });
    const failed = captureSearchBizFingerprint(page, 'failed', 1_000);
    const succeeded = captureSearchBizFingerprint(page, 'recovered', 1_000);
    await expect(failed).rejects.toBeInstanceOf(CommandExecutionError);
    await expect(succeeded).resolves.toBe('recovered-fp');
    expect(window.fetch).toBe(originalFetch);
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(Object.getOwnPropertyNames(window).some(key => key.startsWith('__bycliWechat'))).toBe(false);
  });

  it('uses the button in the same trusted picker container, not a global search button', async () => {
    const { page } = makeRealPage({ includeUnrelatedButton: true });
    await expect(captureSearchBizFingerprint(page, 'dialog', 1_000)).resolves.toBe('dialog-fp');
  });

  it('rejects an input that has only an unrelated global search button', async () => {
    const { page } = makeRealPage({ trustedContainer: false, includeUnrelatedButton: true });
    const error = await captureSearchBizFingerprint(page, 'global', 1_000).catch(value => value);
    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(error.hint).toMatch(/layout|control/i);
  });
});
