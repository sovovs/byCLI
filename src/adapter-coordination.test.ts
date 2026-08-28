import { describe, expect, it, vi } from 'vitest';
import type { AdapterLease, AdapterLeaseRequest } from './adapter-scheduler.js';
import {
  assertCurrentAdapterLease,
  getCurrentAdapterLease,
  settleAdapterOperationAfterTimeout,
  withAdapterCommandLease,
  withAdapterResourceLocks,
} from './adapter-coordination.js';

const request: AdapterLeaseRequest = {
  requestId: 'request-a', contextId: 'profile-a', surface: 'adapter', site: 'weixin',
  adapterSession: 'worker-a', sessionKey: 'site:weixin:worker-a', queueTimeoutMs: 300_000,
  maxParallel: 3,
};
const lease: AdapterLease = {
  ...request, leaseId: 'lease-a', poolKey: 'pool-a', generation: 1,
  grantedAt: 100, heartbeatDeadline: 45_100,
};

describe('withAdapterCommandLease', () => {
  it('acquires before execution and releases success after the terminal result', async () => {
    const events: string[] = [];
    const result = await withAdapterCommandLease(request, async () => {
      events.push('execute');
      return [{ status: 'success' }];
    }, {
      acquire: async () => { events.push('acquire'); return lease; },
      heartbeat: async current => current,
      release: async released => { events.push(`release:${released.reason}`); return true; },
      heartbeatIntervalMs: 60_000,
    });

    expect(result).toEqual([{ status: 'success' }]);
    expect(events).toEqual(['acquire', 'execute', 'release:success']);
  });

  it('releases typed failure outcomes without rerunning the operation', async () => {
    const release = vi.fn().mockResolvedValue(true);
    const operation = vi.fn().mockRejectedValue(Object.assign(new Error('login'), { code: 'AUTH_REQUIRED' }));

    await expect(withAdapterCommandLease(request, operation, {
      acquire: async () => lease,
      heartbeat: async current => current,
      release,
      heartbeatIntervalMs: 60_000,
    })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ reason: 'auth_gate' }));
  });

  it('classifies command-specific failed status text as a failed release', async () => {
    const release = vi.fn().mockResolvedValue(true);
    await withAdapterCommandLease(request, async () => [{ status: 'failed — no title' }], {
      acquire: async () => lease,
      heartbeat: async current => current,
      release,
      heartbeatIntervalMs: 60_000,
    });
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ reason: 'failed' }));
  });

  it('surfaces lease loss from heartbeat and never replays the operation', async () => {
    const events: string[] = [];
    let rejectOperation!: (error: Error) => void;
    const operation = vi.fn(() => new Promise((_resolve, reject) => { rejectOperation = reject; })
      .finally(() => { events.push('settled'); }));
    const lost = Object.assign(new Error('lost'), { code: 'ADAPTER_LEASE_LOST' });

    const running = withAdapterCommandLease(request, operation, {
      acquire: async () => lease,
      heartbeat: async () => { throw lost; },
      release: async () => { events.push('release'); return true; },
      heartbeatIntervalMs: 1,
      onLeaseLost: async () => {
        events.push('stop');
        rejectOperation(new Error('stopped'));
      },
    });

    await expect(running).rejects.toBe(lost);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['stop', 'settled', 'release']);
  });

  it('waits for the underlying operation to stop before reporting timeout', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let rejectOperation!: (error: Error) => void;
    const operation = new Promise<never>((_resolve, reject) => { rejectOperation = reject; })
      .finally(() => { events.push('settled'); });
    const timed = settleAdapterOperationAfterTimeout(operation, 10, new Error('timeout'), async () => {
      events.push('stop');
      rejectOperation(new Error('stopped'));
    });
    const assertion = expect(timed).rejects.toThrow('timeout');

    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(events).toEqual(['stop', 'settled']);
    vi.useRealTimers();
  });

  it('preserves a validated result when release acknowledgement fails', async () => {
    const warn = vi.fn();
    await expect(withAdapterCommandLease(request, async () => 'saved', {
      acquire: async () => lease,
      heartbeat: async current => current,
      release: async () => { throw new Error('daemon unavailable'); },
      heartbeatIntervalMs: 60_000,
      warn,
    })).resolves.toBe('saved');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('acquires runtime-scoped resource locks and releases them before the command lease', async () => {
    const events: string[] = [];
    const result = await withAdapterCommandLease(request, () => withAdapterResourceLocks(
      ['article:hash', 'output:hash'],
      async () => { events.push('operation'); return 'saved'; },
      {
        acquire: async (current, keys) => {
          events.push(`resources:${current.leaseId}:${keys.join(',')}`);
          return { grantId: 'grant-a', leaseId: current.leaseId, keys };
        },
        release: async () => { events.push('resources-release'); return true; },
        timeoutMs: 30_000,
      },
    ), {
      acquire: async () => lease,
      heartbeat: async current => current,
      release: async () => { events.push('lease-release'); return true; },
      heartbeatIntervalMs: 60_000,
    });

    expect(result).toBe('saved');
    expect(events).toEqual([
      'resources:lease-a:profile:profile-a:article:hash,output:hash',
      'operation',
      'resources-release',
      'lease-release',
    ]);
  });

  it('preserves a validated result when resource release acknowledgement fails', async () => {
    const warn = vi.fn();
    const result = await withAdapterCommandLease(request, () => withAdapterResourceLocks(
      ['output:hash'],
      async () => 'saved',
      {
        acquire: async current => ({ grantId: 'grant-a', leaseId: current.leaseId, keys: ['output:hash'] }),
        release: async () => { throw new Error('daemon unavailable'); },
        warn,
      },
    ), {
      acquire: async () => lease,
      heartbeat: async current => current,
      release: async () => true,
      heartbeatIntervalMs: 60_000,
    });

    expect(result).toBe('saved');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('renews the current lease as a fencing check before final publication', async () => {
    const heartbeat = vi.fn(async current => ({ ...current, heartbeatDeadline: 99_999 }));
    await withAdapterCommandLease(request, async () => {
      await assertCurrentAdapterLease({ heartbeat });
    }, {
      acquire: async () => lease,
      heartbeat: async current => current,
      release: async () => true,
      heartbeatIntervalMs: 60_000,
    });

    expect(heartbeat).toHaveBeenCalledWith(expect.objectContaining({ leaseId: 'lease-a' }));
    expect(getCurrentAdapterLease()).toBeUndefined();
  });
});
