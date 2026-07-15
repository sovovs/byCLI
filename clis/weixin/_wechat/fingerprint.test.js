import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';
import { captureSearchBizFingerprint } from './fingerprint.js';

function makePage({ submitted = true, fingerprint = 'fp-value', failPoll = false } = {}) {
  let reads = 0;
  return {
    evaluate: vi.fn(async (_callback, argument) => {
      if (argument?.operation === 'install') return { installed: true };
      if (argument?.operation === 'open-picker') return { dialogVisible: true, entryClicked: false };
      if (argument?.operation === 'submit-search') {
        return submitted ? { submitted: true } : { submitted: false, reason: 'input', inputCount: 0 };
      }
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
  const scope = {
    textContent: '插入账号名片',
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
    querySelectorAll: selector => {
      if (selector.includes('input')) return [input];
      return selector.includes('button') ? [button] : [];
    },
  };
  const input = {
    value: '',
    focus: vi.fn(),
    dispatchEvent: vi.fn(event => {
      if (triggerRequest && event.type === 'keydown' && event.key === 'Enter') {
        window.fetch(`https://mp.weixin.qq.com/cgi-bin/searchbiz?action=search_biz&fingerprint=${encodeURIComponent(input.value)}-fp&token=token-secret`);
      }
    }),
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
  vi.stubGlobal('KeyboardEvent', class KeyboardEvent {
    constructor(type, options = {}) { this.type = type; this.key = options.key; this.code = options.code; }
  });
  vi.stubGlobal('document', {
    querySelectorAll: selector => {
      if (selector.includes('[role="dialog"]') || selector.includes('.weui-desktop-dialog')) return [scope];
      if (selector.startsWith('input')) return [input];
      return includeUnrelatedButton && selector.includes('button') ? [button] : [];
    },
  });
  const page = {
    evaluate: vi.fn(async (callback, argument) => callback(argument)),
    wait: vi.fn(async () => undefined),
  };
  return { page, originalFetch, originalOpen };
}

function makeAccountCardPage({
  triggerRequest = true,
  entryVisible = true,
  entryInOverflow = false,
  revealEntryAfterWait = false,
  manualDialogAfterFocus = false,
  inputCount = 1,
} = {}) {
  const originalFetch = vi.fn(async () => ({ ok: true }));
  const originalOpen = vi.fn();
  class FakeXHR {}
  FakeXHR.prototype.open = originalOpen;
  let dialogVisible = false;
  let entryIsVisible = entryVisible;
  let entryClicks = 0;
  let insertClicks = 0;
  let insertOverflowClicks = 0;
  let formatOverflowClicks = 0;
  let overflowMenuVisible = false;
  let requestTriggered = false;
  const operations = [];
  const input = {
    value: '',
    focus: vi.fn(),
    getBoundingClientRect: () => ({ width: dialogVisible ? 300 : 0, height: dialogVisible ? 32 : 0 }),
    dispatchEvent: vi.fn(event => {
      if (triggerRequest && !requestTriggered && event.type === 'keydown' && event.key === 'Enter') {
        requestTriggered = true;
        window.fetch(`https://mp.weixin.qq.com/cgi-bin/searchbiz?action=search_biz&fingerprint=${encodeURIComponent(input.value)}-fp`);
      }
    }),
    closest: vi.fn(() => dialog),
  };
  const insertButton = {
    textContent: '插入',
    getBoundingClientRect: () => ({ width: dialogVisible ? 60 : 0, height: dialogVisible ? 30 : 0 }),
    click: vi.fn(() => { insertClicks += 1; }),
  };
  const dialog = {
    textContent: '插入账号名片',
    getBoundingClientRect: () => ({ width: dialogVisible ? 800 : 0, height: dialogVisible ? 600 : 0 }),
    querySelectorAll: selector => {
      if (selector.includes('input')) return dialogVisible ? Array.from({ length: inputCount }, () => input) : [];
      if (selector.includes('button')) return dialogVisible ? [insertButton] : [];
      return [];
    },
  };
  const entry = {
    textContent: '账号名片',
    getBoundingClientRect: () => ({
      width: (entryInOverflow ? overflowMenuVisible : entryIsVisible) ? 80 : 0,
      height: (entryInOverflow ? overflowMenuVisible : entryIsVisible) ? 32 : 0,
    }),
    click: vi.fn(() => { entryClicks += 1; dialogVisible = true; }),
    closest: vi.fn(() => entry),
  };
  const insertOverflow = {
    textContent: '…',
    className: 'toolbar-more',
    getAttribute: name => name === 'aria-label' ? '更多' : null,
    getBoundingClientRect: () => ({ width: 32, height: 32, top: 20 }),
    click: vi.fn(() => { insertOverflowClicks += 1; overflowMenuVisible = true; }),
    closest: vi.fn(() => insertOverflow),
  };
  const formatOverflow = {
    textContent: '…',
    className: 'toolbar-more',
    getAttribute: name => name === 'aria-label' ? '更多' : null,
    getBoundingClientRect: () => ({ width: 32, height: 32, top: 90 }),
    click: vi.fn(() => { formatOverflowClicks += 1; }),
    closest: vi.fn(() => formatOverflow),
  };
  const insertToolbar = {
    textContent: '图片 视频 音频 超链接 小程序 …',
    className: 'insert-toolbar',
    getBoundingClientRect: () => ({ width: 900, height: 48, top: 0 }),
    querySelectorAll: () => [insertOverflow],
    contains: element => element === insertOverflow,
  };
  const formatToolbar = {
    textContent: '17px B I U …',
    className: 'format-toolbar',
    getBoundingClientRect: () => ({ width: 900, height: 48, top: 70 }),
    querySelectorAll: () => [formatOverflow],
    contains: element => element === formatOverflow,
  };
  const overflowMenu = {
    textContent: '视频号 账号名片 问答 礼物',
    className: 'toolbar-dropdown-menu',
    getBoundingClientRect: () => ({
      width: overflowMenuVisible ? 180 : 0,
      height: overflowMenuVisible ? 240 : 0,
      top: 48,
    }),
    querySelectorAll: () => overflowMenuVisible ? [entry] : [],
    contains: element => element === entry,
  };
  vi.stubGlobal('window', {
    location: { href: 'https://mp.weixin.qq.com/cgi-bin/appmsg' },
    fetch: originalFetch,
    XMLHttpRequest: FakeXHR,
    getComputedStyle: element => ({
      display: element.getBoundingClientRect().width > 0 ? 'block' : 'none',
      visibility: 'visible', opacity: '1',
    }),
  });
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('HTMLInputElement', class HTMLInputElement {});
  vi.stubGlobal('Event', class Event { constructor(type) { this.type = type; } });
  vi.stubGlobal('KeyboardEvent', class KeyboardEvent {
    constructor(type, options = {}) { this.type = type; this.key = options.key; this.code = options.code; }
  });
  vi.stubGlobal('document', {
    querySelectorAll: selector => {
      if (selector.includes('[role="dialog"]') || selector.includes('.weui-desktop-dialog')) return [dialog];
      if (entryInOverflow && selector.includes('[class*="toolbar"]')) return [insertToolbar, formatToolbar];
      if (entryInOverflow && (selector.includes('[role="menu"]') || selector.includes('dropdown') || selector.includes('popover'))) {
        return [overflowMenu];
      }
      if (selector.includes('header') || selector.includes('[role="banner"]')) return entryInOverflow ? [] : [entry];
      if (selector.startsWith('input')) return dialogVisible ? [input] : [];
      return [];
    },
  });
  const page = {
    evaluate: vi.fn(async (callback, argument) => {
      operations.push(argument.operation);
      return callback(argument);
    }),
    wait: vi.fn(async () => { if (revealEntryAfterWait) entryIsVisible = true; }),
    focusWindow: vi.fn(async () => { if (manualDialogAfterFocus) dialogVisible = true; }),
  };
  return {
    page, operations,
    entryClicks: () => entryClicks,
    insertClicks: () => insertClicks,
    insertOverflowClicks: () => insertOverflowClicks,
    formatOverflowClicks: () => formatOverflowClicks,
    submittedQuery: () => input.value,
    originalFetch, originalOpen,
  };
}

describe('captureSearchBizFingerprint', () => {
  it('opens the header account-card picker before submitting its dialog search', async () => {
    const fixture = makeAccountCardPage();
    await expect(captureSearchBizFingerprint(fixture.page, '前端之神', 1_000))
      .resolves.toBe('前端之神-fp');
    expect(fixture.operations.indexOf('install')).toBeLessThan(fixture.operations.indexOf('open-picker'));
    expect(fixture.entryClicks()).toBe(1);
    expect(fixture.submittedQuery()).toBe('前端之神');
    expect(fixture.insertClicks()).toBe(0);
  });

  it('opens account card from the insert-toolbar overflow without clicking the formatting overflow', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({ entryInOverflow: true });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });

    await expect(captureSearchBizFingerprint(fixture.page, '前端之神', 1_000))
      .resolves.toBe('前端之神-fp');
    expect(fixture.insertOverflowClicks()).toBe(1);
    expect(fixture.formatOverflowClicks()).toBe(0);
    expect(fixture.entryClicks()).toBe(1);
    expect(fixture.insertClicks()).toBe(0);
  });

  it('focuses the window and continues after the user manually opens the dialog', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({ entryVisible: false, manualDialogAfterFocus: true });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });
    await expect(captureSearchBizFingerprint(fixture.page, '微信派', 6_000)).resolves.toBe('微信派-fp');
    expect(fixture.page.focusWindow).toHaveBeenCalledTimes(1);
    expect(fixture.entryClicks()).toBe(0);
  });

  it('waits for delayed editor rendering before clicking the account-card entry', async () => {
    const fixture = makeAccountCardPage({ entryVisible: false, revealEntryAfterWait: true });
    await expect(captureSearchBizFingerprint(fixture.page, '微信派', 1_000)).resolves.toBe('微信派-fp');
    expect(fixture.page.wait).toHaveBeenCalled();
    expect(fixture.entryClicks()).toBe(1);
  });

  it('rejects an ambiguous account-card dialog input', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({ inputCount: 2 });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });
    await expect(captureSearchBizFingerprint(fixture.page, '微信派', 1_000))
      .rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('polls with page.wait seconds and always cleans up after success', async () => {
    const page = makePage();
    await expect(captureSearchBizFingerprint(page, '微信派', 1_000)).resolves.toBe('fp-value');
    expect(page.wait).toHaveBeenCalledWith(0.1);
    expect(page.evaluate.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ operation: 'cleanup' }));
  });

  it('reports a page-change hint when the account-card dialog has no search input', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const page = makePage({ submitted: false });
    page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });
    const error = await captureSearchBizFingerprint(page, '微信派', 200).catch(value => value);
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

  it('does not depend on an unrelated global search button', async () => {
    const { page } = makeRealPage({ trustedContainer: false, includeUnrelatedButton: true });
    await expect(captureSearchBizFingerprint(page, 'dialog', 1_000)).resolves.toBe('dialog-fp');
  });
});
