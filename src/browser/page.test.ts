import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchDaemonStatusMock, sendCommandMock, sendCommandFullMock, sendCommandOnceMock, requestExtensionReconnectMock } = vi.hoisted(() => ({
  fetchDaemonStatusMock: vi.fn(),
  requestExtensionReconnectMock: vi.fn(),
  sendCommandMock: vi.fn(),
  sendCommandFullMock: vi.fn(),
  sendCommandOnceMock: vi.fn(),
}));
const { warnMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
}));

vi.mock('./daemon-client.js', () => ({
  fetchDaemonStatus: fetchDaemonStatusMock,
  requestExtensionReconnect: requestExtensionReconnectMock,
  sendCommand: sendCommandMock,
  sendCommandFull: sendCommandFullMock,
  sendCommandOnce: sendCommandOnceMock,
}));
vi.mock('../logger.js', () => ({
  log: {
    warn: warnMock,
  },
}));

import { Page } from './page.js';

describe('Page scoped dialog acceptance', () => {
  beforeEach(() => {
    sendCommandFullMock.mockReset(); sendCommandOnceMock.mockReset(); sendCommandMock.mockReset();
    sendCommandFullMock.mockResolvedValue({ page: 'target-a', data: {} });
    sendCommandOnceMock.mockResolvedValue({ accepted: 2, beforeUnload: 1 });
  });
  it.each([false, true])('pins the scope and cleans up after callback failure=%s', async fail => {
    const page = new Page('publisher');
    const result = page.withAcceptedDialogs('https://channels.weixin.qq.com', async () => {
      await page.evaluate('document.title');
      if (fail) throw Error('operation failed');
      return 'done';
    });
    if (fail) await expect(result).rejects.toThrow('operation failed');
    else await expect(result).resolves.toBe('done');
    const start = sendCommandFullMock.mock.calls[0][1];
    expect(start).toMatchObject({ op: 'start', dialogOrigin: 'https://channels.weixin.qq.com' });
    expect(sendCommandMock).toHaveBeenCalledWith('exec', expect.objectContaining({ page: 'target-a', dialogToken: start.dialogToken }));
    expect(sendCommandOnceMock).toHaveBeenCalledWith('dialog-policy', expect.objectContaining({ op: 'stop', dialogToken: start.dialogToken }));
    await page.evaluate('1');
    expect(sendCommandMock.mock.lastCall?.[1].dialogToken).toBeUndefined();
  });
  it('does not fall back to a different tab after a stale identity under an accepting policy', async () => {
    const page = new Page('publisher');
    sendCommandFullMock.mockResolvedValueOnce({ page: 'target-a', data: {} }).mockRejectedValueOnce(Error('Page not found: target-a — stale page identity'));
    await expect(page.withAcceptedDialogs('https://channels.weixin.qq.com', () => page.goto('https://channels.weixin.qq.com/platform/post/draftListManager'))).rejects.toThrow('stale page identity');
    expect(sendCommandFullMock).toHaveBeenCalledTimes(2);
  });
});


describe('Page.evaluateOnce', () => {
  it('uses the single-attempt transport without the ordinary navigation retry', async () => {
    sendCommandOnceMock.mockReset(); sendCommandMock.mockReset();
    sendCommandOnceMock.mockRejectedValue(new Error('Execution context was destroyed'));
    const page = new Page('owned', undefined, 'profile'); page.setActivePage('exact-editor');
    await expect(page.evaluateOnce('button.click()')).rejects.toThrow('Execution context was destroyed');
    expect(sendCommandOnceMock).toHaveBeenCalledTimes(1);
    expect(sendCommandOnceMock).toHaveBeenCalledWith('exec', expect.objectContaining({ page: 'exact-editor', contextId: 'profile' }));
    expect(sendCommandMock).not.toHaveBeenCalled();
  });
});

