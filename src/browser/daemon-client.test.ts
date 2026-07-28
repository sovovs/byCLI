import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BrowserCommandError,
  fetchDaemonStatus,
  getDaemonHealth,
  requestDaemonShutdown,
  sendCommand,
} from './daemon-client.js';
import * as daemonClientModule from './daemon-client.js';

type DetailedProbe = (opts?: { timeout?: number }) => Promise<
  | { kind: 'status'; status: unknown }
  | { kind: 'stopped' }
  | { kind: 'timeout' }
  | { kind: 'http_error'; statusCode: number }
  | { kind: 'invalid_response' }
  | { kind: 'config_error' }
  | { kind: 'network_error' }
>;

const probeDaemonStatus = (
  daemonClientModule as unknown as { probeDaemonStatus?: DetailedProbe }
).probeDaemonStatus;

describe('daemon-client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('fetchDaemonStatus sends the shared status request and returns parsed data', async () => {
    const status = {
      ok: true,
      pid: 123,
      uptime: 10,
      extensionConnected: true,
      extensionVersion: '1.2.3',
      pending: 0,
      memoryMB: 32,
      port: 19825,
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(status),
    } as Response);

    await expect(fetchDaemonStatus()).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/status$/),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-byCLI': '1' }),
      }),
    );
  });

  it('exports a detailed passive daemon status probe', () => {
    expect(probeDaemonStatus).toBeTypeOf('function');
  });

  it('classifies a valid daemon status response', async () => {
    if (!probeDaemonStatus) return;
    const status = {
      ok: true,
      pid: 123,
      uptime: 10,
      extensionConnected: false,
      pending: 0,
      memoryMB: 16,
      port: 19825,
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(status),
    } as Response);

    await expect(probeDaemonStatus()).resolves.toEqual({ kind: 'status', status });
  });

  it('classifies a refused loopback connection as stopped', async () => {
    if (!probeDaemonStatus) return;
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    vi.mocked(fetch).mockRejectedValue(error);

    await expect(probeDaemonStatus()).resolves.toEqual({ kind: 'stopped' });
  });

  it('classifies an aborted status request as timeout', async () => {
    if (!probeDaemonStatus) return;
    vi.mocked(fetch).mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    await expect(probeDaemonStatus()).resolves.toEqual({ kind: 'timeout' });
  });

  it('keeps the timeout active while consuming the response body', async () => {
    if (!probeDaemonStatus) return;
    vi.mocked(fetch).mockImplementation(async (_input, init) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }),
    }) as Response);

    await expect(probeDaemonStatus({ timeout: 1 })).resolves.toEqual({ kind: 'timeout' });
  });

  it('rejects an invalid daemon port without issuing a request', async () => {
    if (!probeDaemonStatus) return;
    vi.stubEnv('BYCLI_DAEMON_PORT', '19825-invalid');

    await expect(probeDaemonStatus()).resolves.toEqual({ kind: 'config_error' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the HTTP status for an unsuccessful response', async () => {
    if (!probeDaemonStatus) return;
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);

    await expect(probeDaemonStatus()).resolves.toEqual({ kind: 'http_error', statusCode: 503 });
  });

  it('classifies invalid daemon JSON without exposing the payload', async () => {
    if (!probeDaemonStatus) return;
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new SyntaxError('secret raw payload')),
    } as Response);

    await expect(probeDaemonStatus()).resolves.toEqual({ kind: 'invalid_response' });
  });

  it('classifies other network failures without exposing error details', async () => {
    if (!probeDaemonStatus) return;
    vi.mocked(fetch).mockRejectedValue(new Error('secret network detail'));

    await expect(probeDaemonStatus()).resolves.toEqual({ kind: 'network_error' });
  });

  it('fetchDaemonStatus returns null on network failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(fetchDaemonStatus()).resolves.toBeNull();
  });

  it('fetchDaemonStatus returns null for an HTTP 500 response', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as Response);

    await expect(fetchDaemonStatus()).resolves.toBeNull();
  });

  it('requestDaemonShutdown POSTs to the shared shutdown endpoint', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    await expect(requestDaemonShutdown()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/shutdown$/),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-byCLI': '1' }),
      }),
    );
  });

  it('getDaemonHealth returns stopped when daemon is not reachable', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(getDaemonHealth()).resolves.toEqual({ state: 'stopped', status: null });
  });

  it('getDaemonHealth returns no-extension when daemon is running but extension disconnected', async () => {
    const status = {
      ok: true,
      pid: 123,
      uptime: 10,
      extensionConnected: false,
      pending: 0,
      memoryMB: 16,
      port: 19825,
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(status),
    } as Response);

    await expect(getDaemonHealth()).resolves.toEqual({ state: 'no-extension', status });
  });

  it('getDaemonHealth returns ready when daemon and extension are both connected', async () => {
    const status = {
      ok: true,
      pid: 123,
      uptime: 10,
      extensionConnected: true,
      extensionVersion: '1.2.3',
      pending: 0,
      memoryMB: 32,
      port: 19825,
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(status),
    } as Response);

    await expect(getDaemonHealth()).resolves.toEqual({ state: 'ready', status });
  });

  it('getDaemonHealth returns profile-required when multiple profiles are connected without a selection', async () => {
    const status = {
      ok: true,
      pid: 123,
      uptime: 10,
      extensionConnected: false,
      profileRequired: true,
      profiles: [
        { contextId: 'work', extensionConnected: true, pending: 0 },
        { contextId: 'personal', extensionConnected: true, pending: 0 },
      ],
      pending: 0,
      memoryMB: 32,
      port: 19825,
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(status),
    } as Response);

    await expect(getDaemonHealth()).resolves.toEqual({ state: 'profile-required', status });
  });

  it('fetchDaemonStatus includes contextId in the status query', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        pid: 1,
        uptime: 0,
        extensionConnected: true,
        pending: 0,
        memoryMB: 1,
        port: 19825,
      }),
    } as Response);

    await fetchDaemonStatus({ contextId: 'work' });

    expect(vi.mocked(fetch).mock.calls[0][0]).toMatch(/\/status\?contextId=work$/);
  });

  it('sendCommand includes the current pid in generated command ids', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_763_000_000_000);
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ id: 'server', ok: true, data: 'ok' }),
    } as Response);

    await expect(sendCommand('exec', { code: '1 + 1' })).resolves.toBe('ok');
    await expect(sendCommand('exec', { code: '2 + 2' })).resolves.toBe('ok');

    const ids = vi.mocked(fetch).mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body)) as { id: string };
      return body.id;
    });

    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(new RegExp(`^cmd_${process.pid}_1763000000000_\\d+$`));
    expect(ids[1]).toMatch(new RegExp(`^cmd_${process.pid}_1763000000000_\\d+$`));
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('sendCommand forwards BYCLI_PROFILE as command contextId', async () => {
    vi.stubEnv('BYCLI_PROFILE', 'work');
    vi.spyOn(Date, 'now').mockReturnValue(1_763_000_000_000);
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ id: 'server', ok: true, data: 'ok' }),
    } as Response);

    await sendCommand('exec', { code: '1 + 1' });

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)) as { contextId?: string };
    expect(body.contextId).toBe('work');
  });

  it('sendCommand uses explicit windowMode before BYCLI_WINDOW env fallback', async () => {
    vi.stubEnv('BYCLI_WINDOW', 'foreground');
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ id: 'server', ok: true, data: 'ok' }),
    } as Response);

    await sendCommand('exec', { code: '1 + 1', windowMode: 'background' });

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)) as { windowMode?: string };
    expect(body.windowMode).toBe('background');
  });

  it('sendCommand retries with a new id when daemon reports a duplicate pending id', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_763_000_000_123);
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ ok: false, error: 'Duplicate command id already pending; retry' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'server', ok: true, data: 42 }),
      } as Response);

    await expect(sendCommand('exec', { code: '6 * 7' })).resolves.toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const ids = fetchMock.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body)) as { id: string };
      return body.id;
    });
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('sendCommand does not retry command_result_unknown even when the message looks transient', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({
        id: 'server',
        ok: false,
        errorCode: 'command_result_unknown',
        error: 'Extension disconnected after command timeout',
        errorHint: 'Inspect state before retrying.',
      }),
    } as Response);

    await expect(sendCommand('exec', { code: 'window.__mutate = true' })).rejects.toMatchObject({
      name: 'BrowserCommandError',
      code: 'command_result_unknown',
      hint: 'Inspect state before retrying.',
    } satisfies Partial<BrowserCommandError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a missing extension capability once without duplicate-id retries', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 412,
      json: () => Promise.resolve({
        id: 'server',
        ok: false,
        errorCode: 'extension_capability_missing',
        error: 'Connected Browser Bridge does not advertise focus-window-v1.',
        errorHint: 'Update and reload the byCLI Browser Bridge extension, then retry the login flow.',
      }),
    } as Response);

    await expect(sendCommand('tabs', { op: 'focus' })).rejects.toMatchObject({
      name: 'BrowserCommandError',
      code: 'extension_capability_missing',
      hint: expect.stringMatching(/update.*reload/i),
    } satisfies Partial<BrowserCommandError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
