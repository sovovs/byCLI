import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createChromeMock() {
  const debuggerEventListeners: Array<(source: { tabId?: number }, method: string, params: any) => void> = [];
  const tabRemovedListeners: Array<(tabId: number) => void> = [];
  const tabs = {
    get: vi.fn(async (_tabId: number) => ({
      id: 1,
      windowId: 1,
      url: 'https://x.com/home',
    })),
    onRemoved: { addListener: vi.fn((fn: (tabId: number) => void) => { tabRemovedListeners.push(fn); }) },
    onUpdated: { addListener: vi.fn() },
  };

  const debuggerApi = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn(async (_target: unknown, method: string) => {
      if (method === 'Runtime.evaluate') return { result: { value: 'ok' } };
      return {};
    }),
    onDetach: { addListener: vi.fn() },
    onEvent: { addListener: vi.fn((fn: (source: { tabId?: number }, method: string, params: any) => void) => { debuggerEventListeners.push(fn); }) },
  };

  const scripting = {
    executeScript: vi.fn(async () => [{ result: { removed: 1 } }]),
  };

  return {
    chrome: {
      tabs,
      debugger: debuggerApi,
      scripting,
      runtime: { id: 'bycli-test' },
    },
    debuggerApi,
    scripting,
    debuggerEventListeners,
    tabRemovedListeners,
  };
}

describe('cdp attach recovery', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not mutate the DOM before a successful attach', async () => {
    const { chrome, debuggerApi, scripting } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    const result = await mod.evaluate(1, '1');

    expect(result).toBe('ok');
    expect(debuggerApi.attach).toHaveBeenCalledTimes(1);
    expect(scripting.executeScript).not.toHaveBeenCalled();
  });

  it('uses the default execution context for a frame when isolated worlds also exist', async () => {
    const { chrome, debuggerApi, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    mod.registerFrameTracking();

    expect(debuggerEventListeners.length).toBeGreaterThanOrEqual(1);
    for (const listener of debuggerEventListeners) {
      listener(
        { tabId: 1 },
        'Runtime.executionContextCreated',
        { context: { id: 11, auxData: { frameId: 'frame-1', isDefault: false } } },
      );
      listener(
        { tabId: 1 },
        'Runtime.executionContextCreated',
        { context: { id: 22, auxData: { frameId: 'frame-1', isDefault: true } } },
      );
    }

    await mod.evaluateInFrame(1, 'document.title', 'frame-1');

    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Runtime.evaluate',
      expect.objectContaining({ contextId: 22 }),
    );
  });

  it('falls back to a frame target when no same-target execution context exists', async () => {
    const { chrome, debuggerApi, debuggerEventListeners } = createChromeMock();
    debuggerApi.sendCommand = vi.fn(async (target: any, method: string, _params?: any) => {
      if (method === 'Target.setDiscoverTargets') return {};
      if (method === 'Target.setAutoAttach') return {};
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'oopif-frame', type: 'iframe', url: 'https://frame.test' }] };
      if (target?.targetId === 'oopif-frame' && method === 'Runtime.enable') return {};
      if (target?.targetId === 'oopif-frame' && method === 'Runtime.evaluate') {
        return { result: { value: 'frame-ok' } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: 'root-ok' } };
      return {};
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    mod.registerFrameTracking();

    const result = await mod.evaluateInFrame(1, 'document.title', 'oopif-frame');

    expect(result).toBe('frame-ok');
    expect(debuggerApi.attach).toHaveBeenCalledWith({ targetId: 'oopif-frame' }, '1.3');
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      { targetId: 'oopif-frame' },
      'Runtime.evaluate',
      expect.any(Object),
    );
  });

});

function chromeMockForScreenshot(content: { width: number; height: number } = { width: 1024, height: 2048 }) {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const debuggerApi = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn(async (_target: unknown, method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === 'Page.captureScreenshot') return { data: 'BASE64DATA' };
      if (method === 'Page.getLayoutMetrics') return { cssContentSize: content };
      return {};
    }),
    onDetach: { addListener: vi.fn() },
    onEvent: { addListener: vi.fn() },
  };
  const tabs = {
    get: vi.fn(async () => ({ id: 1, windowId: 1, url: 'https://example.com' })),
    onRemoved: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
  };
  return {
    chrome: { tabs, debugger: debuggerApi, scripting: {}, runtime: { id: 'bycli-test' } },
    debuggerApi,
    calls,
  };
}