describe('Page.nativeClickOnce', () => {
  beforeEach(() => { sendCommandOnceMock.mockReset(); sendCommandMock.mockReset(); });
  it('sends real mouse move/press/release once to the exact owned page', async () => {
    const page = new Page('owned', undefined, 'profile'); page.setActivePage('exact-editor');
    await page.nativeClickOnce(123.5, 456);
    expect(sendCommandOnceMock.mock.calls.map(([action, cmd]) => [action, cmd.cdpParams.type])).toEqual([
      ['cdp', 'mouseMoved'], ['cdp', 'mousePressed'], ['cdp', 'mouseReleased'],
    ]);
    for (const [, cmd] of sendCommandOnceMock.mock.calls) expect(cmd).toMatchObject({
      cdpMethod: 'Input.dispatchMouseEvent', cdpParams: { x: 123.5, y: 456 }, page: 'exact-editor', contextId: 'profile',
    });
    expect(sendCommandMock).not.toHaveBeenCalled();
  });
  it('releases a possibly held mouse button after a lost press response without another press', async () => {
    sendCommandOnceMock.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('press response lost')).mockResolvedValueOnce({});
    await expect(new Page('owned').nativeClickOnce(1, 2)).rejects.toThrow('press response lost');
    expect(sendCommandOnceMock.mock.calls.map(([, cmd]) => cmd.cdpParams.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });
  it.each([0, 2])('does not replay after an error at gesture step %s', async step => {
    for (let n = 0; n < step; n++) sendCommandOnceMock.mockResolvedValueOnce({});
    sendCommandOnceMock.mockRejectedValueOnce(new Error('response lost'));
    await expect(new Page('owned').nativeClickOnce(1, 2)).rejects.toThrow('response lost');
    expect(sendCommandOnceMock).toHaveBeenCalledTimes(step + 1);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });
  it.each([[NaN, 0], [0, Infinity], [-1, 0]])('rejects invalid coordinates %s %s before sending input', async (x, y) => {
    await expect(new Page('owned').nativeClickOnce(x, y)).rejects.toThrow('coordinates');
    expect(sendCommandOnceMock).not.toHaveBeenCalled();
  });
});

describe('Page.consoleMessages', () => {
  beforeEach(() => { fetchDaemonStatusMock.mockReset(); sendCommandMock.mockReset(); });
  it('reads a dedicated console snapshot from the selected tab and profile', async () => {
    fetchDaemonStatusMock.mockResolvedValue({ extensionConnected: true, extensionCapabilities: ['console-capture-v1'] });
    const messages = [{ id: 'capture:1', seq: 1, type: 'error', text: 'boom', timestamp: 1700000000000 }];
    sendCommandMock.mockResolvedValue(messages);
    const page = new Page('dev', undefined, 'profile-a'); page.setActivePage('target-a');
    expect(await page.consoleMessages('error')).toEqual(messages);
    expect(sendCommandMock).toHaveBeenCalledWith('console-messages', expect.objectContaining({ session: 'dev', page: 'target-a', contextId: 'profile-a', level: 'error' }));
  });
  it('explains the required update when the extension lacks console capture', async () => {
    fetchDaemonStatusMock.mockResolvedValue({ extensionConnected: true, extensionCapabilities: [] });
    await expect(new Page('dev').consoleMessages()).rejects.toThrow(/console-capture-v1.*update.*reload/i);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });
  it.each(['Unknown action: console-messages', 'Browser connection lost'])('does not disguise %s as an empty snapshot', async (message) => {
    fetchDaemonStatusMock.mockResolvedValue(null); sendCommandMock.mockRejectedValue(new Error(message));
    await expect(new Page('dev').consoleMessages()).rejects.toThrow(message.startsWith('Unknown') ? /update.*reload/i : /connection lost/);
  });
});

describe('Page.focusWindow', () => {
  beforeEach(() => {
    fetchDaemonStatusMock.mockReset();
    sendCommandMock.mockReset();
    sendCommandFullMock.mockReset();
    warnMock.mockReset();
  });

  it('asks the bridge to focus the active page in its automation session', async () => {
    fetchDaemonStatusMock.mockResolvedValueOnce({
      extensionConnected: true,
      extensionCapabilities: ['focus-window-v1'],
    });
    sendCommandFullMock.mockResolvedValueOnce({ data: { focused: true } });

    const page = new Page('wechat', 45, 'profile-1', 'background', 'adapter', 'persistent');
    page.setActivePage('target-7');

    await page.focusWindow();

    expect(fetchDaemonStatusMock).toHaveBeenCalledWith({ contextId: 'profile-1' });
    expect(sendCommandFullMock).toHaveBeenCalledWith('tabs', {
      op: 'focus',
      session: 'wechat',
      surface: 'adapter',
      contextId: 'profile-1',
      page: 'target-7',
      idleTimeout: 45,
      windowMode: 'background',
      siteSession: 'persistent',
    });
  });

  it('sends ima reader requests with an opaque auth ID rather than credential headers', async () => {
    const page = new Page('ima', undefined, 'profile-1', undefined, 'adapter');
    page.setActivePage('ima-tab');
    sendCommandMock.mockResolvedValueOnce({ started: true });
    sendCommandMock.mockResolvedValueOnce({ code: 0 });

    await page.startImaAuthCapture();
    await page.requestImaReader('opaque-id', '/get_knowledge_list', { cursor: '' });

    expect(sendCommandMock).toHaveBeenNthCalledWith(1, 'ima-auth-start', expect.objectContaining({ page: 'ima-tab' }));
    expect(sendCommandMock).toHaveBeenNthCalledWith(2, 'ima-reader-request', expect.objectContaining({
      authId: 'opaque-id', readerPath: '/get_knowledge_list', readerBody: { cursor: '' },
    }));
    expect(JSON.stringify(sendCommandMock.mock.calls)).not.toContain('x-ima-cookie');
  });

  it('rejects an old extension before sending an unsupported focus command', async () => {
    fetchDaemonStatusMock.mockResolvedValueOnce({
      extensionConnected: true,
      extensionVersion: '2.0.0',
      extensionCapabilities: [],
    });

    const page = new Page('wechat', undefined, 'profile-1', undefined, 'adapter');

    await expect(page.focusWindow()).rejects.toThrow(/update.*reload.*extension/i);
    expect(sendCommandFullMock).not.toHaveBeenCalled();
  });

  it('falls through to authoritative dispatch when daemon status is unavailable', async () => {
    fetchDaemonStatusMock.mockResolvedValueOnce(null);
    sendCommandFullMock.mockResolvedValueOnce({ data: { focused: true } });

    const page = new Page('wechat', undefined, 'profile-1', undefined, 'adapter');

    await expect(page.focusWindow()).resolves.toBeUndefined();
    expect(sendCommandFullMock).toHaveBeenCalledTimes(1);
  });

  it('falls through when an older daemon omits capability metadata', async () => {
    fetchDaemonStatusMock.mockResolvedValueOnce({
      extensionConnected: true,
      extensionVersion: '2.0.0',
    });
    sendCommandFullMock.mockResolvedValueOnce({ data: { focused: true } });

    const page = new Page('wechat', undefined, 'profile-1', undefined, 'adapter');

    await expect(page.focusWindow()).resolves.toBeUndefined();
    expect(sendCommandFullMock).toHaveBeenCalledTimes(1);
  });

  it('falls through when status is ambiguous across multiple profiles', async () => {
    fetchDaemonStatusMock.mockResolvedValueOnce({
      extensionConnected: false,
      profileRequired: true,
      profiles: [
        { contextId: 'work', extensionConnected: true, extensionCapabilities: ['focus-window-v1'] },
        { contextId: 'personal', extensionConnected: true },
      ],
    });
    sendCommandFullMock.mockResolvedValueOnce({ data: { focused: true } });

    const page = new Page('wechat', undefined, undefined, undefined, 'adapter');

    await expect(page.focusWindow()).resolves.toBeUndefined();
    expect(fetchDaemonStatusMock).toHaveBeenCalledWith(undefined);
    expect(sendCommandFullMock).toHaveBeenCalledTimes(1);
  });
});

describe('Page.getCurrentUrl', () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
    sendCommandFullMock.mockReset();
    warnMock.mockReset();
  });

  it('reads the real browser URL when no local navigation cache exists', async () => {
    sendCommandMock.mockResolvedValueOnce('https://notebooklm.google.com/notebook/nb-live');

    const page = new Page('notebooklm', undefined, undefined, undefined, 'adapter');
    const url = await page.getCurrentUrl();

    expect(url).toBe('https://notebooklm.google.com/notebook/nb-live');
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith('exec', expect.objectContaining({
      session: 'notebooklm',
      surface: 'adapter',
    }));
  });

  it('caches the discovered browser URL for later reads', async () => {
    sendCommandMock.mockResolvedValueOnce('https://notebooklm.google.com/notebook/nb-live');

    const page = new Page('notebooklm', undefined, undefined, undefined, 'adapter');
    expect(await page.getCurrentUrl()).toBe('https://notebooklm.google.com/notebook/nb-live');
    expect(await page.getCurrentUrl()).toBe('https://notebooklm.google.com/notebook/nb-live');

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
  });

  it('settles a navigation without stealth when the caller opts out', async () => {
    sendCommandFullMock.mockResolvedValueOnce({ page: 'page-1', data: { url: 'https://mp.weixin.qq.com/' } });
    sendCommandMock.mockResolvedValueOnce(null);

    const page = new Page('wechat', undefined, undefined, undefined, 'adapter');
    await page.goto('https://mp.weixin.qq.com/', { stealth: false });

    expect(sendCommandMock).toHaveBeenCalledWith('exec', expect.objectContaining({
      code: expect.not.stringContaining('navigator.webdriver'),
      page: 'page-1',
    }));
    expect(sendCommandMock.mock.calls[0][1].code).toContain('document');
  });

  it('passes adapter site session lifecycle through daemon commands', async () => {
    sendCommandFullMock.mockResolvedValueOnce({ page: 'page-1', data: { url: 'https://chatgpt.com/' } });
    sendCommandMock.mockResolvedValueOnce(null);

    const page = new Page('site:chatgpt', undefined, undefined, undefined, 'adapter', 'persistent');

    await page.goto('https://chatgpt.com/', { waitUntil: 'none' });
    await page.evaluate('document.title');

    expect(sendCommandFullMock).toHaveBeenCalledWith('navigate', expect.objectContaining({
      session: 'site:chatgpt',
      surface: 'adapter',
      siteSession: 'persistent',
      waitUntil: 'none',
    }));
    expect(sendCommandMock).toHaveBeenCalledWith('exec', expect.objectContaining({
      session: 'site:chatgpt',
      surface: 'adapter',
      siteSession: 'persistent',
      page: 'page-1',
    }));
  });
});

