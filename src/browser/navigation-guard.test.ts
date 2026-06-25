import { describe, it, expect, vi } from 'vitest';
import {
  armNavigationGuard,
  guardedNavigate,
  InterceptionUnavailableError,
  NavigationBlockedError,
  type InterceptBridge,
} from './navigation-guard.js';
import type { DnsResolver } from './url-policy.js';

function stubResolver(map: Record<string, { v4?: string[]; v6?: string[] }>): DnsResolver {
  return {
    async resolve4(h) { return map[h]?.v4 ?? []; },
    async resolve6(h) { return map[h]?.v6 ?? []; },
  };
}

/** Fake CDP bridge that records sends and lets tests fire events. */
function fakeBridge(opts: { failFetchEnable?: boolean } = {}) {
  const sends: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const bridge: InterceptBridge = {
    async send(method, params) {
      sends.push({ method, params });
      if (method === 'Fetch.enable' && opts.failFetchEnable) throw new Error('Fetch unsupported');
      return {};
    },
    on(event, handler) {
      let s = listeners.get(event);
      if (!s) { s = new Set(); listeners.set(event, s); }
      s.add(handler);
    },
    off(event, handler) { listeners.get(event)?.delete(handler); },
  };
  const emit = (event: string, params: unknown) => {
    for (const h of listeners.get(event) ?? []) h(params);
  };
  return { bridge, sends, emit, listeners };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('navigation-guard · armNavigationGuard', () => {
  it('enables Fetch on Document/Request stage', async () => {
    const { bridge, sends } = fakeBridge();
    const guard = await armNavigationGuard(bridge, stubResolver({}));
    const enable = sends.find((s) => s.method === 'Fetch.enable');
    expect(enable).toBeDefined();
    const pattern = (enable!.params!.patterns as Array<Record<string, unknown>>)[0];
    expect(pattern.resourceType).toBe('Document');
    expect(pattern.requestStage).toBe('Request');
    await guard.dispose();
  });

  it('fails closed when Fetch.enable throws', async () => {
    const { bridge } = fakeBridge({ failFetchEnable: true });
    await expect(armNavigationGuard(bridge, stubResolver({}))).rejects.toBeInstanceOf(InterceptionUnavailableError);
  });

  it('continues a main-frame request that passes policy', async () => {
    const { bridge, sends, emit } = fakeBridge();
    const guard = await armNavigationGuard(bridge, stubResolver({ 'good.com': { v4: ['93.184.216.34'] } }));
    emit('Fetch.requestPaused', { requestId: 'r1', resourceType: 'Document', request: { url: 'https://good.com/', method: 'GET' } });
    await flush();
    expect(sends.some((s) => s.method === 'Fetch.continueRequest' && s.params!.requestId === 'r1')).toBe(true);
    expect(guard.blocked).toHaveLength(0);
    await guard.dispose();
  });

  it('failRequest a redirected main-frame request to a forbidden target (0 bytes sent)', async () => {
    const { bridge, sends, emit } = fakeBridge();
    const guard = await armNavigationGuard(bridge, stubResolver({ 'good.com': { v4: ['93.184.216.34'] } }));
    // Redirect target resolves to loopback.
    emit('Fetch.requestPaused', { requestId: 'r2', resourceType: 'Document', request: { url: 'http://127.0.0.1/', method: 'GET' } });
    await flush();
    const fail = sends.find((s) => s.method === 'Fetch.failRequest' && s.params!.requestId === 'r2');
    expect(fail).toBeDefined();
    expect(fail!.params!.errorReason).toBe('BlockedByClient');
    expect(sends.some((s) => s.method === 'Fetch.continueRequest' && s.params!.requestId === 'r2')).toBe(false);
    expect(guard.blocked).toEqual([{ url: 'http://127.0.0.1/', reason: 'forbidden_ip' }]);
    await guard.dispose();
  });

  it('lets sub-resource requests through without policy', async () => {
    const { bridge, sends, emit } = fakeBridge();
    const guard = await armNavigationGuard(bridge, stubResolver({}));
    emit('Fetch.requestPaused', { requestId: 'img', resourceType: 'Image', request: { url: 'https://cdn.example/x.png', method: 'GET' } });
    await flush();
    expect(sends.some((s) => s.method === 'Fetch.continueRequest' && s.params!.requestId === 'img')).toBe(true);
    expect(guard.blocked).toHaveLength(0);
    await guard.dispose();
  });

  it('observes remoteIPAddress only when observeIp is set (logged, not a boundary)', async () => {
    const { bridge, emit } = fakeBridge();
    const guard = await armNavigationGuard(bridge, stubResolver({}), { observeIp: true });
    emit('Network.responseReceived', { response: { remoteIPAddress: '93.184.216.34' } });
    emit('Network.responseReceived', { response: {} }); // missing IP tolerated
    await flush();
    expect(guard.observedIps).toEqual(['93.184.216.34']);
    await guard.dispose();
  });
});

describe('navigation-guard · guardedNavigate', () => {
  it('pre-checks before navigating and arms interception first', async () => {
    const { bridge, sends } = fakeBridge();
    const order: string[] = [];
    const navigate = vi.fn(async () => { order.push('navigate'); });
    const guard = await guardedNavigate(bridge, 'https://good.com/', stubResolver({ 'good.com': { v4: ['93.184.216.34'] } }), navigate);
    // Fetch.enable must precede navigate.
    const enableIdx = sends.findIndex((s) => s.method === 'Fetch.enable');
    expect(enableIdx).toBeGreaterThanOrEqual(0);
    expect(navigate).toHaveBeenCalledOnce();
    await guard.dispose();
  });

  it('throws NavigationBlockedError without arming or navigating a known-bad target', async () => {
    const { bridge, sends } = fakeBridge();
    const navigate = vi.fn();
    await expect(
      guardedNavigate(bridge, 'http://169.254.169.254/', stubResolver({}), navigate, { allowLiteralIp: true }),
    ).rejects.toBeInstanceOf(NavigationBlockedError);
    expect(navigate).not.toHaveBeenCalled();
    expect(sends.some((s) => s.method === 'Fetch.enable')).toBe(false);
  });

  it('disposes the guard if navigate throws', async () => {
    const { bridge, sends } = fakeBridge();
    const navigate = vi.fn(async () => { throw new Error('nav failed'); });
    await expect(
      guardedNavigate(bridge, 'https://good.com/', stubResolver({ 'good.com': { v4: ['93.184.216.34'] } }), navigate),
    ).rejects.toThrow('nav failed');
    expect(sends.some((s) => s.method === 'Fetch.disable')).toBe(true);
  });
});