describe('cdp screenshot', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('takes a viewport screenshot without overriding device metrics by default', async () => {
    const { chrome, calls } = chromeMockForScreenshot();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    const data = await mod.screenshot(1);

    expect(data).toBe('BASE64DATA');
    const methods = calls.map((c) => c.method);
    expect(methods).not.toContain('Emulation.setDeviceMetricsOverride');
    expect(methods).not.toContain('Emulation.clearDeviceMetricsOverride');
    expect(methods).toContain('Page.captureScreenshot');
  });

  it('overrides only width when --width is given without --full-page', async () => {
    const { chrome, calls } = chromeMockForScreenshot();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    await mod.screenshot(1, { width: 1080 });

    const overrides = calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].params).toEqual({ mobile: false, width: 1080, height: 0, deviceScaleFactor: 1 });
    expect(calls.some((c) => c.method === 'Page.getLayoutMetrics')).toBe(false);
    expect(calls.at(-1)?.method).toBe('Emulation.clearDeviceMetricsOverride');
  });

  it('overrides only height when --height is given without --full-page', async () => {
    const { chrome, calls } = chromeMockForScreenshot();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    await mod.screenshot(1, { height: 720 });

    const overrides = calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].params).toEqual({ mobile: false, width: 0, height: 720, deviceScaleFactor: 1 });
    expect(calls.at(-1)?.method).toBe('Emulation.clearDeviceMetricsOverride');
  });

  it('uses content size for fullPage screenshots without explicit dimensions', async () => {
    const { chrome, calls } = chromeMockForScreenshot({ width: 1024, height: 2048 });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    await mod.screenshot(1, { fullPage: true });

    const overrides = calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].params).toEqual({ mobile: false, width: 1024, height: 2048, deviceScaleFactor: 1 });
    expect(calls.at(-1)?.method).toBe('Emulation.clearDeviceMetricsOverride');
  });

  it('ignores --height under --full-page so the existing measure-from-content path is preserved', async () => {
    const { chrome, calls } = chromeMockForScreenshot({ width: 1024, height: 2048 });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    await mod.screenshot(1, { fullPage: true, height: 600 });

    const overrides = calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].params).toEqual({ mobile: false, width: 1024, height: 2048, deviceScaleFactor: 1 });
    expect(calls.at(-1)?.method).toBe('Emulation.clearDeviceMetricsOverride');
  });

  it('reflows at the requested width before measuring full-page height', async () => {
    // Simulate that at width=1080 the page reflows to a different content height.
    const { chrome, calls } = chromeMockForScreenshot({ width: 1080, height: 1500 });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    await mod.screenshot(1, { fullPage: true, width: 1080 });

    const overrides = calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    expect(overrides).toHaveLength(2);
    expect(overrides[0].params).toEqual({ mobile: false, width: 1080, height: 0, deviceScaleFactor: 1 });
    expect(overrides[1].params).toEqual({ mobile: false, width: 1080, height: 1500, deviceScaleFactor: 1 });

    const layoutBetween = calls.findIndex((c) => c.method === 'Page.getLayoutMetrics');
    const firstOverride = calls.findIndex((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    expect(layoutBetween).toBeGreaterThan(firstOverride);
    expect(calls.at(-1)?.method).toBe('Emulation.clearDeviceMetricsOverride');
  });

  it('clears the device metrics override even when capture throws', async () => {
    const debuggerApi = {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_t: unknown, method: string) => {
        if (method === 'Page.captureScreenshot') throw new Error('capture-failed');
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 800, height: 600 } };
        return {};
      }),
      onDetach: { addListener: vi.fn() },
      onEvent: { addListener: vi.fn() },
    };
    const chrome = {
      tabs: {
        get: vi.fn(async () => ({ id: 1, windowId: 1, url: 'https://example.com' })),
        onRemoved: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
      },
      debugger: debuggerApi,
      scripting: {},
      runtime: { id: 'bycli-test' },
    };
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    await expect(mod.screenshot(1, { width: 800 })).rejects.toThrow('capture-failed');

    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Emulation.clearDeviceMetricsOverride',
    );
  });
});

function chromeMockForDownloads(initialItems: chrome.downloads.DownloadItem[] = []) {
  const items = new Map(initialItems.map((item) => [item.id, item]));
  const createdListeners: Array<(item: chrome.downloads.DownloadItem) => void> = [];
  const changedListeners: Array<(delta: chrome.downloads.DownloadDelta) => void> = [];
  const downloads = {
    search: vi.fn(async (query: chrome.downloads.DownloadQuery) => {
      if (typeof query.id === 'number') {
        const item = items.get(query.id);
        return item ? [item] : [];
      }
      const startedAfter = typeof query.startedAfter === 'string' ? Date.parse(query.startedAfter) : Number.NaN;
      return [...items.values()].filter((item) => {
        if (!Number.isFinite(startedAfter)) return true;
        const itemStartedAt = typeof item.startTime === 'string' ? Date.parse(item.startTime) : Number.NaN;
        return Number.isFinite(itemStartedAt) && itemStartedAt > startedAfter;
      });
    }),
    onCreated: {
      addListener: vi.fn((fn: (item: chrome.downloads.DownloadItem) => void) => { createdListeners.push(fn); }),
      removeListener: vi.fn((fn: (item: chrome.downloads.DownloadItem) => void) => {
        const idx = createdListeners.indexOf(fn);
        if (idx >= 0) createdListeners.splice(idx, 1);
      }),
    },
    onChanged: {
      addListener: vi.fn((fn: (delta: chrome.downloads.DownloadDelta) => void) => { changedListeners.push(fn); }),
      removeListener: vi.fn((fn: (delta: chrome.downloads.DownloadDelta) => void) => {
        const idx = changedListeners.indexOf(fn);
        if (idx >= 0) changedListeners.splice(idx, 1);
      }),
    },
  };
  return {
    chrome: { downloads },
    downloads,
    setItem(item: chrome.downloads.DownloadItem) {
      items.set(item.id, item);
    },
    emitCreated(item: chrome.downloads.DownloadItem) {
      items.set(item.id, item);
      for (const listener of [...createdListeners]) listener(item);
    },
    emitChanged(delta: chrome.downloads.DownloadDelta) {
      for (const listener of [...changedListeners]) listener(delta);
    },
  };
}