describe('Page.evaluate', () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
    sendCommandFullMock.mockReset();
    warnMock.mockReset();
  });

  it('retries once when the inspected target navigated during exec', async () => {
    sendCommandMock
      .mockRejectedValueOnce(new Error('{"code":-32000,"message":"Inspected target navigated or closed"}'))
      .mockResolvedValueOnce(42);

    const page = new Page('notebooklm', undefined, undefined, undefined, 'adapter');
    const value = await page.evaluate('21 + 21');

    expect(value).toBe(42);
    expect(sendCommandMock).toHaveBeenCalledTimes(2);
  });

  it('serializes function-form evaluate calls with JSON args', async () => {
    sendCommandMock.mockResolvedValueOnce('/bycli');

    const page = new Page('twitter', undefined, undefined, undefined, 'adapter');
    const href = await page.evaluate((selector: string) => {
      const link = document.querySelector(selector);
      return link ? link.getAttribute('href') : null;
    }, 'a[data-testid="AppTabBar_Profile_Link"]');

    expect(href).toBe('/bycli');
    expect(sendCommandMock).toHaveBeenCalledWith('exec', expect.objectContaining({
      session: 'twitter',
      surface: 'adapter',
      code: expect.stringContaining('(...["a[data-testid=\\"AppTabBar_Profile_Link\\"]"])'),
    }));
    const code = sendCommandMock.mock.calls[0]?.[1]?.code as string;
    expect(code).toContain('document.querySelector(selector)');
  });

  it('rejects non-JSON-serializable evaluate args before sending to the daemon', async () => {
    const page = new Page('default');
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(page.evaluate((value: unknown) => value, circular)).rejects.toThrow('JSON-serializable');
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('keeps string evaluate behavior unchanged', async () => {
    sendCommandMock.mockResolvedValueOnce(42);

    const page = new Page('default');
    await expect(page.evaluate('21 + 21')).resolves.toBe(42);

    expect(sendCommandMock).toHaveBeenCalledWith('exec', expect.objectContaining({
      code: '21 + 21',
    }));
  });
});

