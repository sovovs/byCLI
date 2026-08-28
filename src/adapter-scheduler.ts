import * as crypto from 'node:crypto';

export type AdapterPoolCloseReason = 'auth_gate' | 'rate_limited';
export type AdapterReleaseReason =
  | 'success'
  | 'partial'
  | 'failed'
  | AdapterPoolCloseReason
  | 'timeout'
  | 'error'
  | 'cancelled';

export interface AdapterLeaseRequest {
  requestId: string;
  contextId: string;
  surface: 'adapter';
  site: string;
  adapterSession: string;
  sessionKey: string;
  queueTimeoutMs: number;
  maxParallel: number;
}

export interface AdapterLease {
  leaseId: string;
  requestId: string;
  poolKey: string;
  contextId: string;
  surface: 'adapter';
  site: string;
  adapterSession: string;
  sessionKey: string;
  generation: number;
  grantedAt: number;
  heartbeatDeadline: number;
}

export interface AdapterLeaseRelease extends AdapterLease {
  reason: AdapterReleaseReason;
}

export class AdapterSchedulerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AdapterSchedulerError';
  }
}

interface PendingRequest {
  request: AdapterLeaseRequest;
  enqueuedAt: number;
  deadline: number;
  sequence: number;
  resolve: (lease: AdapterLease) => void;
  reject: (error: AdapterSchedulerError) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface PoolState {
  key: string;
  generation: number;
  maxParallel: number;
  running: Map<string, AdapterLease>;
  activeSessions: Set<string>;
  queued: PendingRequest[];
  closed?: AdapterPoolCloseReason;
}

export interface AdapterResourceGrant {
  grantId: string;
  leaseId: string;
  keys: string[];
}

interface PendingResourceRequest {
  lease: AdapterLease;
  keys: string[];
  deadline: number;
  sequence: number;
  resolve: (grant: AdapterResourceGrant) => void;
  reject: (error: AdapterSchedulerError) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface AdapterSchedulerOptions {
  now?: () => number;
  leaseExpiryMs?: number;
  runtimeCeiling?: number;
  releasedLeaseRetentionMs?: number;
}

export class AdapterScheduler {
  private readonly now: () => number;
  private readonly leaseExpiryMs: number;
  private readonly runtimeCeiling: number;
  private readonly releasedLeaseRetentionMs: number;
  private readonly pools = new Map<string, PoolState>();
  private readonly releasedLeaseIds = new Map<string, number>();
  private readonly generations = new Map<string, number>();
  private readonly resourceOwners = new Map<string, { leaseId: string; grantId: string }>();
  private readonly resourceGrants = new Map<string, AdapterResourceGrant>();
  private readonly resourceQueue: PendingResourceRequest[] = [];
  private sequence = 0;

  constructor(options: AdapterSchedulerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.leaseExpiryMs = options.leaseExpiryMs ?? 45_000;
    this.runtimeCeiling = options.runtimeCeiling ?? 3;
    this.releasedLeaseRetentionMs = options.releasedLeaseRetentionMs ?? 300_000;
  }

  acquire(request: AdapterLeaseRequest): Promise<AdapterLease> {
    this.validateRequest(request);
    const pool = this.getOrCreatePool(request);
    if (pool.closed) {
      return Promise.reject(this.poolClosedError(pool.closed));
    }
    pool.maxParallel = Math.min(pool.maxParallel, request.maxParallel, this.runtimeCeiling);
    if ([...pool.running.values()].some(lease => lease.requestId === request.requestId)
      || pool.queued.some(entry => entry.request.requestId === request.requestId)) {
      return Promise.reject(new AdapterSchedulerError('ADAPTER_QUEUE_RESET', 'Duplicate Adapter lease request id'));
    }

    return new Promise<AdapterLease>((resolve, reject) => {
      const enqueuedAt = this.now();
      const pending: PendingRequest = {
        request,
        enqueuedAt,
        deadline: enqueuedAt + request.queueTimeoutMs,
        sequence: ++this.sequence,
        resolve,
        reject,
      };
      pending.timer = setTimeout(() => this.sweepExpired(), request.queueTimeoutMs);
      pending.timer.unref?.();
      pool.queued.push(pending);
      this.schedule(pool);
    });
  }