describe('cdp download waits', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns a recent completed download matching filename or URL', async () => {
    const { chrome, downloads } = chromeMockForDownloads([
      {
        id: 7,
        filename: '/tmp/receipt.pdf',
        url: 'https://app.example/download?id=receipt',
        finalUrl: 'https://cdn.example/receipt.pdf',
        mime: 'application/pdf',
        state: 'complete',
        totalBytes: 1234,
        danger: 'safe',
        startTime: new Date().toISOString(),
      } as chrome.downloads.DownloadItem,
    ]);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    const result = await mod.waitForDownload('receipt', 1000);

    expect(result).toMatchObject({
      downloaded: true,
      id: 7,
      filename: '/tmp/receipt.pdf',
      state: 'complete',
    });
    expect(downloads.onCreated.removeListener).toHaveBeenCalledTimes(1);
    expect(downloads.onChanged.removeListener).toHaveBeenCalledTimes(1);
  });

  it('ignores matching recent downloads when waiting only for a newly created download', async () => {
    const oldDownload = {
      id: 7,
      filename: '/tmp/old-receipt.xls',
      url: 'https://app.example/download?id=receipt',
      finalUrl: 'https://cdn.example/receipt.xls',
      mime: 'application/vnd.ms-excel',
      state: 'complete',
      totalBytes: 1234,
      danger: 'safe',
      startTime: new Date().toISOString(),
    } as chrome.downloads.DownloadItem;
    const mock = chromeMockForDownloads([oldDownload]);
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    const promise = mod.waitForDownload('receipt', 1000, { includeRecent: false });
    let settled = false;
    void promise.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(mock.downloads.search).not.toHaveBeenCalled();

    mock.emitChanged({
      id: 7,
      filename: { current: '/tmp/old-receipt.xls', previous: '/tmp/old-receipt.crdownload' },
    } as chrome.downloads.DownloadDelta);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mock.downloads.search).not.toHaveBeenCalled();

    const newDownload = {
      ...oldDownload,
      id: 8,
      filename: '/tmp/new-receipt.crdownload',
      state: 'in_progress',
      totalBytes: 0,
    } as chrome.downloads.DownloadItem;
    mock.emitCreated(newDownload);
    mock.setItem({
      ...newDownload,
      filename: '/tmp/new-receipt.xls',
      state: 'complete',
      totalBytes: 5678,
    });
    mock.emitChanged({
      id: 8,
      state: { current: 'complete', previous: 'in_progress' },
    } as chrome.downloads.DownloadDelta);

    await expect(promise).resolves.toMatchObject({
      downloaded: true,
      id: 8,
      filename: '/tmp/new-receipt.xls',
    });
  });

  it('accepts only matching recent downloads at or after an explicit start threshold', async () => {
    const threshold = 1_786_000_000_000;
    const common = {
      url: 'https://app.example/download?id=receipt',
      finalUrl: 'https://cdn.example/receipt.xls',
      mime: 'application/vnd.ms-excel',
      state: 'complete',
      totalBytes: 1234,
      danger: 'safe',
    };
    const mock = chromeMockForDownloads([
      { ...common, id: 7, filename: '/tmp/old.xls', startTime: new Date(threshold - 1).toISOString() } as chrome.downloads.DownloadItem,
      { ...common, id: 8, filename: '/tmp/new.xls', startTime: new Date(threshold).toISOString() } as chrome.downloads.DownloadItem,
    ]);
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    const result = await mod.waitForDownload('receipt', 1000, { startedAfterMs: threshold });

    expect(mock.downloads.search).toHaveBeenCalledWith(expect.objectContaining({
      startedAfter: new Date(threshold - 1).toISOString(),
    }));
    expect(result).toMatchObject({ id: 8, filename: '/tmp/new.xls' });
  });

  it('rechecks an in-progress recent snapshot after its completion event was already missed', async () => {
    const threshold = 1_786_000_000_000;
    const inProgress = {
      id: 9,
      filename: '/tmp/receipt.crdownload',
      url: 'https://app.example/download?id=receipt',
      finalUrl: 'https://cdn.example/receipt.xls',
      mime: 'application/vnd.ms-excel',
      state: 'in_progress',
      totalBytes: 0,
      danger: 'safe',
      startTime: new Date(threshold).toISOString(),
    } as chrome.downloads.DownloadItem;
    const mock = chromeMockForDownloads([inProgress]);
    const completed = {
      ...inProgress,
      filename: '/tmp/receipt.xls',
      state: 'complete',
      totalBytes: 5678,
    } as chrome.downloads.DownloadItem;
    mock.downloads.search.mockImplementation(async (query: chrome.downloads.DownloadQuery) => {
      if (typeof query.id === 'number') return query.id === 9 ? [completed] : [];
      mock.emitChanged({
        id: 9,
        state: { current: 'complete', previous: 'in_progress' },
      } as chrome.downloads.DownloadDelta);
      return [inProgress];
    });
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    const result = await mod.waitForDownload('receipt', 50, { startedAfterMs: threshold });

    expect(mock.downloads.search).toHaveBeenCalledWith({ id: 9 });
    expect(result).toMatchObject({
      downloaded: true,
      id: 9,
      filename: '/tmp/receipt.xls',
      state: 'complete',
    });
  });

  it.each([
    { label: 'older', startTime: new Date(1_786_000_000_000 - 1).toISOString() },
    { label: 'missing', startTime: undefined },
    { label: 'invalid', startTime: 'not-a-date' },
  ])('does not accept a $label recent download before the explicit threshold', async ({ startTime }) => {
    vi.useFakeTimers();
    const threshold = 1_786_000_000_000;
    vi.setSystemTime(threshold + 10);
    const mock = chromeMockForDownloads([{
      id: 7,
      filename: '/tmp/old-receipt.xls',
      url: 'https://app.example/download?id=receipt',
      finalUrl: 'https://cdn.example/receipt.xls',
      mime: 'application/vnd.ms-excel',
      state: 'complete',
      totalBytes: 1234,
      danger: 'safe',
      startTime,
    } as chrome.downloads.DownloadItem]);
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    const promise = mod.waitForDownload('receipt', 50, { startedAfterMs: threshold });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    await expect(promise).resolves.toMatchObject({ downloaded: false, state: 'interrupted' });
  });

  it('waits for a matching in-progress download to complete', async () => {
    const mock = chromeMockForDownloads();
    vi.stubGlobal('chrome', mock.chrome);

    const mod = await import('./cdp');
    const promise = mod.waitForDownload('invoice', 1000);
    await Promise.resolve();

    const started = {
      id: 42,
      filename: '/tmp/invoice.crdownload',
      url: 'https://app.example/invoice',
      finalUrl: 'https://app.example/invoice',
      mime: 'application/pdf',
      state: 'in_progress',
      totalBytes: 0,
      danger: 'safe',
      startTime: new Date().toISOString(),
    } as chrome.downloads.DownloadItem;
    mock.emitCreated(started);
    mock.setItem({ ...started, filename: '/tmp/invoice.pdf', state: 'complete', totalBytes: 4567 });
    mock.emitChanged({ id: 42, state: { current: 'complete', previous: 'in_progress' } } as chrome.downloads.DownloadDelta);

    await expect(promise).resolves.toMatchObject({
      downloaded: true,
      id: 42,
      filename: '/tmp/invoice.pdf',
      state: 'complete',
    });
  });
});

