import { afterEach, describe, expect, it, vi } from 'vitest';
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

function immediateScheduler(
  options: NonNullable<ConstructorParameters<typeof AdapterScheduler>[0]> = {},
): AdapterScheduler {
  return new AdapterScheduler({ ...options, startIntervalMs: 0 });
}

describe('AdapterScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('paces lease grants in one profile and site by the configured start interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const scheduler = new AdapterScheduler({ startIntervalMs: 5_000 });
    const first = scheduler.acquire(request('worker-a'));
    let secondGranted = false;
    let thirdGranted = false;
    const second = scheduler.acquire(request('worker-b')).then((lease) => {
      secondGranted = true;
      return lease;
    });
    const third = scheduler.acquire(request('worker-c')).then((lease) => {
      thirdGranted = true;
      return lease;
    });

    expect((await first).grantedAt).toBe(1_000);
    expect(secondGranted).toBe(false);
    expect(thirdGranted).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(secondGranted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await second).grantedAt).toBe(6_000);
    expect(thirdGranted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await third).grantedAt).toBe(11_000);
  });

  it('does not let an early release bypass the next start window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const scheduler = new AdapterScheduler({ startIntervalMs: 5_000, runtimeCeiling: 1 });
    const first = await scheduler.acquire(request('worker-a', { maxParallel: 1 }));
    let secondGranted = false;
    const second = scheduler.acquire(request('worker-b', { maxParallel: 1 })).then((lease) => {
      secondGranted = true;
      return lease;
    });

    await vi.advanceTimersByTimeAsync(2_000);
    scheduler.release({ ...first, reason: 'success' });
    expect(secondGranted).toBe(false);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(secondGranted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await second).grantedAt).toBe(6_000);
  });

  it('paces profiles and sites independently', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const scheduler = new AdapterScheduler({ startIntervalMs: 5_000 });

    const weixinProfileA = await scheduler.acquire(request('weixin-a'));
    const weixinProfileB = await scheduler.acquire(request('weixin-b', { contextId: 'profile-b' }));
    const otherSite = await scheduler.acquire(request('other-site', {
      site: 'toutiao',
      sessionKey: 'site:toutiao:other-site',
    }));

    expect(weixinProfileA.grantedAt).toBe(1_000);
    expect(weixinProfileB.grantedAt).toBe(1_000);
    expect(otherSite.grantedAt).toBe(1_000);
  });

  it('retains a drained pool until its next start window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const scheduler = new AdapterScheduler({ startIntervalMs: 5_000 });
    const first = await scheduler.acquire(request('worker-a'));
    scheduler.release({ ...first, reason: 'success' });
    let secondGranted = false;
    const second = scheduler.acquire(request('worker-b')).then((lease) => {
      secondGranted = true;
      return lease;
    });

    expect(secondGranted).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(secondGranted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await second).grantedAt).toBe(6_000);
  });

  it('lets queue timeout win before a paced start window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const scheduler = new AdapterScheduler({ startIntervalMs: 5_000 });
    await scheduler.acquire(request('worker-a'));
    const queued = scheduler.acquire(request('worker-b', { queueTimeoutMs: 1_000 }));
    const rejected = expect(queued).rejects.toMatchObject({ code: 'ADAPTER_QUEUE_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(scheduler.snapshot()).toMatchObject({ running: 1, queued: 0 });
  });

  it('rejects an expired request before a synchronous release can grant it', async () => {
    let now = 1_000;
    const scheduler = new AdapterScheduler({
      now: () => now,
      startIntervalMs: 5_000,
      runtimeCeiling: 1,
    });
    const first = await scheduler.acquire(request('worker-a', { maxParallel: 1 }));
    const queued = scheduler.acquire(request('worker-b', {
      maxParallel: 1,
      queueTimeoutMs: 1_000,
    })).then(
      () => 'granted',
      error => (error as { code?: string }).code,
    );

    now = 7_000;
    scheduler.release({ ...first, reason: 'success' });
    expect(await queued).toBe('ADAPTER_QUEUE_TIMEOUT');
  });

  it.each(['auth_gate', 'rate_limited'] as const)(
    'cancels a paced grant when %s closes the pool',
    async (reason) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const scheduler = new AdapterScheduler({ startIntervalMs: 5_000 });
    const first = await scheduler.acquire(request('worker-a'));
    const queued = scheduler.acquire(request('worker-b'));

    scheduler.release({ ...first, reason });
    await expect(queued).rejects.toMatchObject({
      code: reason === 'auth_gate' ? 'ADAPTER_POOL_AUTH_GATE' : 'ADAPTER_POOL_RATE_LIMITED',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(scheduler.snapshot()).toMatchObject({ running: 0, queued: 0 });
    },
  );

  it('grants immediately on release when the next start window is already open', async () => {
    let now = 1_000;
    const scheduler = new AdapterScheduler({
      now: () => now,
      startIntervalMs: 5_000,
      runtimeCeiling: 1,
    });
    const first = await scheduler.acquire(request('worker-a', { maxParallel: 1 }));
    const second = scheduler.acquire(request('worker-b', { maxParallel: 1 }));

    now = 7_000;
    scheduler.release({ ...first, reason: 'success' });
    expect((await second).grantedAt).toBe(7_000);
  });

  it('keeps one Adapter session serial after its start window opens', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const scheduler = new AdapterScheduler({ startIntervalMs: 5_000 });
    const first = await scheduler.acquire(request('worker-a'));
    let secondGranted = false;
    const second = scheduler.acquire(request('worker-a', { requestId: 'request-worker-a-2' }))
      .then((lease) => {
        secondGranted = true;
        return lease;
      });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(secondGranted).toBe(false);
    scheduler.release({ ...first, reason: 'success' });
    expect((await second).grantedAt).toBe(6_000);
  });

  it('clears paced scheduling when reset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const scheduler = new AdapterScheduler({ startIntervalMs: 5_000 });
    await scheduler.acquire(request('worker-a'));
    const queued = scheduler.acquire(request('worker-b'));

    scheduler.reset();
    await expect(queued).rejects.toMatchObject({ code: 'ADAPTER_QUEUE_RESET' });
    expect(scheduler.snapshot()).toEqual({ running: 0, queued: 0, pools: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an invalid start interval', () => {
    expect(() => new AdapterScheduler({ startIntervalMs: -1 })).toThrow(/start interval/i);
    expect(() => new AdapterScheduler({ startIntervalMs: 1.5 })).toThrow(/start interval/i);
  });

  it('grants three distinct sessions and queues the fourth until release', async () => {
    const scheduler = immediateScheduler();
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
    const scheduler = immediateScheduler();
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
    const scheduler = immediateScheduler();
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
    const scheduler = immediateScheduler({ now: () => now });
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
    const scheduler = immediateScheduler();
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
    const scheduler = immediateScheduler({ now: () => now, leaseExpiryMs: 45_000 });
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
    const scheduler = immediateScheduler({ now: () => now, releasedLeaseRetentionMs: 50 });
    const lease = await scheduler.acquire(request('worker-a'));

    expect(scheduler.release({ ...lease, reason: 'success' })).toBe(true);
    expect(scheduler.release({ ...lease, reason: 'success' })).toBe(false);
    now += 51;
    scheduler.sweepExpired();
    expect(() => scheduler.release({ ...lease, reason: 'success' }))
      .toThrowError(expect.objectContaining({ code: 'ADAPTER_LEASE_LOST' }));
  });

  it('cancels queued work when auth gating closes the pool generation', async () => {
    const scheduler = immediateScheduler();
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
    const scheduler = immediateScheduler();
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
    const scheduler = immediateScheduler({ now: () => now });
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
