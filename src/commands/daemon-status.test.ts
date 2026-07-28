import { describe, expect, it } from 'vitest';

import type { DaemonStatus, DaemonStatusProbe } from '../browser/daemon-client.js';
import { buildDaemonStatusReport } from './daemon-status.js';

const cliVersion = '2.1.12';
const port = 19825;

function runningStatus(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    ok: true,
    pid: 12345,
    uptime: 61,
    daemonVersion: cliVersion,
    extensionConnected: true,
    extensionVersion: '1.6.8',
    extensionCompatRange: '>=2.0.0 <3.0.0',
    profiles: [{
      contextId: 'work-context',
      extensionConnected: true,
      extensionVersion: '1.6.8',
      pending: 0,
    }],
    contextId: 'work-context',
    pending: 0,
    memoryMB: 64,
    port,
    ...overrides,
  };
}

function report(probe: DaemonStatusProbe, verbose = false) {
  return buildDaemonStatusReport(probe, {
    cliVersion,
    port,
    verbose,
    profileAliases: { work: 'work-context' },
  });
}

describe('buildDaemonStatusReport', () => {
  it('returns a stable cold-state snapshot when the daemon is stopped', () => {
    expect(report({ kind: 'stopped' })).toEqual({
      schemaVersion: '1.0',
      command: 'daemon.status',
      ok: true,
      state: 'stopped',
      cli: { version: cliVersion },
      daemon: { state: 'stopped', version: null, port, stale: false },
      extension: { state: 'unknown', version: null, compatibility: 'unknown' },
      profiles: { connectedCount: 0, selectionRequired: false },
      issues: [],
    });
  });

  it.each([
    ['daemon_stale', runningStatus({ daemonVersion: '2.1.11' })],
    ['extension_disconnected', runningStatus({ extensionConnected: false, extensionVersion: undefined, profiles: [] })],
    ['profile_required', runningStatus({ profileRequired: true, contextId: undefined })],
    ['profile_disconnected', runningStatus({ profileDisconnected: true })],
    ['ready', runningStatus()],
    ['degraded', runningStatus({ extensionCompatRange: '>=3.0.0' })],
  ] as const)('maps a valid daemon response to %s', (state, status) => {
    expect(report({ kind: 'status', status }).state).toBe(state);
  });

  it('keeps the default report free of process and profile identifiers', () => {
    const result = report({ kind: 'status', status: runningStatus() });
    const serialized = JSON.stringify(result);

    expect(result.daemon).toEqual({ state: 'running', version: cliVersion, port, stale: false });
    expect(result.profiles).toEqual({ connectedCount: 1, selectionRequired: false });
    expect(serialized).not.toContain('12345');
    expect(serialized).not.toContain('work-context');
    expect(serialized).not.toContain('"work"');
    expect(serialized).not.toContain('memoryMB');
    expect(serialized).not.toContain('uptimeSeconds');
  });

  it('adds approved process and profile details in verbose mode', () => {
    expect(report({ kind: 'status', status: runningStatus() }, true)).toMatchObject({
      daemon: { pid: 12345, uptimeSeconds: 61, memoryMB: 64 },
      profiles: {
        selectedContextId: 'work-context',
        items: [{
          contextId: 'work-context',
          alias: 'work',
          selected: true,
          extensionVersion: '1.6.8',
        }],
      },
    });
  });

  it.each([
    ['timeout', 'daemon_status_timeout'],
    ['http_error', 'daemon_http_error'],
    ['invalid_response', 'invalid_daemon_response'],
    ['config_error', 'invalid_daemon_config'],
    ['network_error', 'daemon_unreachable'],
  ] as const)('maps %s probe failures to a stable error envelope', (kind, errorCode) => {
    const probe: DaemonStatusProbe = kind === 'http_error'
      ? { kind, statusCode: 503 }
      : { kind };
    const result = report(probe);

    expect(result).toMatchObject({
      schemaVersion: '1.0',
      command: 'daemon.status',
      ok: false,
      state: 'degraded',
      daemon: { state: 'unknown', version: null, port, stale: false },
      extension: { state: 'unknown', version: null, compatibility: 'unknown' },
      profiles: { connectedCount: 0, selectionRequired: false },
      error: { code: errorCode },
    });
  });

  it('rejects a malformed successful response without exposing its raw payload', () => {
    const malformed = { ok: true, port: 'secret-value' } as unknown as DaemonStatus;
    const result = report({ kind: 'status', status: malformed });

    expect(result.ok).toBe(false);
    expect(result.state).toBe('degraded');
    expect(result.error?.code).toBe('invalid_daemon_response');
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('emits stable issues and command-array remediations', () => {
    const result = report({
      kind: 'status',
      status: runningStatus({ daemonVersion: '2.1.11' }),
    });

    expect(result.issues).toContainEqual({
      code: 'daemon_stale',
      severity: 'warning',
      message: 'The daemon version does not match the CLI version.',
      remediation: { type: 'command', command: ['bycli', 'daemon', 'restart'] },
    });
  });
});
