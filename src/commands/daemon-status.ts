import type {
  BrowserProfileStatus,
  DaemonStatus,
  DaemonStatusProbe,
} from '../browser/daemon-client.js';
import { isDaemonStale } from '../browser/daemon-version.js';
import { satisfiesRange } from '../plugin-manifest.js';

export const DAEMON_STATUS_SCHEMA_VERSION = '1.0' as const;

export type DaemonStatusState =
  | 'stopped'
  | 'daemon_stale'
  | 'extension_disconnected'
  | 'profile_required'
  | 'profile_disconnected'
  | 'ready'
  | 'degraded';

export interface DaemonStatusIssue {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  remediation?: {
    type: 'command';
    command: string[];
  };
}

export interface DaemonStatusReport {
  schemaVersion: typeof DAEMON_STATUS_SCHEMA_VERSION;
  command: 'daemon.status';
  ok: boolean;
  state: DaemonStatusState;
  cli: { version: string };
  daemon: {
    state: 'stopped' | 'running' | 'unknown';
    version: string | null;
    port: number;
    stale: boolean;
    pid?: number;
    uptimeSeconds?: number;
    memoryMB?: number;
  };
  extension: {
    state: 'unknown' | 'disconnected' | 'connected';
    version: string | null;
    compatibility: 'unknown' | 'compatible' | 'incompatible';
  };
  profiles: {
    connectedCount: number;
    selectionRequired: boolean;
    selectedContextId?: string | null;
    items?: Array<{
      contextId: string;
      alias?: string;
      selected: boolean;
      extensionVersion: string | null;
    }>;
  };
  issues: DaemonStatusIssue[];
  error?: { code: string; message: string };
}

export interface DaemonStatusReportOptions {
  cliVersion: string;
  port: number;
  verbose?: boolean;
  /** Profile aliases in the persisted alias -> contextId form. */
  profileAliases?: Record<string, string>;
}

function baseReport(options: DaemonStatusReportOptions): DaemonStatusReport {
  return {
    schemaVersion: DAEMON_STATUS_SCHEMA_VERSION,
    command: 'daemon.status',
    ok: true,
    state: 'stopped',
    cli: { version: options.cliVersion },
    daemon: { state: 'stopped', version: null, port: options.port, stale: false },
    extension: { state: 'unknown', version: null, compatibility: 'unknown' },
    profiles: { connectedCount: 0, selectionRequired: false },
    issues: [],
  };
}

function failureReport(
  options: DaemonStatusReportOptions,
  code: string,
  message: string,
): DaemonStatusReport {
  const result = baseReport(options);
  result.ok = false;
  result.state = 'degraded';
  result.daemon.state = 'unknown';
  result.error = { code, message };
  return result;
}

export function buildDaemonStatusErrorReport(
  options: DaemonStatusReportOptions,
  code: string,
  message: string,
): DaemonStatusReport {
  return failureReport(options, code, message);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isProfileStatus(value: unknown): value is BrowserProfileStatus {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<BrowserProfileStatus>;
  return typeof profile.contextId === 'string'
    && typeof profile.extensionConnected === 'boolean'
    && isFiniteNumber(profile.pending)
    && isOptionalString(profile.extensionVersion)
    && isOptionalString(profile.extensionCompatRange);
}

function isDaemonStatus(value: unknown): value is DaemonStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<DaemonStatus>;
  return status.ok === true
    && isFiniteNumber(status.pid)
    && isFiniteNumber(status.uptime)
    && typeof status.extensionConnected === 'boolean'
    && isFiniteNumber(status.pending)
    && isFiniteNumber(status.memoryMB)
    && isFiniteNumber(status.port)
    && isOptionalString(status.daemonVersion)
    && isOptionalString(status.extensionVersion)
    && isOptionalString(status.extensionCompatRange)
    && isOptionalString(status.contextId)
    && isOptionalBoolean(status.profileRequired)
    && isOptionalBoolean(status.profileDisconnected)
    && (status.profiles === undefined
      || (Array.isArray(status.profiles) && status.profiles.every(isProfileStatus)));
}

function compatibilityOf(status: DaemonStatus, cliVersion: string): 'unknown' | 'compatible' | 'incompatible' {
  if (!status.extensionConnected || !status.extensionVersion || !status.extensionCompatRange) {
    return 'unknown';
  }
  return satisfiesRange(cliVersion, status.extensionCompatRange) ? 'compatible' : 'incompatible';
}