  heartbeat(identity: AdapterLease): AdapterLease {
    const lease = this.requireLease(identity);
    lease.heartbeatDeadline = this.now() + this.leaseExpiryMs;
    return { ...lease };
  }

  assertLease(identity: AdapterLease): AdapterLease {
    return { ...this.requireLease(identity) };
  }

  release(release: AdapterLeaseRelease): boolean {
    this.pruneReleasedLeaseIds();
    if (this.releasedLeaseIds.has(release.leaseId)) return false;
    const lease = this.requireLease(release);
    const pool = this.pools.get(lease.poolKey)!;
    this.releaseAllResourcesForLease(lease.leaseId);
    this.rejectResourceWaitersForLease(lease.leaseId);
    pool.running.delete(lease.leaseId);
    pool.activeSessions.delete(lease.adapterSession);
    this.releasedLeaseIds.set(lease.leaseId, this.now() + this.releasedLeaseRetentionMs);

    if (release.reason === 'auth_gate' || release.reason === 'rate_limited') {
      pool.closed = release.reason;
      const error = this.poolClosedError(release.reason);
      for (const pending of pool.queued.splice(0)) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(error);
      }
    } else {
      this.schedule(pool);
    }
    this.scheduleResources();
    this.removeDrainedPool(pool);
    return true;
  }

  acquireResources(leaseIdentity: AdapterLease, rawKeys: string[], timeoutMs: number): Promise<AdapterResourceGrant> {
    const lease = this.requireLease(leaseIdentity);
    const keys = [...new Set(rawKeys.map(key => key.trim()).filter(Boolean))].sort();
    if (keys.length === 0) {
      return Promise.reject(new AdapterSchedulerError('ADAPTER_RESOURCE_TIMEOUT', 'At least one resource key is required'));
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new AdapterSchedulerError('ADAPTER_RESOURCE_TIMEOUT', 'Invalid Adapter resource timeout'));
    }
    return new Promise<AdapterResourceGrant>((resolve, reject) => {
      const pending: PendingResourceRequest = {
        lease: { ...lease },
        keys,
        deadline: this.now() + timeoutMs,
        sequence: ++this.sequence,
        resolve,
        reject,
      };
      pending.timer = setTimeout(() => this.sweepExpired(), timeoutMs);
      pending.timer.unref?.();
      this.resourceQueue.push(pending);
      this.scheduleResources();
    });
  }

  releaseResources(leaseIdentity: AdapterLease, grantId: string): boolean {
    const lease = this.requireLease(leaseIdentity);
    const grant = this.resourceGrants.get(grantId);
    if (!grant || grant.leaseId !== lease.leaseId) {
      throw new AdapterSchedulerError('ADAPTER_LEASE_LOST', 'Adapter resource grant is no longer valid');
    }
    this.resourceGrants.delete(grantId);
    for (const key of grant.keys) {
      const owner = this.resourceOwners.get(key);
      if (owner?.grantId === grantId) this.resourceOwners.delete(key);
    }
    this.scheduleResources();
    return true;
  }

