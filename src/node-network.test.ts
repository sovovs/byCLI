import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';

import {
  createPinnedDispatcher,
  decideProxy,
  fetchWithNodeNetwork,
  hasProxyEnv,
} from './node-network.js';

describe('node network proxy decisions', () => {
  it('detects common proxy env variables', () => {
    expect(hasProxyEnv({ https_proxy: 'http://127.0.0.1:7897' })).toBe(true);
    expect(hasProxyEnv({ HTTP_PROXY: 'http://proxy.example:8080' })).toBe(true);
    expect(hasProxyEnv({})).toBe(false);
  });

  it('routes external https traffic through https_proxy', () => {
    const decision = decideProxy(
      new URL('https://www.v2ex.com/api/topics/latest.json'),
      { https_proxy: 'http://127.0.0.1:7897' },
    );

    expect(decision).toEqual({
      mode: 'proxy',
      proxyUrl: 'http://127.0.0.1:7897',
    });
  });

  it('falls back to HTTP_PROXY for https traffic when HTTPS_PROXY is absent', () => {
    const decision = decideProxy(
      new URL('https://www.v2ex.com/api/topics/latest.json'),
      { HTTP_PROXY: 'http://127.0.0.1:7897' },
    );

    expect(decision).toEqual({
      mode: 'proxy',
      proxyUrl: 'http://127.0.0.1:7897',
    });
  });

  it('bypasses proxies for loopback addresses', () => {
    const env = { https_proxy: 'http://127.0.0.1:7897', http_proxy: 'http://127.0.0.1:7897' };

    expect(decideProxy(new URL('http://127.0.0.1:19825/status'), env)).toEqual({ mode: 'direct' });
    expect(decideProxy(new URL('http://localhost:19825/status'), env)).toEqual({ mode: 'direct' });
    expect(decideProxy(new URL('http://[::1]:19825/status'), env)).toEqual({ mode: 'direct' });
  });

  it('honors NO_PROXY domain matches', () => {
    const decision = decideProxy(
      new URL('https://api.example.com/v1/items'),
      {
        https_proxy: 'http://127.0.0.1:7897',
        no_proxy: '.example.com',
      },
    );

    expect(decision).toEqual({ mode: 'direct' });
  });

  it('supports wildcard-style NO_PROXY subdomain entries', () => {
    const decision = decideProxy(
      new URL('https://api.example.com/v1/items'),
      {
        https_proxy: 'http://127.0.0.1:7897',
        no_proxy: '*.example.com',
      },
    );

    expect(decision).toEqual({ mode: 'direct' });
  });

  it('matches NO_PROXY entries that rely on the default URL port', () => {
    const env = { https_proxy: 'http://127.0.0.1:7897', http_proxy: 'http://127.0.0.1:7897' };

    expect(decideProxy(
      new URL('https://example.com/'),
      { ...env, NO_PROXY: 'example.com:443' },
    )).toEqual({ mode: 'direct' });

    expect(decideProxy(
      new URL('http://example.com/health'),
      { ...env, NO_PROXY: 'example.com:80' },
    )).toEqual({ mode: 'direct' });
  });

  it('falls back to ALL_PROXY when protocol-specific settings are absent', () => {
    const decision = decideProxy(
      new URL('http://example.net/data'),
      { ALL_PROXY: 'socks5://127.0.0.1:1080' },
    );

    expect(decision).toEqual({
      mode: 'proxy',
      proxyUrl: 'socks5://127.0.0.1:1080',
    });
  });

  it('preserves a caller-supplied pinned dispatcher when proxy variables are set', async () => {
    const server = createServer((_request, response) => response.end('pinned'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const dispatcher = createPinnedDispatcher([{ address: '127.0.0.1', family: 4 }]);
    const proxyKeys = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'no_proxy', 'NO_PROXY'];
    const previous = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
    try {
      for (const key of proxyKeys) delete process.env[key];
      process.env.http_proxy = 'http://127.0.0.1:1';
      const port = (server.address() as { port: number }).port;
      const response = await fetchWithNodeNetwork(`http://pinned.invalid:${port}/image`, {
        dispatcher,
      } as RequestInit & { dispatcher: ReturnType<typeof createPinnedDispatcher> });

      expect(await response.text()).toBe('pinned');
    } finally {
      await dispatcher.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const key of proxyKeys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});
