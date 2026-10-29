import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { MockWebSocket } = vi.hoisted(() => {
  class MockWebSocket {
    static OPEN = 1;
    static instances: MockWebSocket[] = [];
    readyState = 1;
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(_url: string) {
      MockWebSocket.instances.push(this);
      queueMicrotask(() => this.emit('open'));
    }

    on(event: string, handler: (...args: unknown[]) => void): void {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    }

    send(_message: string): void {}

    close(): void {
      this.readyState = 3;
    }

    private emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  }

  return { MockWebSocket };
});

vi.mock('ws', () => ({
  WebSocket: MockWebSocket,
}));

import { CDPBridge } from './cdp.js';

describe('direct CDP screenshot DPR', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([undefined, 1, 2, 4])('captures at DPR %s and clears explicit overrides', async (dpr) => {
    vi.stubEnv('BYCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');
    const bridge = new CDPBridge();
    const send = vi.spyOn(bridge, 'send').mockResolvedValue({ data: 'BASE64' });
    try {
      const page = await bridge.connect();
      send.mockClear();
      expect(await page.screenshot({ dpr })).toBe('BASE64');
      if (dpr === undefined) {
        expect(send).not.toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', expect.anything());
        expect(send).not.toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride');
      } else {
        expect(send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
          mobile: false, width: 0, height: 0, deviceScaleFactor: dpr,
        });
        expect(send).toHaveBeenLastCalledWith('Emulation.clearDeviceMetricsOverride');
      }
    } finally {
      await bridge.close();
    }
  });
});

describe('direct CDP scoped dialogs', () => {
  it('bounds renderer initialization as well as the initial socket connection', async () => {
    vi.stubEnv('BYCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1'); vi.useFakeTimers();
    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockImplementation(() => new Promise(() => {}));
    try {
      const connected = bridge.connect({ timeout: 1 });
      const rejected = expect(connected).rejects.toThrow('existing browser dialog');
      await vi.advanceTimersByTimeAsync(1000); await rejected;
    } finally { await bridge.close(); vi.useRealTimers(); }
  });
  it('accepts ordinary dialogs only during the same-origin scope and releases listeners', async () => {
    vi.stubEnv('BYCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');
    const bridge = new CDPBridge(), send = vi.spyOn(bridge, 'send').mockResolvedValue({});
    const page = await bridge.connect();
    const handlers = new Map<string, (params: unknown) => void>();
    vi.spyOn(bridge, 'on').mockImplementation((name, fn) => { handlers.set(name, fn); });
    vi.spyOn(bridge, 'off').mockImplementation((name) => { handlers.delete(name); });
    send.mockClear();
    await page.withAcceptedDialogs!('https://channels.weixin.qq.com', async () => {
      for (const type of ['alert', 'confirm', 'beforeunload']) {
        handlers.get('Page.javascriptDialogOpening')!({ type, url: 'https://channels.weixin.qq.com/platform/post/create' });
        handlers.get('Page.javascriptDialogOpening')!({ type, url: 'https://channels.weixin.qq.com/platform/post/create' });
        handlers.get('Page.javascriptDialogClosed')!({});
      }
    });
    expect(send.mock.calls.filter(([method]) => method === 'Page.handleJavaScriptDialog')).toHaveLength(3);
    expect(handlers.size).toBe(0);
    bridge.close();
  });
  it.each([{ type: 'prompt', url: 'https://channels.weixin.qq.com' }, { type: 'confirm', url: 'https://other.example' }])('never accepts %j and stops subsequent actions', async detail => {
    vi.stubEnv('BYCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');
    const bridge = new CDPBridge(), send = vi.spyOn(bridge, 'send').mockResolvedValue({});
    const page = await bridge.connect(); let onDialog: ((params: unknown) => void) | undefined;
    vi.spyOn(bridge, 'on').mockImplementation((name, fn) => { if (name === 'Page.javascriptDialogOpening') onDialog = fn; });
    send.mockClear();
    await expect(page.withAcceptedDialogs!('https://channels.weixin.qq.com', async () => {
      onDialog!(detail);
      await page.nativeType!('must not type');
    })).rejects.toThrow('manual input or belongs to another origin');
    expect(send).toHaveBeenCalledTimes(1); // Page.enable only.
    bridge.close();
  });
});

