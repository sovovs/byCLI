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
  finalized: boolean;
  readonly finalizedGroups: Set<number>;
}

interface RegistryTransactionGlobalState {
  storage: AsyncLocalStorage<RegistryTransaction>;
  transactionCounter: number;
  groupCounter: number;
  revisionCounter: number;
  revisions: Map<string, number>;
  transactions: Map<number, RegistryTransaction>;
  owners: Map<string, Set<number>>;
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
  transactions: new Map<number, RegistryTransaction>(),
  owners: new Map<string, Set<number>>(),
};
state.transactions ??= new Map<number, RegistryTransaction>();
state.owners ??= new Map<string, Set<number>>();

export function createRegistryTransaction(): RegistryTransaction {
  const transaction: RegistryTransaction = {
    writes: [],
    id: ++state.transactionCounter,
    active: false,
    currentGroup: undefined,
    finalized: false,
    finalizedGroups: new Set<number>(),
  };
  state.transactions.set(transaction.id, transaction);
  return transaction;
}

export function closeRegistryTransaction(transaction: RegistryTransaction): void {
  transaction.active = false;
  transaction.currentGroup = undefined;
}

export async function runRegistryTransaction<T>(
  transaction: RegistryTransaction,
  operation: () => Promise<T>,
): Promise<T> {
  if (transaction.finalized) {
    throw new Error('Adapter registration transaction is finalized');
  }
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
  if (transaction?.finalized) {
    throw new Error('Adapter registration transaction is finalized');
  }
  const beforeRevision = state.revisions.get(key) ?? 0;
  const afterRevision = ++state.revisionCounter;
  state.revisions.set(key, afterRevision);
  if (!transaction) return;
  const group = transaction.currentGroup ?? ++state.groupCounter;
  transaction.writes.push({
    key,
    before,
    after,
    group,
    beforeRevision,
    afterRevision,
  });
  const owners = state.owners.get(key) ?? new Set<number>();
  owners.add(transaction.id);
  state.owners.set(key, owners);
}

/**
 * Keys with revision ownership, including absent-key tombstones.
 *
 * Tombstones intentionally remain until a later mutation or rollback supersedes
 * them. Pruning an absent revision while an overlapping transaction may still
 * reference it would allow an older rollback to resurrect the key.
 */
export function registryMutationKeys(): string[] {
  return [...state.revisions.keys()];
}

export function pruneRegistryMutationKey(key: string, registry: ReadonlyMap<string, CliCommand>): void {
  if (registry.has(key)) return;
  if ((state.owners.get(key)?.size ?? 0) > 0) return;
  state.revisions.delete(key);
}

export function finalizeRegistryTransaction(
  transaction: RegistryTransaction,
  registry: ReadonlyMap<string, CliCommand>,
  groups?: ReadonlySet<number>,
): void {
  if (transaction.active) {
    throw new Error('Cannot finalize an active adapter registration transaction');
  }
  const selectedGroups = groups ?? new Set(transaction.writes.map(write => write.group));
  const newGroups = new Set(
    [...selectedGroups].filter(group => !transaction.finalizedGroups.has(group)),
  );
  const affectedKeys = new Set(
    transaction.writes
      .filter(write => newGroups.has(write.group))
      .map(write => write.key),
  );
  for (const group of newGroups) transaction.finalizedGroups.add(group);

  for (const key of affectedKeys) {
    const stillOwned = transaction.writes.some(
      write => write.key === key && !transaction.finalizedGroups.has(write.group),
    );
    if (!stillOwned) {
      const owners = state.owners.get(key);
      owners?.delete(transaction.id);
      if (owners?.size === 0) state.owners.delete(key);
    }
    pruneRegistryMutationKey(key, registry);
  }

  const hasUnfinalizedWrites = transaction.writes.some(
    write => !transaction.finalizedGroups.has(write.group),
  );
  if (!hasUnfinalizedWrites) {
    transaction.finalized = true;
    state.transactions.delete(transaction.id);
  }
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
    .filter(group => !transaction.finalizedGroups.has(group) && (!groups || groups.has(group)))
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
  finalizeRegistryTransaction(transaction, registry, new Set(groupIds));
}

export function resetRegistryTransactionStateForTests(): void {
  for (const transaction of state.transactions.values()) {
    closeRegistryTransaction(transaction);
    transaction.finalized = true;
    for (const write of transaction.writes) transaction.finalizedGroups.add(write.group);
  }
  state.transactions.clear();
  state.owners.clear();
  state.revisions.clear();
}