describe('Page network capture compatibility', () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
    sendCommandFullMock.mockReset();
    warnMock.mockReset();
  });

  it('treats unknown network-capture-start as unsupported and memoizes it', async () => {
    sendCommandMock.mockRejectedValueOnce(new Error('Unknown action: network-capture-start'));

    const page = new Page('notebooklm', undefined, undefined, undefined, 'adapter');

    await expect(page.startNetworkCapture()).resolves.toBe(false);
    await expect(page.startNetworkCapture()).resolves.toBe(false);

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('does not support network capture'));
    expect(sendCommandMock).toHaveBeenCalledWith('network-capture-start', expect.objectContaining({
      session: 'notebooklm',
      surface: 'adapter',
    }));
  });

  it('returns an empty capture when network-capture-read is unsupported', async () => {
    sendCommandMock.mockRejectedValueOnce(new Error('Unknown action: network-capture-read'));

    const page = new Page('notebooklm', undefined, undefined, undefined, 'adapter');

    await expect(page.readNetworkCapture()).resolves.toEqual([]);
    await expect(page.readNetworkCapture()).resolves.toEqual([]);

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith('network-capture-read', expect.objectContaining({
      session: 'notebooklm',
      surface: 'adapter',
    }));
  });

  it('rethrows unrelated network capture failures', async () => {
    sendCommandMock.mockRejectedValueOnce(new Error('Extension disconnected'));

    const page = new Page('notebooklm', undefined, undefined, undefined, 'adapter');

    await expect(page.startNetworkCapture()).rejects.toThrow('Extension disconnected');
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('warns only once even if both start and read hit the compatibility fallback', async () => {
    sendCommandMock
      .mockRejectedValueOnce(new Error('Unknown action: network-capture-start'))
      .mockRejectedValueOnce(new Error('Unknown action: network-capture-read'));

    const page = new Page('notebooklm', undefined, undefined, undefined, 'adapter');

    await expect(page.startNetworkCapture()).resolves.toBe(false);
    await expect(page.readNetworkCapture()).resolves.toEqual([]);

    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});

describe('Page download waits', () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
    sendCommandFullMock.mockReset();
    warnMock.mockReset();
  });

  it('sends wait-download through the daemon with session and timeout', async () => {
    sendCommandMock.mockResolvedValueOnce({
      downloaded: true,
      filename: '/tmp/receipt.pdf',
      state: 'complete',
      elapsedMs: 5,
    });

    const page = new Page('mercury', undefined, undefined, undefined, 'adapter');
    const result = await page.waitForDownload('receipt', 1234);

    expect(result).toEqual({
      downloaded: true,
      filename: '/tmp/receipt.pdf',
      state: 'complete',
      elapsedMs: 5,
    });
    expect(sendCommandMock).toHaveBeenCalledWith('wait-download', expect.objectContaining({
      session: 'mercury',
      surface: 'adapter',
      pattern: 'receipt',
      timeoutMs: 1234,
    }));
    expect(sendCommandMock.mock.calls[0]?.[1]).not.toHaveProperty('includeRecent');
  });

  it('forwards the option to ignore recent downloads', async () => {
    sendCommandMock.mockResolvedValueOnce({ downloaded: false, elapsedMs: 5 });

    const page = new Page('mercury', undefined, undefined, undefined, 'adapter');
    await page.waitForDownload('receipt', 1234, { includeRecent: false });

    expect(sendCommandMock).toHaveBeenCalledWith('wait-download', expect.objectContaining({
      pattern: 'receipt',
      timeoutMs: 1234,
      includeRecent: false,
    }));
  });

  it('forwards an explicit download start threshold', async () => {
    sendCommandMock.mockResolvedValueOnce({ downloaded: false, elapsedMs: 5 });

    const page = new Page('mercury', undefined, undefined, undefined, 'adapter');
    await page.waitForDownload('receipt', 1234, { includeRecent: true, startedAfterMs: 1_786_000_000_000 });

    expect(sendCommandMock).toHaveBeenCalledWith('wait-download', expect.objectContaining({
      includeRecent: true,
      startedAfterMs: 1_786_000_000_000,
    }));
  });
});

