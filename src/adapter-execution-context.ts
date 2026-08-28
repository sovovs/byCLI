import { AsyncLocalStorage } from 'node:async_hooks';
import type { AdapterLease } from './adapter-scheduler.js';

export interface AdapterExecutionContext {
  lease: AdapterLease;
}

const storage = new AsyncLocalStorage<AdapterExecutionContext>();

export function getAdapterExecutionContext(): AdapterExecutionContext | undefined {
  return storage.getStore();
}

export function runWithAdapterExecutionContext<T>(
  context: AdapterExecutionContext,
  operation: () => Promise<T>,
): Promise<T> {
  return storage.run(context, operation);
}
