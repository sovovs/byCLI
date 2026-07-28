import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchDaemonStatusMock,
  probeDaemonStatusMock,
  requestDaemonShutdownMock,
  restartDaemonMock,
  loadProfileConfigMock,
} = vi.hoisted(() => ({
  fetchDaemonStatusMock: vi.fn(),
  probeDaemonStatusMock: vi.fn(),
  requestDaemonShutdownMock: vi.fn(),
  restartDaemonMock: vi.fn(),
  loadProfileConfigMock: vi.fn(() => ({ version: 1, aliases: { work: 'work-context' } })),
}));

vi.mock('../browser/daemon-client.js', () => ({
  fetchDaemonStatus: fetchDaemonStatusMock,
  probeDaemonStatus: probeDaemonStatusMock,
  requestDaemonShutdown: requestDaemonShutdownMock,
}));

vi.mock('../browser/daemon-lifecycle.js', () => ({
  restartDaemon: restartDaemonMock,
}));

vi.mock('../browser/profile.js', () => ({
  loadProfileConfig: loadProfileConfigMock,
}));

import { daemonRestart, daemonStatus, daemonStop } from './daemon.js';
import { PKG_VERSION } from '../version.js';

describe('daemonStatus', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    fetchDaemonStatusMock.mockReset();
    probeDaemonStatusMock.mockReset();
    requestDaemonShutdownMock.mockReset();
    loadProfileConfigMock.mockClear();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('reports "not running" when daemon is unreachable', async () => {
    fetchDaemonStatusMock.mockResolvedValue(null);

    await daemonStatus();

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
  });

  it('shows daemon info when running', async () => {
    fetchDaemonStatusMock.mockResolvedValue({
      ok: true,
      pid: 12345,
      uptime: 3661,
      daemonVersion: PKG_VERSION,
      extensionConnected: true,
      extensionVersion: '1.6.8',
      pending: 0,
      memoryMB: 64,
      port: 19825,
    });

    await daemonStatus();

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('running'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('PID 12345'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining(`v${PKG_VERSION}`));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('1h 1m'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('connected'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('v1.6.8'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('64 MB'));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('19825'));
  });

  it('shows disconnected when extension is not connected', async () => {
    fetchDaemonStatusMock.mockResolvedValue({
      ok: true,
      pid: 99,
      uptime: 120,
      daemonVersion: PKG_VERSION,
      extensionConnected: false,
      pending: 0,
      memoryMB: 32,
      port: 19825,
    });

    await daemonStatus();

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('disconnected'));
  });

  it('shows version unknown when the connected extension does not report one', async () => {
    fetchDaemonStatusMock.mockResolvedValue({
      ok: true,
      pid: 99,
      uptime: 120,
      daemonVersion: PKG_VERSION,
      extensionConnected: true,
      extensionVersion: undefined,
      pending: 0,
      memoryMB: 32,
      port: 19825,
    });

    await daemonStatus();

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('version unknown'));
  });

  it('prints exactly one JSON snapshot without starting the daemon', async () => {
    probeDaemonStatusMock.mockResolvedValue({ kind: 'stopped' });

    await daemonStatus({ json: true });

    expect(fetchDaemonStatusMock).not.toHaveBeenCalled();
    expect(probeDaemonStatusMock).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stdoutSpy.mock.calls[0][0]))).toMatchObject({
      schemaVersion: '1.0',
      command: 'daemon.status',
      ok: true,
      state: 'stopped',
    });
    expect(process.exitCode).toBe(0);
  });

  it('prints verbose details only when requested with JSON', async () => {
    probeDaemonStatusMock.mockResolvedValue({
      kind: 'status',
      status: {
        ok: true,
        pid: 12345,
        uptime: 61,
        daemonVersion: PKG_VERSION,
        extensionConnected: true,
        extensionVersion: '1.6.8',
        extensionCompatRange: '>=2.0.0 <3.0.0',
        profiles: [{ contextId: 'work-context', extensionConnected: true, extensionVersion: '1.6.8', pending: 0 }],
        contextId: 'work-context',
        pending: 0,
        memoryMB: 64,
        port: 19825,
      },
    });

    await daemonStatus({ json: true, verbose: true });

    expect(JSON.parse(String(stdoutSpy.mock.calls[0][0]))).toMatchObject({
      daemon: { pid: 12345, uptimeSeconds: 61, memoryMB: 64 },
      profiles: { items: [{ contextId: 'work-context', alias: 'work' }] },
    });
  });

  it('uses the timeout exit code for a timed-out JSON probe', async () => {
    probeDaemonStatusMock.mockResolvedValue({ kind: 'timeout' });

    await daemonStatus({ json: true });

    expect(JSON.parse(String(stdoutSpy.mock.calls[0][0]))).toMatchObject({
      ok: false,
      state: 'degraded',
      error: { code: 'daemon_status_timeout' },
    });
    expect(process.exitCode).toBe(75);
  });

  it('uses the configuration exit code for an invalid daemon configuration', async () => {
    probeDaemonStatusMock.mockResolvedValue({ kind: 'config_error' });

    await daemonStatus({ json: true });

    expect(JSON.parse(String(stdoutSpy.mock.calls[0][0]))).toMatchObject({
      ok: false,
      state: 'degraded',
      error: { code: 'invalid_daemon_config' },
    });
    expect(process.exitCode).toBe(78);
  });

  it('rejects --verbose without --json as command misuse', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await daemonStatus({ verbose: true });

    expect(stderrSpy).toHaveBeenCalledWith('Error: --verbose requires --json.');
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(probeDaemonStatusMock).not.toHaveBeenCalled();
    expect(fetchDaemonStatusMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it('emits a stable JSON usage error without probing the daemon', async () => {
    await daemonStatus({ json: true, usageError: 'Unsupported option: --bogus' });

    expect(JSON.parse(String(stdoutSpy.mock.calls[0][0]))).toMatchObject({
      ok: false,
      state: 'degraded',
      error: { code: 'invalid_arguments', message: 'Unsupported option: --bogus' },
    });
    expect(probeDaemonStatusMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });
});

describe('daemonStop', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fetchDaemonStatusMock.mockReset();
    requestDaemonShutdownMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports "not running" when daemon is unreachable', async () => {
    fetchDaemonStatusMock.mockResolvedValue(null);

    await daemonStop();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
  });

  it('sends shutdown and reports success', async () => {
    fetchDaemonStatusMock.mockResolvedValue({
      ok: true,
      pid: 12345,
      uptime: 100,
      daemonVersion: PKG_VERSION,
      extensionConnected: true,
      pending: 0,
      memoryMB: 50,
      port: 19825,
    });
    requestDaemonShutdownMock.mockResolvedValue(true);

    await daemonStop();

    expect(requestDaemonShutdownMock).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Daemon stopped'));
  });

  it('reports failure when shutdown request fails', async () => {
    fetchDaemonStatusMock.mockResolvedValue({
      ok: true,
      pid: 12345,
      uptime: 100,
      daemonVersion: PKG_VERSION,
      extensionConnected: true,
      pending: 0,
      memoryMB: 50,
      port: 19825,
    });
    requestDaemonShutdownMock.mockResolvedValue(false);

    await daemonStop();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to stop daemon'));
  });
});