describe('Page CDP helpers', () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
    sendCommandFullMock.mockReset();
    warnMock.mockReset();
  });

  it('handles JavaScript dialogs through the CDP passthrough', async () => {
    sendCommandMock.mockResolvedValueOnce({});

    const page = new Page('default');
    await page.handleJavaScriptDialog(true, 'confirm');

    expect(sendCommandMock).toHaveBeenCalledWith('cdp', expect.objectContaining({
      session: 'default',
      surface: 'browser',
      cdpMethod: 'Page.handleJavaScriptDialog',
      cdpParams: { accept: true, promptText: 'confirm' },
    }));
  });
});

describe('Page active target tracking', () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
    sendCommandFullMock.mockReset();
    warnMock.mockReset();
  });

  it('tracks only one active page identity at a time', async () => {
    sendCommandFullMock
      .mockResolvedValueOnce({ data: { url: 'https://first.example' }, page: 'page-1' })
      .mockResolvedValueOnce({ data: { selected: true }, page: 'page-2' });
    sendCommandMock.mockResolvedValue('ok');

    const page = new Page('default');

    await page.goto('https://first.example', { waitUntil: 'none' });
    expect(page.getActivePage()).toBe('page-1');

    await page.selectTab(1);
    expect(page.getActivePage()).toBe('page-2');

    await page.evaluate('1 + 1');

    expect(sendCommandMock).toHaveBeenLastCalledWith('exec', expect.objectContaining({
      session: 'default',
      surface: 'browser',
      page: 'page-2',
    }));
  });

  it('allows the caller to bind a specific active page identity explicitly', async () => {
    sendCommandMock.mockResolvedValue('bound');

    const page = new Page('default');
    page.setActivePage?.('page-explicit');

    await page.evaluate('1 + 1');

    expect(sendCommandMock).toHaveBeenCalledWith('exec', expect.objectContaining({
      session: 'default',
      surface: 'browser',
      page: 'page-explicit',
    }));
  });

  // Regression: a Page instance can keep re-sending a cached targetId after the tab
  // has been closed externally, so the extension throws
  // "Page not found: <id> — stale page identity" on follow-up navigation.
  // goto() now drops the stale identity and retries once without it so the extension's
  // session lease can resolve through to a live tab.
  it('drops a stale page identity and retries navigate once', async () => {
    sendCommandFullMock
      .mockResolvedValueOnce({ data: { url: 'https://example.com/first' }, page: 'page-1' })
      .mockRejectedValueOnce(new Error('Page not found: deadbeef — stale page identity'))
      .mockResolvedValueOnce({ data: { url: 'https://example.com/second' }, page: 'page-2' });

    const page = new Page('site:youtube', undefined, undefined, undefined, 'adapter', 'persistent');

    await page.goto('https://example.com/first', { waitUntil: 'none' });
    expect(page.getActivePage()).toBe('page-1');

    await page.goto('https://example.com/second', { waitUntil: 'none' });
    expect(page.getActivePage()).toBe('page-2');

    expect(sendCommandFullMock).toHaveBeenCalledTimes(3);
    // First retry attempt carried the stale page; the recovery call must drop it.
    const retryCall = sendCommandFullMock.mock.calls[2];
    expect(retryCall[0]).toBe('navigate');
    expect(retryCall[1]).not.toHaveProperty('page');
    expect(retryCall[1]).toMatchObject({ waitUntil: 'none' });
  });

  it('does not retry stale page errors when no identity was cached', async () => {
    // _page is undefined on a fresh Page — there's nothing to drop, so propagate the
    // error instead of silently retrying with the same params.
    sendCommandFullMock
      .mockRejectedValueOnce(new Error('Page not found: deadbeef — stale page identity'));

    const page = new Page('site:youtube', undefined, undefined, undefined, 'adapter', 'persistent');

    await expect(page.goto('https://example.com', { waitUntil: 'none' }))
      .rejects.toThrow('stale page identity');
    expect(sendCommandFullMock).toHaveBeenCalledTimes(1);
  });

  it('propagates non-stale navigate errors unchanged', async () => {
    sendCommandFullMock
      .mockResolvedValueOnce({ data: { url: 'https://example.com/first' }, page: 'page-1' })
      .mockRejectedValueOnce(new Error('Extension disconnected'));

    const page = new Page('site:youtube', undefined, undefined, undefined, 'adapter', 'persistent');

    await page.goto('https://example.com/first', { waitUntil: 'none' });
    await expect(page.goto('https://example.com/second', { waitUntil: 'none' }))
      .rejects.toThrow('Extension disconnected');
    // No retry for unrelated errors — exactly two navigate calls total.
    expect(sendCommandFullMock).toHaveBeenCalledTimes(2);
  });

  it('creates a new tab without changing the current active page binding', async () => {
    sendCommandFullMock
      .mockResolvedValueOnce({ data: { url: 'https://first.example' }, page: 'page-1' })
      .mockResolvedValueOnce({
        data: { url: 'https://second.example' },
        page: 'page-2',
      });
    sendCommandMock.mockResolvedValue('ok');

    const page = new Page('default');
    await page.goto('https://first.example', { waitUntil: 'none' });

    const created = await page.newTab?.('https://second.example');

    expect(created).toBe('page-2');
    expect(page.getActivePage()).toBe('page-1');
    await page.evaluate('1 + 1');
    expect(sendCommandMock).toHaveBeenLastCalledWith('exec', expect.objectContaining({
      session: 'default',
      surface: 'browser',
      page: 'page-1',
    }));
  });

  it('allows the caller to adopt a new tab explicitly after creation', async () => {
    sendCommandFullMock.mockResolvedValueOnce({
      data: { url: 'https://second.example' },
      page: 'page-2',
    });

    const page = new Page('default');
    const created = await page.newTab?.('https://second.example');

    expect(created).toBe('page-2');
    expect(page.getActivePage()).toBeUndefined();

    page.setActivePage?.(created);
    expect(page.getActivePage()).toBe('page-2');
    expect(sendCommandFullMock).toHaveBeenCalledWith('tabs', expect.objectContaining({
      op: 'new',
      url: 'https://second.example',
      session: 'default',
      surface: 'browser',
    }));
  });

  it('closes a tab by explicit page identity', async () => {
    sendCommandMock.mockResolvedValueOnce({ closed: 'page-2' });

    const page = new Page('default');
    await page.closeTab?.('page-2');

    expect(sendCommandMock).toHaveBeenCalledWith('tabs', expect.objectContaining({
      op: 'close',
      session: 'default',
      surface: 'browser',
      page: 'page-2',
    }));
  });

  it('clears the active page binding when closing the selected tab by numeric index', async () => {
    sendCommandFullMock.mockResolvedValueOnce({ data: { selected: true }, page: 'page-2' });
    sendCommandMock
      .mockResolvedValueOnce({ closed: 'page-2' })
      .mockResolvedValueOnce('ok');

    const page = new Page('default');

    await page.selectTab(1);
    expect(page.getActivePage()).toBe('page-2');

    await page.closeTab?.(1);
    expect(page.getActivePage()).toBeUndefined();

    await page.evaluate('1 + 1');

    const evalCall = sendCommandMock.mock.calls.at(-1);
    expect(evalCall?.[0]).toBe('exec');
    expect(evalCall?.[1]).toEqual(expect.objectContaining({
      session: 'default',
      surface: 'browser',
    }));
    expect(evalCall?.[1]).not.toHaveProperty('page');
  });
});