describe('network capture · Fetch/XHR filter + WebSocket frames', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  // Drive every registered debugger event listener (handlers self-guard on `method`).
  async function emitAll(
    listeners: Array<(s: { tabId?: number }, m: string, p: any) => void>,
    tabId: number, method: string, params: any,
  ): Promise<void> {
    for (const fn of listeners) await fn({ tabId }, method, params);
  }

  it('records Fetch/XHR and Document responses; drops Script and Image resources', async () => {
    const { chrome, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1);

    const req = (requestId: string, type: string, url: string) =>
      emitAll(debuggerEventListeners, 1, 'Network.requestWillBeSent', {
        requestId, type, request: { url, method: 'GET', headers: {} },
      });
    await req('a', 'XHR', 'https://x.com/api/a');
    await req('b', 'Fetch', 'https://x.com/api/b');
    await req('c', 'Script', 'https://x.com/app.js');
    await req('d', 'Document', 'https://x.com/');
    await req('e', 'Image', 'https://x.com/logo.png');

    const entries = await mod.readNetworkCapture(1);
    const urls = entries.map((e) => e.url).sort();
    expect(urls).toEqual(['https://x.com/', 'https://x.com/api/a', 'https://x.com/api/b']);
    expect(entries.every((e) => e.kind === 'cdp')).toBe(true);
  });

  it('drops XHR/fetch-loaded static assets by response Content-Type (css/js/font/image), keeps JSON/HTML', async () => {
    const { chrome, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1);
    const emit = (m: string, p: any) => emitAll(debuggerEventListeners, 1, m, p);

    // all are XHR at the resourceType layer (pass gate 1) but differ by response content-type.
    const reqResp = async (id: string, url: string, mimeType: string) => {
      await emit('Network.requestWillBeSent', { requestId: id, type: 'XHR', request: { url, method: 'GET', headers: {} } });
      await emit('Network.responseReceived', { requestId: id, response: { url, status: 200, mimeType, headers: {} } });
    };
    await reqResp('json', 'https://x.com/api/data', 'application/json');
    await reqResp('css', 'https://x.com/theme.css', 'text/css');            // fetch()-loaded CSS → drop
    await reqResp('js', 'https://x.com/chunk.js', 'application/javascript'); // → drop
    await reqResp('png', 'https://x.com/sprite.png', 'image/png');          // → drop
    await reqResp('html', 'https://x.com/fragment', 'text/html');           // scrape data → keep

    const entries = await mod.readNetworkCapture(1);
    const urls = entries.map((e) => e.url).sort();
    expect(urls).toEqual(['https://x.com/api/data', 'https://x.com/fragment']);
  });

  it('masks auth tokens in captured URLs (query token/jwt) but keeps seed-arg params', async () => {
    const { chrome, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1);
    const emit = (m: string, p: any) => emitAll(debuggerEventListeners, 1, m, p);

    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjF9.abcDEF123_-signature';
    // HTTP:keyword(seed)保留;token(名)+ jwt(值)脱敏;author 不因含 'auth' 被误杀。
    await emit('Network.requestWillBeSent', {
      requestId: 'h', type: 'XHR',
      request: { url: `https://x.com/api/s?keyword=cat&beyond-token=${jwt}&author=jdoe&t=${jwt}`, method: 'GET', headers: {} },
    });
    // WS:握手 URL 的 token 脱敏。
    await emit('Network.webSocketCreated', { requestId: 'w', url: `wss://x.com/ws?beyond-token=${jwt}` });

    const entries = await mod.readNetworkCapture(1);
    const http = entries.find((e) => e.kind === 'cdp')!;
    expect(http.url).toContain('keyword=cat');      // 种子参数原样保留
    expect(http.url).toContain('author=jdoe');       // 'author' 不被误杀
    expect(http.url).not.toContain(jwt);             // token 值彻底不在
    expect(http.url).toContain('beyond-token=***');  // 按名脱敏
    expect(http.url).toContain('t=***');             // JWT 值即使参数名无关也被兜底脱敏
    const ws = entries.find((e) => e.kind === 'cdp-websocket')!;
    expect(ws.url).not.toContain(jwt);
    expect(ws.url).toContain('beyond-token=***');
  });

  it('captures WebSocket frames (kind=cdp-websocket): text/binary kept, control dropped, caps respected', async () => {
    const { chrome, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1);
    const emit = (m: string, p: any) => emitAll(debuggerEventListeners, 1, m, p);

    await emit('Network.webSocketCreated', { requestId: 'ws1', url: 'wss://x.com/stream' });
    await emit('Network.webSocketHandshakeResponseReceived', { requestId: 'ws1', response: { status: 101, headers: {} } });
    await emit('Network.webSocketFrameReceived', { requestId: 'ws1', response: { opcode: 1, payloadData: '{"price":1}' } });
    await emit('Network.webSocketFrameSent', { requestId: 'ws1', response: { opcode: 1, payloadData: 'subscribe' } });
    await emit('Network.webSocketFrameReceived', { requestId: 'ws1', response: { opcode: 9, payloadData: 'ping' } }); // control → dropped
    await emit('Network.webSocketFrameReceived', { requestId: 'ws1', response: { opcode: 2, payloadData: 'QUJD' } }); // binary → base64:

    const entries = await mod.readNetworkCapture(1);
    const ws = entries.find((e) => e.kind === 'cdp-websocket')!;
    expect(ws).toBeTruthy();
    expect(ws.url).toBe('wss://x.com/stream');
    expect(ws.responseStatus).toBe(101);
    const frames = ws.webSocketFrames!;
    expect(frames).toHaveLength(3); // 2 data text/sent + 1 binary; ping(9) dropped
    expect(frames[0]).toMatchObject({ direction: 'received', opcode: 1, payloadPreview: '{"price":1}' });
    expect(frames[1]).toMatchObject({ direction: 'sent', opcode: 1, payloadPreview: 'subscribe' });
    expect(frames[2].payloadPreview).toMatch(/^base64:/);
  });
});