describe('CDPBridge cookies', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('filters cookies by actual domain match instead of substring match', async () => {
    vi.stubEnv('BYCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockResolvedValue({
      cookies: [
        { name: 'good', value: '1', domain: '.example.com' },
        { name: 'exact', value: '2', domain: 'example.com' },
        { name: 'bad', value: '3', domain: 'notexample.com' },
      ],
    });

    const page = await bridge.connect();
    const cookies = await page.getCookies({ domain: 'example.com' });

    expect(cookies).toEqual([
      { name: 'good', value: '1', domain: '.example.com' },
      { name: 'exact', value: '2', domain: 'example.com' },
    ]);
  });

  it('exposes native input helpers on direct CDP pages', async () => {
    vi.stubEnv('BYCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    const bridge = new CDPBridge();
    const send = vi.spyOn(bridge, 'send').mockResolvedValue({});

    const page = await bridge.connect();
    send.mockClear();

    expect(page.nativeType).toBeTypeOf('function');
    expect(page.nativeKeyPress).toBeTypeOf('function');
    expect(page.nativeClick).toBeTypeOf('function');
    expect(page.handleJavaScriptDialog).toBeTypeOf('function');
    expect(page.cdp).toBeTypeOf('function');

    await page.nativeType!('hello');
    await page.nativeKeyPress!('a', ['Ctrl']);
    await page.nativeClick!(10, 20);
    await page.handleJavaScriptDialog!(true, 'ok');
    await page.cdp!('Page.getLayoutMetrics', {});

    expect(send.mock.calls).toEqual([
      ['Input.insertText', { text: 'hello' }],
      ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2 }],
      ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers: 2 }],
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 20 }],
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 20, button: 'left', clickCount: 1 }],
      ['Page.handleJavaScriptDialog', { accept: true, promptText: 'ok' }],
      ['Page.getLayoutMetrics', {}],
    ]);
  });

  it('brings the direct CDP page to the foreground', async () => {
    vi.stubEnv('BYCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    const bridge = new CDPBridge();
    const send = vi.spyOn(bridge, 'send').mockResolvedValue({});

    const page = await bridge.connect();
    send.mockClear();

    await page.focusWindow?.();

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('Page.bringToFront');
  });
});

describe('CDP console capture', () => {
  it.each(['explicit-empty', 'explicit-cached', 'remote-empty', 'remote-cached'])('rejects console reads after %s disconnection', async (mode) => {
    vi.stubEnv('BYCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/console-disconnected');
    const bridge = new CDPBridge();
    const handlers = new Map<string, (params: unknown) => void>();
    vi.spyOn(bridge, 'on').mockImplementation((name, fn) => { handlers.set(name, fn); });
    vi.spyOn(bridge, 'send').mockResolvedValue({});
    try {
      const page = await bridge.connect();
      if (mode.endsWith('cached')) {
        handlers.get('Runtime.consoleAPICalled')?.({ type: 'log', args: [{ value: 'cached' }], timestamp: 1700000000000 });
        expect(await page.consoleMessages()).toHaveLength(1);
      }
      if (mode.startsWith('explicit')) await bridge.close();
      else MockWebSocket.instances.at(-1)!.close();
      await expect(page.consoleMessages()).rejects.toThrow(/CDP connection is not open/);
    } finally { await bridge.close(); vi.unstubAllEnvs(); }
  });
  it('captures replay at enable before the first read and preserves same-millisecond events', async () => {
    vi.stubEnv('BYCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/console');
    const bridge = new CDPBridge();
    const handlers = new Map<string, (params: unknown) => void>();
    vi.spyOn(bridge, 'on').mockImplementation((name, fn) => { handlers.set(name, fn); });
    vi.spyOn(bridge, 'send').mockImplementation(async (method) => {
      if (method === 'Runtime.enable') {
        handlers.get('Runtime.consoleAPICalled')?.({ type: 'warning', timestamp: 1700000000000, args: [{ value: 'early' }] });
        handlers.get('Runtime.exceptionThrown')?.({ timestamp: 1700000000000, exceptionDetails: { exception: { description: 'Error: boom' } } });
      }
      return {};
    });
    const page = await bridge.connect();
    const messages = await page.consoleMessages('error');
    expect(messages).toMatchObject([{ type: 'warning', text: 'early', timestamp: 1700000000000 }, { type: 'error', text: 'Error: boom' }]);
    expect(messages[0].id).not.toBe(messages[1].id);
    expect(await page.consoleMessages('all')).toEqual(messages);
    expect(await page.consoleMessages('warning')).toEqual([messages[0]]);
    await bridge.close();
    vi.unstubAllEnvs();
  });
});