function aliasForContextId(aliases: Record<string, string>, contextId: string): string | undefined {
  return Object.entries(aliases).find(([, id]) => id === contextId)?.[0];
}

function probeFailure(probe: Exclude<DaemonStatusProbe, { kind: 'status' | 'stopped' }>): {
  code: string;
  message: string;
} {
  switch (probe.kind) {
    case 'timeout':
      return { code: 'daemon_status_timeout', message: 'Timed out while requesting daemon status.' };
    case 'http_error':
      return { code: 'daemon_http_error', message: `Daemon status request failed with HTTP ${probe.statusCode}.` };
    case 'invalid_response':
      return { code: 'invalid_daemon_response', message: 'The daemon returned an invalid status response.' };
    case 'config_error':
      return { code: 'invalid_daemon_config', message: 'BYCLI_DAEMON_PORT must be an integer from 1 to 65535.' };
    case 'network_error':
      return { code: 'daemon_unreachable', message: 'The daemon status endpoint could not be reached.' };
  }
}

export function buildDaemonStatusReport(
  probe: DaemonStatusProbe,
  options: DaemonStatusReportOptions,
): DaemonStatusReport {
  if (probe.kind === 'stopped') return baseReport(options);
  if (probe.kind !== 'status') {
    const failure = probeFailure(probe);
    return failureReport(options, failure.code, failure.message);
  }
  if (!isDaemonStatus(probe.status)) {
    return failureReport(options, 'invalid_daemon_response', 'The daemon returned an invalid status response.');
  }

  const status = probe.status;
  const result = baseReport(options);
  const stale = isDaemonStale(status, options.cliVersion);
  const compatibility = compatibilityOf(status, options.cliVersion);
  const connectedProfiles = status.profiles?.filter((profile) => profile.extensionConnected) ?? [];

  result.daemon = {
    state: 'running',
    version: status.daemonVersion ?? null,
    port: status.port,
    stale,
    ...(options.verbose && {
      pid: status.pid,
      uptimeSeconds: status.uptime,
      memoryMB: status.memoryMB,
    }),
  };
  result.extension = {
    state: status.extensionConnected ? 'connected' : 'disconnected',
    version: status.extensionVersion ?? null,
    compatibility,
  };
  result.profiles = {
    connectedCount: connectedProfiles.length,
    selectionRequired: status.profileRequired === true,
    ...(options.verbose && {
      selectedContextId: status.contextId ?? null,
      items: (status.profiles ?? []).map((profile) => {
        const alias = aliasForContextId(options.profileAliases ?? {}, profile.contextId);
        return {
          contextId: profile.contextId,
          ...(alias !== undefined && { alias }),
          selected: profile.contextId === status.contextId,
          extensionVersion: profile.extensionVersion ?? null,
        };
      }),
    }),
  };

  if (stale) {
    result.issues.push({
      code: 'daemon_stale',
      severity: 'warning',
      message: 'The daemon version does not match the CLI version.',
      remediation: { type: 'command', command: ['bycli', 'daemon', 'restart'] },
    });
  }
  if (!status.extensionConnected) {
    result.issues.push({
      code: 'extension_disconnected',
      severity: 'warning',
      message: 'The Browser Bridge extension is not connected.',
    });
  } else if (!status.extensionVersion) {
    result.issues.push({
      code: 'extension_version_missing',
      severity: 'warning',
      message: 'The connected Browser Bridge extension did not report its version.',
    });
  }
  if (compatibility === 'incompatible') {
    result.issues.push({
      code: 'extension_incompatible',
      severity: 'warning',
      message: 'The CLI version is incompatible with the Browser Bridge extension.',
    });
  }
  if (status.profileRequired) {
    result.issues.push({
      code: 'profile_selection_required',
      severity: 'warning',
      message: 'Multiple Browser Bridge profiles are connected and no profile is selected.',
      remediation: { type: 'command', command: ['bycli', 'profile', 'list'] },
    });
  }
  if (status.profileDisconnected) {
    result.issues.push({
      code: 'selected_profile_disconnected',
      severity: 'warning',
      message: 'The selected Browser Bridge profile is disconnected.',
      remediation: { type: 'command', command: ['bycli', 'profile', 'list'] },
    });
  }

  if (stale) result.state = 'daemon_stale';
  else if (status.profileRequired) result.state = 'profile_required';
  else if (status.profileDisconnected) result.state = 'profile_disconnected';
  else if (!status.extensionConnected) result.state = 'extension_disconnected';
  else if (compatibility === 'incompatible') result.state = 'degraded';
  else result.state = 'ready';

  return result;
}