describe('network capture · OOPIF (cross-origin iframe) sessionId routing', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  // emit with an explicit source (top-level {tabId} or child {tabId, sessionId}).
  async function emitFrom(
    listeners: Array<(s: any, m: string, p: any) => void>,
    source: { tabId?: number; sessionId?: string }, method: string, params: any,
  ): Promise<void> {
    for (const fn of listeners) await fn(source, method, params);
  }

  it('routes a child-session XHR into the parent tab buffer with its frameId', async () => {
    const { chrome, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1);

    // iframe attaches as a flat child session.
    await emitFrom(debuggerEventListeners, { tabId: 1 }, 'Target.attachedToTarget', {
      sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'T1', url: 'https://iframe.example/' },
    });
    // request originates in the child session (source carries sessionId, tabId stays parent).
    await emitFrom(debuggerEventListeners, { tabId: 1, sessionId: 'S1' }, 'Network.requestWillBeSent', {
      requestId: 'r1', type: 'XHR', frameId: 'F-IFRAME',
      request: { url: 'https://iframe.example/api/data', method: 'GET', headers: {} },
    });

    const entries = await mod.readNetworkCapture(1);
    expect(entries.map((e) => e.url)).toEqual(['https://iframe.example/api/data']);
    expect(entries[0].frameId).toBe('F-IFRAME');
    expect(entries[0].frameSessionId).toBe('S1');
    expect(entries[0].frameUrl).toBe('https://iframe.example/'); // from targetInfo.url
  });

  it('stamps frameUrl (from targetInfo.url) on child UI events; top-level events have none', async () => {
    const { chrome, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startUiCapture(1);
    await emitFrom(debuggerEventListeners, { tabId: 1 }, 'Target.attachedToTarget', {
      sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'T1', url: 'https://widget.example/embed?x=1' },
    });
    const click = (source: any, selector: string) =>
      emitFrom(debuggerEventListeners, source, 'Runtime.bindingCalled', {
        name: '__bycli_ui', payload: JSON.stringify({ type: 'click', selector, tag: 'button', ts: 1 }),
      });
    await click({ tabId: 1 }, '#top');
    await click({ tabId: 1, sessionId: 'S1' }, '#in-iframe');

    const { events } = await mod.readUiCapture(1);
    expect(events.find((e) => e.selector === '#top')!.frameUrl).toBeUndefined();
    expect(events.find((e) => e.selector === '#in-iframe')!.frameUrl).toBe('https://widget.example/embed?x=1');
  });

  it('does not collide when top and child reuse the same requestId', async () => {
    const { chrome, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1);
    await emitFrom(debuggerEventListeners, { tabId: 1 }, 'Target.attachedToTarget', {
      sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'T1', url: 'https://iframe.example/' },
    });

    // SAME requestId "1" from top-level and from child session → two distinct entries.
    await emitFrom(debuggerEventListeners, { tabId: 1 }, 'Network.requestWillBeSent', {
      requestId: '1', type: 'XHR', request: { url: 'https://top.example/api/top', method: 'GET', headers: {} },
    });
    await emitFrom(debuggerEventListeners, { tabId: 1, sessionId: 'S1' }, 'Network.requestWillBeSent', {
      requestId: '1', type: 'XHR', request: { url: 'https://iframe.example/api/child', method: 'GET', headers: {} },
    });

    const urls = (await mod.readNetworkCapture(1)).map((e) => e.url).sort();
    expect(urls).toEqual(['https://iframe.example/api/child', 'https://top.example/api/top']);
  });

  it('arms Network.enable on the child session and always resumes it (waitForDebugger)', async () => {
    const { chrome, debuggerApi, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1);
    debuggerApi.sendCommand.mockClear();

    await emitFrom(debuggerEventListeners, { tabId: 1 }, 'Target.attachedToTarget', {
      sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'T1', url: 'https://iframe.example/' },
    });

    const calls = debuggerApi.sendCommand.mock.calls;
    const childCalls = calls.filter((c: any[]) => c[0]?.sessionId === 'S1');
    const methods = childCalls.map((c: any[]) => c[1]);
    expect(methods).toContain('Network.enable');
    expect(methods).toContain('Runtime.runIfWaitingForDebugger');
  });

  it('resumes a non-iframe child without arming capture domains', async () => {
    const { chrome, debuggerApi, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1);
    debuggerApi.sendCommand.mockClear();

    await emitFrom(debuggerEventListeners, { tabId: 1 }, 'Target.attachedToTarget', {
      sessionId: 'W1', targetInfo: { type: 'worker', targetId: 'TW', url: 'https://x.com/sw.js' },
    });

    const childCalls = debuggerApi.sendCommand.mock.calls.filter((c: any[]) => c[0]?.sessionId === 'W1');
    const methods = childCalls.map((c: any[]) => c[1]);
    expect(methods).toEqual(['Runtime.runIfWaitingForDebugger']); // resumed, not armed
  });

  it('clears child-session state on tab removal', async () => {
    const { chrome, debuggerEventListeners, tabRemovedListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1);
    await emitFrom(debuggerEventListeners, { tabId: 1 }, 'Target.attachedToTarget', {
      sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'T1', url: 'https://iframe.example/' },
    });
    // tab closed → child state gone; a late child event must not resurrect a buffer.
    for (const fn of tabRemovedListeners) fn(1);
    await emitFrom(debuggerEventListeners, { tabId: 1, sessionId: 'S1' }, 'Network.requestWillBeSent', {
      requestId: 'r2', type: 'XHR', request: { url: 'https://iframe.example/api/late', method: 'GET', headers: {} },
    });
    expect(await mod.readNetworkCapture(1)).toEqual([]);
  });

  it('re-arms UI binding on a child attached during network-only phase when UI capture starts later', async () => {
    const { chrome, debuggerApi, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    // network capture first; iframe attaches → armed network-only.
    await mod.startNetworkCapture(1);
    await emitFrom(debuggerEventListeners, { tabId: 1 }, 'Target.attachedToTarget', {
      sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'T1', url: 'https://iframe.example/' },
    });
    debuggerApi.sendCommand.mockClear();
    // UI capture starts later → existing child must get its UI binding now (re-arm).
    await mod.startUiCapture(1);

    const childMethods = debuggerApi.sendCommand.mock.calls
      .filter((c: any[]) => c[0]?.sessionId === 'S1').map((c: any[]) => c[1]);
    expect(childMethods).toContain('Runtime.addBinding');
    expect(childMethods).toContain('Page.addScriptToEvaluateOnNewDocument');
  });

  it('does not re-resume an already-attached child on re-arm (runIfWaitingForDebugger only on first attach)', async () => {
    const { chrome, debuggerApi, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1);
    await emitFrom(debuggerEventListeners, { tabId: 1 }, 'Target.attachedToTarget', {
      sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'T1', url: 'https://iframe.example/' },
    });
    debuggerApi.sendCommand.mockClear();
    await mod.startUiCapture(1); // re-arm, NOT a fresh attach
    const resumes = debuggerApi.sendCommand.mock.calls
      .filter((c: any[]) => c[0]?.sessionId === 'S1' && c[1] === 'Runtime.runIfWaitingForDebugger');
    expect(resumes).toHaveLength(0);
  });

  it('tags child-session UI events with frameSessionId; top-level events have none', async () => {
    const { chrome, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startUiCapture(1);
    await emitFrom(debuggerEventListeners, { tabId: 1 }, 'Target.attachedToTarget', {
      sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'T1', url: 'https://iframe.example/' },
    });
    const click = (source: any, selector: string) =>
      emitFrom(debuggerEventListeners, source, 'Runtime.bindingCalled', {
        name: '__bycli_ui', payload: JSON.stringify({ type: 'click', selector, tag: 'button', ts: 1 }),
      });
    await click({ tabId: 1 }, '#top-btn');
    await click({ tabId: 1, sessionId: 'S1' }, '#iframe-btn');

    const { events } = await mod.readUiCapture(1);
    const top = events.find((e) => e.selector === '#top-btn')!;
    const child = events.find((e) => e.selector === '#iframe-btn')!;
    expect(top.frameSessionId).toBeUndefined();
    expect(child.frameSessionId).toBe('S1');
  });

  it('over-cap child sessions are resumed but not armed (no Network.enable)', async () => {
    const { chrome, debuggerApi, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1);
    // fill to the 50-session cap, then one more.
    for (let i = 0; i < 51; i++) {
      await emitFrom(debuggerEventListeners, { tabId: 1 }, 'Target.attachedToTarget', {
        sessionId: `S${i}`, targetInfo: { type: 'iframe', targetId: `T${i}`, url: `https://i${i}.example/` },
      });
    }
    const overCapCalls = debuggerApi.sendCommand.mock.calls.filter((c: any[]) => c[0]?.sessionId === 'S50');
    const methods = overCapCalls.map((c: any[]) => c[1]);
    expect(methods).toEqual(['Runtime.runIfWaitingForDebugger']); // resumed only, never armed
  });

  it('over-cap session stays un-armed across a re-arm (second capture type starting)', async () => {
    const { chrome, debuggerApi, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1);
    for (let i = 0; i < 51; i++) {
      await emitFrom(debuggerEventListeners, { tabId: 1 }, 'Target.attachedToTarget', {
        sessionId: `S${i}`, targetInfo: { type: 'iframe', targetId: `T${i}`, url: `https://i${i}.example/` },
      });
    }
    debuggerApi.sendCommand.mockClear();
    // UI capture starts later → rearmChildSessions iterates all; over-cap S50 must NOT get armed.
    await mod.startUiCapture(1);
    const s50 = debuggerApi.sendCommand.mock.calls.filter((c: any[]) => c[0]?.sessionId === 'S50').map((c: any[]) => c[1]);
    expect(s50).toEqual([]); // persistent overCap short-circuit: no addBinding/Network.enable
  });
});