describe('direct CDP single-attempt cover capabilities', () => {
  const bridges: CDPBridge[] = [];
  beforeEach(() => vi.stubEnv('BYCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/cover'));
  afterEach(async () => { for (const bridge of bridges.splice(0)) await bridge.close(); vi.unstubAllEnvs(); });
  async function setup() {
    const bridge = new CDPBridge(); bridges.push(bridge);
    const send = vi.spyOn(bridge, 'send').mockResolvedValue({});
    const page = await bridge.connect(); send.mockClear(); return { send, page };
  }
  it('exposes single-attempt evaluation and propagates a destroyed context without replay', async () => {
    const { send, page } = await setup();
    send.mockRejectedValueOnce(new Error('Execution context was destroyed'));
    await expect(page.evaluateOnce!('document.title')).rejects.toThrow('Execution context was destroyed');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({ returnByValue: true, awaitPromise: true }));
  });
  it('returns the evaluation result and propagates page exceptions', async () => {
    const { send, page } = await setup();
    send.mockResolvedValueOnce({ result: { value: { reserved: true } } });
    expect(await page.evaluateOnce!('({ reserved: true })')).toEqual({ reserved: true });
    send.mockResolvedValueOnce({ exceptionDetails: { exception: { description: 'reservation failed' } } });
    await expect(page.evaluateOnce!('throw new Error()')).rejects.toThrow('reservation failed');
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('sends one mouse gesture with a release and no transport retries', async () => {
    const { send, page } = await setup();
    await page.nativeClickOnce!(100, 200);
    expect(send.mock.calls.map(([, p]) => p?.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    for (const [method, params] of send.mock.calls) {
      expect(method).toBe('Input.dispatchMouseEvent'); expect(params).toMatchObject({ x: 100, y: 200 });
    }
    expect(send.mock.calls[2][1]).toMatchObject({ button: 'left', buttons: 0 });
  });
  it.each([0, 1, 2])('does not replay an uncertain gesture at step %s', async step => {
    const { send, page } = await setup();
    for (let n = 0; n < step; n++) send.mockResolvedValueOnce({});
    send.mockRejectedValueOnce(new Error('response lost'));
    await expect(page.nativeClickOnce!(100, 200)).rejects.toThrow('response lost');
    expect(send.mock.calls.map(([, p]) => p?.type)).toEqual(step === 0 ? ['mouseMoved'] : ['mouseMoved', 'mousePressed', 'mouseReleased']);
  });
  it.each([[NaN, 1], [-1, 1], [1, Infinity]])('rejects invalid click coordinates %s/%s before dispatch', async (x, y) => {
    const { send, page } = await setup();
    await expect(page.nativeClickOnce!(x, y)).rejects.toThrow('coordinates'); expect(send).not.toHaveBeenCalled();
  });
});
