import { AsyncLocalStorage } from 'node:async_hooks';
import type { CliCommand } from './registry.js';

interface RegistrySlot {
  present: boolean;
  value: CliCommand | undefined;
}

export interface RegistryTransactionWrite {
  key: string;
  before: RegistrySlot;
  after: RegistrySlot;
  group: number;
  beforeRevision: number;
  afterRevision: number;
}

export interface RegistryTransaction {
  readonly writes: RegistryTransactionWrite[];
  readonly id: number;
  active: boolean;
  currentGroup: number | undefined;
}

interface RegistryTransactionGlobalState {
  storage: AsyncLocalStorage<RegistryTransaction>;
  transactionCounter: number;
  groupCounter: number;
  revisionCounter: number;
  revisions: Map<string, number>;
}

const TRANSACTION_STATE_KEY = Symbol.for('@sovovs/bycli/registry-transaction-state');
const globalState = globalThis as typeof globalThis & {
  [TRANSACTION_STATE_KEY]?: RegistryTransactionGlobalState;
};
const state = globalState[TRANSACTION_STATE_KEY] ??= {
  storage: new AsyncLocalStorage<RegistryTransaction>(),
  transactionCounter: 0,
  groupCounter: 0,
  revisionCounter: 0,
  revisions: new Map<string, number>(),
};

export function createRegistryTransaction(): RegistryTransaction {
  return { writes: [], id: ++state.transactionCounter, active: false, currentGroup: undefined };
}

export function closeRegistryTransaction(transaction: RegistryTransaction): void {
  transaction.active = false;
  transaction.currentGroup = undefined;
}

export async function runRegistryTransaction<T>(
  transaction: RegistryTransaction,
  operation: () => Promise<T>,
): Promise<T> {
  transaction.active = true;
  return state.storage.run(transaction, async () => {
    try {
      return await operation();
    } finally {
      closeRegistryTransaction(transaction);
    }
  });
}

export function withRegistryMutationGroup<T>(operation: () => T): T {
  const transaction = state.storage.getStore();
  if (!transaction) return operation();
  if (!transaction.active) {
    throw new Error('Adapter registration transaction is closed; delayed registration is not allowed');
  }
  const previousGroup = transaction.currentGroup;
  transaction.currentGroup = ++state.groupCounter;
  try {
    return operation();
  } finally {
    transaction.currentGroup = previousGroup;
  }
}

export function recordRegistryMutation(
  key: string,
  before: RegistrySlot,
  after: RegistrySlot,
): void {
  const transaction = state.storage.getStore();
  if (transaction && !transaction.active) {
    throw new Error('Adapter registration transaction is closed; delayed registration is not allowed');
  }
  const beforeRevision = state.revisions.get(key) ?? 0;
  const afterRevision = ++state.revisionCounter;
  state.revisions.set(key, afterRevision);
  if (!transaction) return;
  transaction.writes.push({
    key,
    before,
    after,
    group: transaction.currentGroup ?? ++state.groupCounter,
    beforeRevision,
    afterRevision,
  });
}

export function capturedRegistryValue(
  transaction: RegistryTransaction,
  key: string,
): RegistrySlot {
  for (let index = transaction.writes.length - 1; index >= 0; index -= 1) {
    const write = transaction.writes[index];
    if (write.key === key) return write.after;
  }
  return { present: false, value: undefined };
}

export function capturedRegistryValues(transaction: RegistryTransaction): Map<string, CliCommand> {
  const keys = new Set(transaction.writes.map(write => write.key));
  const values = new Map<string, CliCommand>();
  for (const key of keys) {
    const captured = capturedRegistryValue(transaction, key);
    if (captured.present && captured.value) values.set(key, captured.value);
  }
  return values;
}

export function transactionGroupsForKey(transaction: RegistryTransaction, key: string): Set<number> {
  return new Set(
    transaction.writes.filter(write => write.key === key).map(write => write.group),
  );
}

export function rollbackRegistryTransaction(
  transaction: RegistryTransaction,
  registry: Map<string, CliCommand>,
  groups?: ReadonlySet<number>,
): void {
  const groupIds = [...new Set(transaction.writes.map(write => write.group))]
    .filter(group => !groups || groups.has(group))
    .sort((a, b) => b - a);
  for (const group of groupIds) {
    const writesByKey = new Map<string, RegistryTransactionWrite[]>();
    for (const write of transaction.writes) {
      if (write.group !== group) continue;
      const writes = writesByKey.get(write.key) ?? [];
      writes.push(write);
      writesByKey.set(write.key, writes);
    }
    for (const writes of writesByKey.values()) {
      const finalWrite = writes.at(-1)!;
      if ((state.revisions.get(finalWrite.key) ?? 0) !== finalWrite.afterRevision) continue;
      for (let index = writes.length - 1; index >= 0; index -= 1) {
        const write = writes[index];
        if (write.before.present) Map.prototype.set.call(registry, write.key, write.before.value!);
        else Map.prototype.delete.call(registry, write.key);
        if (write.beforeRevision === 0) state.revisions.delete(write.key);
        else state.revisions.set(write.key, write.beforeRevision);
      }
    }
  }
}

export function resetRegistryTransactionStateForTests(): void {
  state.revisions.clear();
  state.transactionCounter = 0;
  state.groupCounter = 0;
  state.revisionCounter = 0;
}