describe('Page.screenshot', () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
    sendCommandFullMock.mockReset();
    warnMock.mockReset();
  });

  it.each([1, 2])('forwards explicit DPR %s to the extension', async (dpr) => {
    sendCommandMock.mockResolvedValueOnce('BASE64');
    await new Page('default').screenshot({ dpr });
    expect(sendCommandMock).toHaveBeenCalledWith('screenshot', expect.objectContaining({ dpr }));
  });

  it('forwards width / height / fullPage options to the bridge', async () => {
    sendCommandMock.mockResolvedValueOnce('BASE64');

    const page = new Page('default');
    const data = await page.screenshot({ fullPage: true, width: 1080 });

    expect(data).toBe('BASE64');
    expect(sendCommandMock).toHaveBeenCalledWith('screenshot', expect.objectContaining({
      session: 'default',
      surface: 'browser',
      fullPage: true,
      width: 1080,
    }));
  });

  it('omits viewport overrides when none are set', async () => {
    sendCommandMock.mockResolvedValueOnce('BASE64');

    const page = new Page('default');
    await page.screenshot();

    const call = sendCommandMock.mock.calls.at(-1);
    expect(call?.[0]).toBe('screenshot');
    const args = call?.[1] as Record<string, unknown>;
    expect(args.width).toBeUndefined();
    expect(args.height).toBeUndefined();
    expect(args.fullPage).toBeUndefined();
  });
});