describe('daemonRestart', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fetchDaemonStatusMock.mockReset();
    requestDaemonShutdownMock.mockReset();
    restartDaemonMock.mockReset();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('restarts a running daemon and reports the new version', async () => {
    fetchDaemonStatusMock.mockResolvedValue({
      ok: true,
      pid: 12345,
      uptime: 100,
      daemonVersion: '1.7.6',
      extensionConnected: true,
      profiles: [{ contextId: 'work', extensionConnected: true, pending: 0 }],
      pending: 0,
      memoryMB: 50,
      port: 19825,
    });
    restartDaemonMock.mockResolvedValue({
      previousStatus: { daemonVersion: '1.7.6' },
      stopped: true,
      spawned: true,
      status: {
        ok: true,
        pid: 12346,
        uptime: 1,
        daemonVersion: PKG_VERSION,
        extensionConnected: true,
        profiles: [{ contextId: 'work', extensionConnected: true, pending: 0 }],
        pending: 0,
        memoryMB: 51,
        port: 19825,
      },
    });

    await daemonRestart();

    expect(restartDaemonMock).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('will disconnect 1 browser profile'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining(`Daemon restarted on port 19825 (v${PKG_VERSION})`));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Extension connected; profiles connected: 1'));
  });

  it('starts a new daemon when none was running', async () => {
    fetchDaemonStatusMock.mockResolvedValue(null);
    restartDaemonMock.mockResolvedValue({
      previousStatus: null,
      stopped: true,
      spawned: true,
      status: {
        ok: true,
        pid: 12346,
        uptime: 1,
        daemonVersion: PKG_VERSION,
        extensionConnected: false,
        pending: 0,
        memoryMB: 51,
        port: 19825,
      },
    });

    await daemonRestart();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining(`Daemon started on port 19825 (v${PKG_VERSION})`));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('extension has not connected yet'));
  });

  it('reports failure when the daemon cannot stop', async () => {
    fetchDaemonStatusMock.mockResolvedValue({
      ok: true,
      pid: 12345,
      uptime: 100,
      daemonVersion: '1.7.6',
      extensionConnected: true,
      pending: 0,
      memoryMB: 50,
      port: 19825,
    });
    restartDaemonMock.mockResolvedValue({
      previousStatus: { daemonVersion: '1.7.6' },
      status: { daemonVersion: '1.7.6' },
      stopped: false,
      spawned: false,
    });

    await daemonRestart();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to stop daemon before restart'));
    expect(process.exitCode).toBe(1);
  });
});
