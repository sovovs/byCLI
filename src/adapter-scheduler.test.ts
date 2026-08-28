import { describe, expect, it } from 'vitest';
import { AdapterScheduler, type AdapterLeaseRequest } from './adapter-scheduler.js';

function request(name: string, overrides: Partial<AdapterLeaseRequest> = {}): AdapterLeaseRequest {
  return {
    requestId: `request-${name}`,
    contextId: 'profile-a',
    surface: 'adapter',
    site: 'weixin',
    adapterSession: name,
    sessionKey: `site:weixin:${name}`,
    queueTimeoutMs: 300_000,
    maxParallel: 3,
    ...overrides,
  };
}

describe('AdapterScheduler', () => {
  it('grants three distinct sessions and queues the fourth until release', async () => {
    const scheduler = new AdapterScheduler();
    const leases = await Promise.all([
      scheduler.acquire(request('worker-a')),
      scheduler.acquire(request('worker-b')),
      scheduler.acquire(request('worker-c')),
    ]);
    let fourthGranted = false;
    const fourth = scheduler.acquire(request('worker-d')).then((lease) => {
      fourthGranted = true;
      return lease;
    });
    await Promise.resolve();

    expect(scheduler.snapshot()).toMatchObject({ running: 3, queued: 1 });
    expect(fourthGranted).toBe(false);

    scheduler.release({ ...leases[0], reason: 'success' });
    const fourthLease = await fourth;
    expect(fourthLease.adapterSession).toBe('worker-d');
    expect(scheduler.snapshot()).toMatchObject({ running: 3, queued: 0 });
  });

  it('serializes repeated commands in one Adapter session without blocking another session', async () => {
    const scheduler = new AdapterScheduler();
    const first = await scheduler.acquire(request('worker-a'));
    let secondGranted = false;
    const second = scheduler.acquire(request('worker-a', { requestId: 'request-worker-a-2' }))
      .then((lease) => {
        secondGranted = true;
        return lease;
      });
    const other = await scheduler.acquire(request('worker-b'));

    expect(other.adapterSession).toBe('worker-b');
    expect(secondGranted).toBe(false);
    scheduler.release({ ...first, reason: 'success' });
    expect((await second).requestId).toBe('request-worker-a-2');
  });

  it('honors the lowest declared pool limit for mixed commands', async () => {
    const scheduler = new AdapterScheduler();
    const first = await scheduler.acquire(request('worker-a', { maxParallel: 1 }));
    let secondGranted = false;
    const second = scheduler.acquire(request('worker-b', { maxParallel: 3 })).then((lease) => {
      secondGranted = true;
      return lease;
    });
    await Promise.resolve();

    expect(secondGranted).toBe(false);
    scheduler.release({ ...first, reason: 'success' });
    await expect(second).resolves.toMatchObject({ adapterSession: 'worker-b' });
  });

  it('rejects expired queued work before it operates a tab', async () => {
    let now = 1_000;
    const scheduler = new AdapterScheduler({ now: () => now });
    await Promise.all([
      scheduler.acquire(request('worker-a')),
      scheduler.acquire(request('worker-b')),
      scheduler.acquire(request('worker-c')),
    ]);
    const queued = scheduler.acquire(request('worker-d', { queueTimeoutMs: 50 }));
    now += 51;
    scheduler.sweepExpired();

    await expect(queued).rejects.toMatchObject({ code: 'ADAPTER_QUEUE_TIMEOUT' });
  });

  it('removes a cooperatively cancelled queued request', async () => {
    const scheduler = new AdapterScheduler();
    await Promise.all([
      scheduler.acquire(request('worker-a')),
      scheduler.acquire(request('worker-b')),
      scheduler.acquire(request('worker-c')),
    ]);
    const queued = scheduler.acquire(request('worker-d'));

    expect(scheduler.cancel('request-worker-d')).toBe(true);
    await expect(queued).rejects.toMatchObject({ code: 'ADAPTER_QUEUE_RESET' });
    expect(scheduler.snapshot()).toMatchObject({ queued: 0 });
  });

  it('reclaims a lease after heartbeat expiry and validates release identity', async () => {
    let now = 1_000;
    const scheduler = new AdapterScheduler({ now: () => now, leaseExpiryMs: 45_000 });
    const lease = await scheduler.acquire(request('worker-a'));

    expect(() => scheduler.release({ ...lease, leaseId: 'wrong', reason: 'success' }))
      .toThrowError(expect.objectContaining({ code: 'ADAPTER_LEASE_LOST' }));
    now += 45_001;
    scheduler.sweepExpired();
    expect(scheduler.snapshot()).toMatchObject({ running: 0 });
    expect(() => scheduler.heartbeat(lease)).toThrowError(expect.objectContaining({ code: 'ADAPTER_LEASE_LOST' }));
  });

  it('forgets old idempotent-release markers after a bounded retention window', async () => {
    let now = 1_000;
    const scheduler = new AdapterScheduler({ now: () => now, releasedLeaseRetentionMs: 50 });
    const lease = await scheduler.acquire(request('worker-a'));

    expect(scheduler.release({ ...lease, reason: 'success' })).toBe(true);
    expect(scheduler.release({ ...lease, reason: 'success' })).toBe(false);
    now += 51;
    scheduler.sweepExpired();
    expect(() => scheduler.release({ ...lease, reason: 'success' }))
      .toThrowError(expect.objectContaining({ code: 'ADAPTER_LEASE_LOST' }));
  });

  it('cancels queued work when auth gating closes the pool generation', async () => {
    const scheduler = new AdapterScheduler();
    const running = await Promise.all([
      scheduler.acquire(request('worker-a')),
      scheduler.acquire(request('worker-b')),
      scheduler.acquire(request('worker-c')),
    ]);
    const queued = scheduler.acquire(request('worker-d'));

    scheduler.release({ ...running[0], reason: 'auth_gate' });

    await expect(queued).rejects.toMatchObject({ code: 'ADAPTER_POOL_AUTH_GATE' });
  });

  it('serializes global resource claims across profiles and releases them with the lease', async () => {
    const scheduler = new AdapterScheduler();
    const first = await scheduler.acquire(request('worker-a'));
    const second = await scheduler.acquire(request('worker-b', { contextId: 'profile-b' }));
    const firstGrant = await scheduler.acquireResources(first, ['output:shared'], 5_000);
    let secondGranted = false;
    const secondGrant = scheduler.acquireResources(second, ['output:shared'], 5_000).then((grant) => {
      secondGranted = true;
      return grant;
    });
    await Promise.resolve();

    expect(secondGranted).toBe(false);
    scheduler.releaseResources(first, firstGrant.grantId);
    await expect(secondGrant).resolves.toMatchObject({ keys: ['output:shared'] });
  });

  it('times out a blocked resource claim without releasing the command lease', async () => {
    let now = 1_000;
    const scheduler = new AdapterScheduler({ now: () => now });
    const first = await scheduler.acquire(request('worker-a'));
    const second = await scheduler.acquire(request('worker-b'));
    await scheduler.acquireResources(first, ['article:same'], 5_000);
    const blocked = scheduler.acquireResources(second, ['article:same'], 50);
    now += 51;
    scheduler.sweepExpired();

    await expect(blocked).rejects.toMatchObject({ code: 'ADAPTER_RESOURCE_TIMEOUT' });
    expect(scheduler.snapshot()).toMatchObject({ running: 2 });
  });
});