describe('Page.evaluateOnce', () => {
  it('uses the no-retry transport and never retries a navigation error', async () => {
    sendCommandOnceMock.mockReset(); sendCommandMock.mockReset();
    sendCommandOnceMock.mockRejectedValue(new Error('Inspected target navigated or closed'));
    const page = new Page('site:xiaohongshu', undefined, undefined, undefined, 'adapter', 'persistent');
    page.setActivePage('confirmed-editor');
    await expect(page.evaluateOnce('window.finalGesture()')).rejects.toThrow('navigated');
    expect(sendCommandOnceMock).toHaveBeenCalledTimes(1);
    expect(sendCommandOnceMock).toHaveBeenCalledWith('exec', expect.objectContaining({page:'confirmed-editor',surface:'adapter',siteSession:'persistent'}));
    expect(sendCommandMock).not.toHaveBeenCalled();
  });
});


describe('Page file upload recovery',()=>{
 beforeEach(()=>{fetchDaemonStatusMock.mockReset();sendCommandMock.mockReset();requestExtensionReconnectMock.mockReset();});
 const missing=()=>new Error('Connected Browser Bridge does not advertise file-input-shadow-v1.');
 it('recovers only the selected profile and retries the same upload once',async()=>{
  sendCommandMock.mockRejectedValueOnce(missing()).mockResolvedValueOnce({count:1});
  fetchDaemonStatusMock.mockResolvedValue({contextId:'profile-a',extensionCapabilities:[]}).mockResolvedValueOnce({contextId:'profile-a',extensionCapabilities:[]}).mockResolvedValueOnce({contextId:'profile-a',extensionCapabilities:[]}).mockResolvedValueOnce({contextId:'profile-a',extensionCapabilities:['file-input-shadow-v1']});
  requestExtensionReconnectMock.mockResolvedValue(true);
  const page=new Page('publisher',undefined,'profile-a',undefined,'adapter');page.setActivePage('exact-editor');
  await page.setFileInput(['/tmp/cover.png'],'#cover');
  expect(requestExtensionReconnectMock).toHaveBeenCalledExactlyOnceWith({contextId:'profile-a'});
  expect(sendCommandMock).toHaveBeenCalledTimes(2);
  for(const [action,params] of sendCommandMock.mock.calls){expect(action).toBe('set-file-input');expect(params).toMatchObject({files:['/tmp/cover.png'],selector:'#cover',page:'exact-editor',contextId:'profile-a',surface:'adapter'});}
 });
 it('does not replay a transport failure after file injection',async()=>{
  sendCommandMock.mockRejectedValue(new Error('connection reset'));
  await expect(new Page('publisher').setFileInput(['/tmp/cover.png'])).rejects.toThrow('connection reset');
  expect(sendCommandMock).toHaveBeenCalledTimes(1);expect(requestExtensionReconnectMock).not.toHaveBeenCalled();
 });
 it('preserves the original error when recovery is refused for a busy profile',async()=>{
  const error=missing();sendCommandMock.mockRejectedValue(error);
  fetchDaemonStatusMock.mockResolvedValue({contextId:'profile-a',extensionCapabilities:[]});requestExtensionReconnectMock.mockResolvedValue(false);
  await expect(new Page('publisher',undefined,'profile-a').setFileInput(['/tmp/cover.png'])).rejects.toBe(error);
  expect(sendCommandMock).toHaveBeenCalledTimes(1);
 });
 it('does not choose a profile when status is ambiguous',async()=>{
  const error=missing();sendCommandMock.mockRejectedValue(error);fetchDaemonStatusMock.mockResolvedValue({profileRequired:true});
  await expect(new Page('publisher').setFileInput(['/tmp/cover.png'])).rejects.toBe(error);
  expect(requestExtensionReconnectMock).not.toHaveBeenCalled();
 });
 it('does not retry an upload more than once if the capability is still rejected',async()=>{
  sendCommandMock.mockRejectedValue(missing());fetchDaemonStatusMock.mockResolvedValue({contextId:'profile-a',extensionCapabilities:['file-input-shadow-v1']});
  await expect(new Page('publisher',undefined,'profile-a').setFileInput(['/tmp/cover.png'])).rejects.toThrow('does not advertise');
  expect(sendCommandMock).toHaveBeenCalledTimes(2);expect(requestExtensionReconnectMock).not.toHaveBeenCalled();
 });
});