  cancel(requestId: string, code = 'ADAPTER_QUEUE_RESET'): boolean {
    for (const pool of this.pools.values()) {
      const index = pool.queued.findIndex(entry => entry.request.requestId === requestId);
      if (index === -1) continue;
      const [pending] = pool.queued.splice(index, 1);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new AdapterSchedulerError(code, 'Adapter lease request was cancelled'));
      this.removeDrainedPool(pool);
      return true;
    }
    return false;
  }

  sweepExpired(): void {
    const now = this.now();
    this.pruneReleasedLeaseIds(now);
    for (const pool of [...this.pools.values()]) {
      for (const pending of [...pool.queued]) {
        if (pending.deadline > now) continue;
        pool.queued.splice(pool.queued.indexOf(pending), 1);
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new AdapterSchedulerError('ADAPTER_QUEUE_TIMEOUT', 'Timed out waiting for an Adapter command lease'));
      }
      for (const lease of [...pool.running.values()]) {
        if (lease.heartbeatDeadline > now) continue;
        this.releaseAllResourcesForLease(lease.leaseId);
        this.rejectResourceWaitersForLease(lease.leaseId);
        pool.running.delete(lease.leaseId);
        pool.activeSessions.delete(lease.adapterSession);
      }
      if (!pool.closed) this.schedule(pool);
      this.removeDrainedPool(pool);
    }
    for (const pending of [...this.resourceQueue]) {
      if (pending.deadline > now) continue;
      this.resourceQueue.splice(this.resourceQueue.indexOf(pending), 1);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new AdapterSchedulerError('ADAPTER_RESOURCE_TIMEOUT', 'Timed out waiting for Adapter resource locks'));
    }
    this.scheduleResources();
  }

  reset(): void {
    for (const pool of this.pools.values()) {
      for (const pending of pool.queued) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new AdapterSchedulerError('ADAPTER_QUEUE_RESET', 'Adapter scheduler restarted'));
      }
    }
    this.pools.clear();
    for (const pending of this.resourceQueue.splice(0)) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new AdapterSchedulerError('ADAPTER_QUEUE_RESET', 'Adapter scheduler restarted'));
    }
    this.resourceOwners.clear();
    this.resourceGrants.clear();
    this.releasedLeaseIds.clear();
  }

  snapshot(): { running: number; queued: number; pools: number } {
    let running = 0;
    let queued = 0;
    for (const pool of this.pools.values()) {
      running += pool.running.size;
      queued += pool.queued.length;
    }
    return { running, queued, pools: this.pools.size };
  }

  resourceSnapshot(): { locked: number; queued: number; grants: number } {
    return {
      locked: this.resourceOwners.size,
      queued: this.resourceQueue.length,
      grants: this.resourceGrants.size,
    };
  }

  private schedule(pool: PoolState): void {
    while (!pool.closed && pool.running.size < pool.maxParallel) {
      const eligible = pool.queued
        .filter(entry => !pool.activeSessions.has(entry.request.adapterSession)
          && pool.running.size < pool.maxParallel)
        .sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.sequence - b.sequence)[0];
      if (!eligible) return;
      pool.queued.splice(pool.queued.indexOf(eligible), 1);
      if (eligible.timer) clearTimeout(eligible.timer);
      const grantedAt = this.now();
      const lease: AdapterLease = {
        leaseId: crypto.randomUUID(),
        requestId: eligible.request.requestId,
        poolKey: pool.key,
        contextId: eligible.request.contextId,
        surface: 'adapter',
        site: eligible.request.site,
        adapterSession: eligible.request.adapterSession,
        sessionKey: eligible.request.sessionKey,
        generation: pool.generation,
        grantedAt,
        heartbeatDeadline: grantedAt + this.leaseExpiryMs,
      };
      pool.running.set(lease.leaseId, lease);
      pool.activeSessions.add(lease.adapterSession);
      eligible.resolve({ ...lease });
    }
  }

  private scheduleResources(): void {
    for (const pending of [...this.resourceQueue].sort((a, b) => a.sequence - b.sequence)) {
      try {
        this.requireLease(pending.lease);
      } catch {
        this.resourceQueue.splice(this.resourceQueue.indexOf(pending), 1);
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new AdapterSchedulerError('ADAPTER_LEASE_LOST', 'Adapter command lease was lost while waiting for resources'));
        continue;
      }
      if (!pending.keys.every(key => !this.resourceOwners.has(key))) continue;
      this.resourceQueue.splice(this.resourceQueue.indexOf(pending), 1);
      if (pending.timer) clearTimeout(pending.timer);
      const grant: AdapterResourceGrant = {
        grantId: crypto.randomUUID(),
        leaseId: pending.lease.leaseId,
        keys: pending.keys,
      };
      this.resourceGrants.set(grant.grantId, grant);
      for (const key of grant.keys) this.resourceOwners.set(key, { leaseId: grant.leaseId, grantId: grant.grantId });
      pending.resolve({ ...grant, keys: [...grant.keys] });
    }
  }

  private releaseAllResourcesForLease(leaseId: string): void {
    for (const grant of [...this.resourceGrants.values()]) {
      if (grant.leaseId !== leaseId) continue;
      this.resourceGrants.delete(grant.grantId);
      for (const key of grant.keys) {
        const owner = this.resourceOwners.get(key);
        if (owner?.grantId === grant.grantId) this.resourceOwners.delete(key);
      }
    }
  }

  private pruneReleasedLeaseIds(now = this.now()): void {
    for (const [leaseId, expiresAt] of this.releasedLeaseIds) {
      if (expiresAt <= now) this.releasedLeaseIds.delete(leaseId);
    }
  }

  private rejectResourceWaitersForLease(leaseId: string): void {
    for (const pending of [...this.resourceQueue]) {
      if (pending.lease.leaseId !== leaseId) continue;
      this.resourceQueue.splice(this.resourceQueue.indexOf(pending), 1);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new AdapterSchedulerError('ADAPTER_LEASE_LOST', 'Adapter command lease ended while waiting for resources'));
    }
  }

  private requireLease(identity: AdapterLease): AdapterLease {
    const pool = this.pools.get(identity.poolKey);
    const lease = pool?.running.get(identity.leaseId);
    if (!lease
      || lease.requestId !== identity.requestId
      || lease.contextId !== identity.contextId
      || lease.site !== identity.site
      || lease.adapterSession !== identity.adapterSession
      || lease.sessionKey !== identity.sessionKey
      || lease.generation !== identity.generation) {
      throw new AdapterSchedulerError('ADAPTER_LEASE_LOST', 'Adapter command lease is no longer valid');
    }
    return lease;
  }

  private getOrCreatePool(request: AdapterLeaseRequest): PoolState {
    const key = `${request.contextId}\u0000${request.surface}\u0000${request.site}`;
    const existing = this.pools.get(key);
    if (existing) return existing;
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    const pool: PoolState = {
      key,
      generation,
      maxParallel: Math.min(request.maxParallel, this.runtimeCeiling),
      running: new Map(),
      activeSessions: new Set(),
      queued: [],
    };
    this.pools.set(key, pool);
    return pool;
  }

  private removeDrainedPool(pool: PoolState): void {
    if (pool.running.size === 0 && pool.queued.length === 0) this.pools.delete(pool.key);
  }

  private poolClosedError(reason: AdapterPoolCloseReason): AdapterSchedulerError {
    return reason === 'auth_gate'
      ? new AdapterSchedulerError('ADAPTER_POOL_AUTH_GATE', 'Adapter pool stopped at an authentication or verification gate')
      : new AdapterSchedulerError('ADAPTER_POOL_RATE_LIMITED', 'Adapter pool stopped after account rate limiting');
  }

  private validateRequest(request: AdapterLeaseRequest): void {
    if (!request.requestId || !request.contextId || !request.site || !request.adapterSession || !request.sessionKey) {
      throw new AdapterSchedulerError('ADAPTER_QUEUE_RESET', 'Invalid Adapter lease request');
    }
    if (!Number.isInteger(request.queueTimeoutMs) || request.queueTimeoutMs < 1) {
      throw new AdapterSchedulerError('ADAPTER_QUEUE_RESET', 'Invalid Adapter queue timeout');
    }
    if (!Number.isInteger(request.maxParallel) || request.maxParallel < 1 || request.maxParallel > this.runtimeCeiling) {
      throw new AdapterSchedulerError('ADAPTER_QUEUE_RESET', 'Invalid Adapter concurrency limit');
    }
  }
}
