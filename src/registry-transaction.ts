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
}

export interface RegistryTransaction {
  readonly writes: RegistryTransactionWrite[];
  active: boolean;
  nextGroup: number;
  currentGroup: number | undefined;
}

const transactionStorage = new AsyncLocalStorage<RegistryTransaction>();

export function createRegistryTransaction(): RegistryTransaction {
  return { writes: [], active: false, nextGroup: 0, currentGroup: undefined };
}

export async function runRegistryTransaction<T>(
  transaction: RegistryTransaction,
  operation: () => Promise<T>,
): Promise<T> {
  transaction.active = true;
  return transactionStorage.run(transaction, async () => {
    try {
      return await operation();
    } finally {
      transaction.active = false;
      transaction.currentGroup = undefined;
    }
  });
}

export function withRegistryMutationGroup<T>(operation: () => T): T {
  const transaction = transactionStorage.getStore();
  if (!transaction) return operation();
  if (!transaction.active) {
    throw new Error('Adapter registration transaction is closed; delayed registration is not allowed');
  }
  const previousGroup = transaction.currentGroup;
  transaction.currentGroup = ++transaction.nextGroup;
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
  const transaction = transactionStorage.getStore();
  if (!transaction) return;
  if (!transaction.active) {
    throw new Error('Adapter registration transaction is closed; delayed registration is not allowed');
  }
  transaction.writes.push({
    key,
    before,
    after,
    group: transaction.currentGroup ?? ++transaction.nextGroup,
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
  for (let index = transaction.writes.length - 1; index >= 0; index -= 1) {
    const write = transaction.writes[index];
    if (groups && !groups.has(write.group)) continue;
    const currentPresent = registry.has(write.key);
    const currentValue = registry.get(write.key);
    if (currentPresent !== write.after.present || currentValue !== write.after.value) continue;
    if (write.before.present) registry.set(write.key, write.before.value!);
    else registry.delete(write.key);
  }
}
