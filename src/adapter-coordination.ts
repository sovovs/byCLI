import {
  acquireAdapterLease,
  heartbeatAdapterLease,
  releaseAdapterLease,
  acquireAdapterResources,
  releaseAdapterResources,
} from './browser/daemon-client.js';
import type {
  AdapterLease,
  AdapterLeaseRelease,
  AdapterLeaseRequest,
  AdapterReleaseReason,
  AdapterResourceGrant,
} from './adapter-scheduler.js';
import { log } from './logger.js';
import { AdapterCoordinationError } from './errors.js';
import {
  getAdapterExecutionContext,
  runWithAdapterExecutionContext,
  type AdapterExecutionContext,
} from './adapter-execution-context.js';

export interface AdapterCoordinationDependencies {
  acquire?: (request: AdapterLeaseRequest) => Promise<AdapterLease>;
  heartbeat?: (lease: AdapterLease) => Promise<AdapterLease>;
  release?: (release: AdapterLeaseRelease) => Promise<boolean>;
  heartbeatIntervalMs?: number;
  onLeaseLost?: () => Promise<void>;
  warn?: (message: string) => void;
}

export function getCurrentAdapterLease(): AdapterLease | undefined {
  return getAdapterExecutionContext()?.lease;
}

/**
 * Renew the active lease immediately before an irreversible local publication.
 * A restarted daemon or reclaimed lease rejects this fencing check.
 */
export async function assertCurrentAdapterLease(
  dependencies: { heartbeat?: (lease: AdapterLease) => Promise<AdapterLease> } = {},
): Promise<void> {
  const context = getAdapterExecutionContext();
  if (!context) return;
  try {
    context.lease = await (dependencies.heartbeat ?? heartbeatAdapterLease)(context.lease);
  } catch (error) {
    if (error instanceof AdapterCoordinationError && error.code === 'ADAPTER_LEASE_LOST') throw error;
    throw new AdapterCoordinationError(
      'ADAPTER_LEASE_LOST',
      'Adapter lease fencing failed before artifact publication.',
      true,
    );
  }
}

export interface AdapterResourceDependencies {
  acquire?: (lease: AdapterLease, keys: string[], timeoutMs: number) => Promise<AdapterResourceGrant>;
  release?: (lease: AdapterLease, grantId: string) => Promise<boolean>;
  timeoutMs?: number;
  warn?: (message: string) => void;
}

export async function settleAdapterOperationAfterTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: Error,
  stop: () => Promise<void>,
): Promise<T> {
  type Outcome = { kind: 'value'; value: T } | { kind: 'error'; error: unknown };
  const outcome: Promise<Outcome> = operation.then(
    value => ({ kind: 'value', value }),
    error => ({ kind: 'error', error }),
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    outcome,
    new Promise<{ kind: 'timeout' }>(resolve => {
      timeout = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    }),
  ]);

  if (first.kind !== 'timeout') {
    if (timeout) clearTimeout(timeout);
    if (first.kind === 'error') throw first.error;
    return first.value;
  }

  try {
    await stop();
  } finally {
    await outcome;
  }
  throw timeoutError;
}

export async function withAdapterResourceLocks<T>(
  keys: string[],
  operation: () => Promise<T>,
  dependencies: AdapterResourceDependencies = {},
): Promise<T> {
  const lease = getCurrentAdapterLease();
  if (!lease) return operation();
  const acquire = dependencies.acquire ?? acquireAdapterResources;
  const release = dependencies.release ?? releaseAdapterResources;
  const warn = dependencies.warn ?? ((message: string) => log.warn(message));
  const scopedKeys = keys.map(key => key.startsWith('article:') || key.startsWith('data:')
    ? `profile:${lease.contextId}:${key}`
    : key);
  const grant = await acquire(lease, scopedKeys, dependencies.timeoutMs ?? 300_000);
  try {
    return await operation();
  } finally {
    let released = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2 && !released; attempt++) {
      try {
        await release(lease, grant.grantId);
        released = true;
      } catch (error) {
        lastError = error;
      }
    }
    if (!released) {
      warn(`Adapter resource release acknowledgement failed for ${grant.grantId}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
  }
}

export async function withAdapterCommandLease<T>(
  request: AdapterLeaseRequest,
  operation: () => Promise<T>,
  dependencies: AdapterCoordinationDependencies = {},
): Promise<T> {
  const acquire = dependencies.acquire ?? acquireAdapterLease;
  const heartbeat = dependencies.heartbeat ?? heartbeatAdapterLease;
  const release = dependencies.release ?? releaseAdapterLease;
  const warn = dependencies.warn ?? ((message: string) => log.warn(message));
  const heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 10_000;
  const context: AdapterExecutionContext = { lease: await acquire(request) };
  let releaseReason: AdapterReleaseReason = 'error';
  let leaseLost: unknown;
  let stopAfterLeaseLoss: Promise<void> | undefined;
  let heartbeatTask: Promise<void> | undefined;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatTask || leaseLost) return;
    heartbeatTask = heartbeat(context.lease)
      .then(next => { context.lease = next; })
      .catch(error => {
        const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
        if (code === 'ADAPTER_LEASE_LOST') {
          leaseLost = error;
          stopAfterLeaseLoss = (dependencies.onLeaseLost?.() ?? Promise.resolve()).catch(stopError => {
            warn(`Adapter operation stop failed after lease loss for ${context.lease.requestId}: ${stopError instanceof Error ? stopError.message : String(stopError)}`);
          });
        } else {
          warn(`Adapter lease heartbeat failed for ${context.lease.requestId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
      .finally(() => { heartbeatTask = undefined; });
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  try {
    let result: T;
    try {
      result = await runWithAdapterExecutionContext(context, operation);
    } catch (error) {
      if (heartbeatTask) await heartbeatTask;
      if (stopAfterLeaseLoss) await stopAfterLeaseLoss;
      if (leaseLost) throw leaseLost;
      throw error;
    }
    if (heartbeatTask) await heartbeatTask;
    if (stopAfterLeaseLoss) await stopAfterLeaseLoss;
    if (leaseLost) throw leaseLost;
    releaseReason = classifyAdapterResult(result);
    return result;
  } catch (error) {
    releaseReason = classifyAdapterError(error);
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    const payload: AdapterLeaseRelease = { ...context.lease, reason: releaseReason };
    let released = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2 && !released; attempt++) {
      try {
        await release(payload);
        released = true;
      } catch (error) {
        lastError = error;
      }
    }
    if (!released) {
      warn(`Adapter lease release acknowledgement failed for ${payload.requestId}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
  }
}

function classifyAdapterError(error: unknown): AdapterReleaseReason {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : '';
  if (code === 'AUTH_REQUIRED' || /CAPTCHA|MFA|VERIFICATION/.test(code)) return 'auth_gate';
  if (code === 'RATE_LIMITED') return 'rate_limited';
  if (code === 'TIMEOUT') return 'timeout';
  return 'error';
}

function classifyAdapterResult(result: unknown): AdapterReleaseReason {
  const rows = Array.isArray(result) ? result : [result];
  const statuses = rows
    .filter(row => row && typeof row === 'object')
    .map(row => String((row as Record<string, unknown>).status ?? '').toLowerCase());
  if (statuses.some(status => /auth|login|captcha|verification|mfa/.test(status))) return 'auth_gate';
  if (statuses.some(status => /rate.?limit/.test(status))) return 'rate_limited';
  if (statuses.some(status => status === 'partial')) return 'partial';
  if (statuses.length > 0 && statuses.every(status => status.startsWith('failed') || status.startsWith('failure'))) return 'failed';
  return 'success';
}