describe('embedded_iframe noise filter (readNetworkCapture/readUiCapture by targetFrameUrl)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function emitFrom(
    listeners: Array<(s: any, m: string, p: any) => void>,
    source: { tabId?: number; sessionId?: string }, method: string, params: any,
  ): Promise<void> {
    for (const fn of listeners) await fn(source, method, params);
  }

  async function setup() {
    const { chrome, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startNetworkCapture(1);
    return { mod, listeners: debuggerEventListeners };
  }

  it('keeps only the target iframe entries and drops top-level (dashboard) noise', async () => {
    const { mod, listeners } = await setup();
    await emitFrom(listeners, { tabId: 1 }, 'Target.attachedToTarget', {
      sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'T1', url: 'https://juejin.cn/search' },
    });
    // top-level dashboard noise (no sessionId) + iframe request (child session)
    await emitFrom(listeners, { tabId: 1 }, 'Network.requestWillBeSent', {
      requestId: 'top1', type: 'XHR', request: { url: 'http://127.0.0.1:19826/recorder/health', method: 'GET', headers: {} },
    });
    await emitFrom(listeners, { tabId: 1, sessionId: 'S1' }, 'Network.requestWillBeSent', {
      requestId: 'if1', type: 'XHR', request: { url: 'https://juejin.cn/api/list', method: 'GET', headers: {} },
    });

    const entries = await mod.readNetworkCapture(1, { targetFrameUrl: 'https://juejin.cn/search' });
    expect(entries.map((e) => e.url)).toEqual(['https://juejin.cn/api/list']);
  });

  it('matches by same-origin+pathname when the iframe URL differs in query/trailing slash', async () => {
    const { mod, listeners } = await setup();
    // iframe landed on a redirected/normalized URL (extra query, trailing slash)
    await emitFrom(listeners, { tabId: 1 }, 'Target.attachedToTarget', {
      sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'T1', url: 'https://juejin.cn/search/?from=embed' },
    });
    await emitFrom(listeners, { tabId: 1, sessionId: 'S1' }, 'Network.requestWillBeSent', {
      requestId: 'if1', type: 'XHR', request: { url: 'https://juejin.cn/api/x', method: 'GET', headers: {} },
    });
    const entries = await mod.readNetworkCapture(1, { targetFrameUrl: 'https://juejin.cn/search' });
    expect(entries.map((e) => e.url)).toEqual(['https://juejin.cn/api/x']);
  });

  it('includes descendant (nested OOPIF) sessions of the target frame', async () => {
    const { mod, listeners } = await setup();
    // target iframe S1, nested iframe S2 whose parent session is S1
    await emitFrom(listeners, { tabId: 1 }, 'Target.attachedToTarget', {
      sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'T1', url: 'https://juejin.cn/search' },
    });
    await emitFrom(listeners, { tabId: 1, sessionId: 'S1' }, 'Target.attachedToTarget', {
      sessionId: 'S2', targetInfo: { type: 'iframe', targetId: 'T2', url: 'https://ads.example/widget' },
    });
    await emitFrom(listeners, { tabId: 1, sessionId: 'S2' }, 'Network.requestWillBeSent', {
      requestId: 'nested1', type: 'XHR', request: { url: 'https://ads.example/api/track', method: 'GET', headers: {} },
    });
    const entries = await mod.readNetworkCapture(1, { targetFrameUrl: 'https://juejin.cn/search' });
    // nested API kept because S2 is a descendant of target S1
    expect(entries.map((e) => e.url)).toEqual(['https://ads.example/api/track']);
  });

  it('throws ambiguous_iframe_target when multiple frames match the same URL', async () => {
    const { mod, listeners } = await setup();
    for (const sid of ['S1', 'S2']) {
      await emitFrom(listeners, { tabId: 1 }, 'Target.attachedToTarget', {
        sessionId: sid, targetInfo: { type: 'iframe', targetId: `T-${sid}`, url: 'https://juejin.cn/search' },
      });
    }
    await expect(mod.readNetworkCapture(1, { targetFrameUrl: 'https://juejin.cn/search' }))
      .rejects.toMatchObject({ code: 'ambiguous_iframe_target' });
  });

  it('filters UI events the same way (drops top-level dashboard clicks)', async () => {
    const { chrome, debuggerEventListeners } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./cdp');
    mod.registerListeners();
    await mod.startUiCapture(1);
    await emitFrom(debuggerEventListeners, { tabId: 1 }, 'Target.attachedToTarget', {
      sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'T1', url: 'https://juejin.cn/search' },
    });
    const click = (source: any, selector: string) =>
      emitFrom(debuggerEventListeners, source, 'Runtime.bindingCalled', {
        name: '__bycli_ui', payload: JSON.stringify({ type: 'click', selector, tag: 'button', ts: 1 }),
      });
    await click({ tabId: 1 }, '#dashboard-btn');
    await click({ tabId: 1, sessionId: 'S1' }, '#iframe-btn');
    const { events } = await mod.readUiCapture(1, { targetFrameUrl: 'https://juejin.cn/search' });
    expect(events.map((e) => e.selector)).toEqual(['#iframe-btn']);
  });

  it('returns empty (not throw) when no frame matches the target URL', async () => {
    const { mod, listeners } = await setup();
    await emitFrom(listeners, { tabId: 1, sessionId: 'S1' }, 'Network.requestWillBeSent', {
      requestId: 'x', type: 'XHR', request: { url: 'https://other.example/api', method: 'GET', headers: {} },
    });
    const entries = await mod.readNetworkCapture(1, { targetFrameUrl: 'https://nomatch.example/page' });
    expect(entries).toEqual([]);
  });

  it('falls back to keeping all iframe entries when attachedToTarget URL was empty (real OOPIF case)', async () => {
    const { mod, listeners } = await setup();
    // OOPIF attaches BEFORE its document navigates → targetInfo.url is '' (the real juejin bug).
    await emitFrom(listeners, { tabId: 1 }, 'Target.attachedToTarget', {
      sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'T1', url: '' },
    });
    // top-level dashboard noise (no sessionId) + iframe request (child session S1)
    await emitFrom(listeners, { tabId: 1 }, 'Network.requestWillBeSent', {
      requestId: 'top1', type: 'XHR', request: { url: 'http://127.0.0.1:19826/recorder/health', method: 'GET', headers: {} },
    });
    await emitFrom(listeners, { tabId: 1, sessionId: 'S1' }, 'Network.requestWillBeSent', {
      requestId: 'if1', type: 'XHR', request: { url: 'https://juejin.cn/api/list', method: 'GET', headers: {} },
    });
    // URL never resolved, but the iframe session exists → keep iframe entries, drop top-level noise.
    const entries = await mod.readNetworkCapture(1, { targetFrameUrl: 'https://juejin.cn/' });
    expect(entries.map((e) => e.url)).toEqual(['https://juejin.cn/api/list']);
  });

  it('backfills frameUrl from Target.targetInfoChanged so exact match works post-navigation', async () => {
    const { mod, listeners } = await setup();
    await emitFrom(listeners, { tabId: 1 }, 'Target.attachedToTarget', {
      sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'T1', url: '' },
    });
    // doc lands → Chrome emits targetInfoChanged with the real URL on the child session.
    await emitFrom(listeners, { tabId: 1, sessionId: 'S1' }, 'Target.targetInfoChanged', {
      targetInfo: { type: 'iframe', targetId: 'T1', url: 'https://juejin.cn/search' },
    });
    await emitFrom(listeners, { tabId: 1, sessionId: 'S1' }, 'Network.requestWillBeSent', {
      requestId: 'if1', type: 'XHR', request: { url: 'https://juejin.cn/api/x', method: 'GET', headers: {} },
    });
    const entries = await mod.readNetworkCapture(1, { targetFrameUrl: 'https://juejin.cn/search' });
    expect(entries.map((e) => e.url)).toEqual(['https://juejin.cn/api/x']);
  });
});
