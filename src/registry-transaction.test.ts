import { afterEach, describe, expect, it } from 'vitest';
import { getRegistry, registerCommand, type ConditionalBrowserCliCommand } from './registry.js';
import {
  closeRegistryTransaction,
  createRegistryTransaction,
  resetRegistryTransactionStateForTests,
  rollbackRegistryTransaction,
  runRegistryTransaction,
} from './registry-transaction.js';

function command(site: string, label: string, aliases?: string[]): ConditionalBrowserCliCommand {
  return {
    site, name: 'list', aliases, access: 'read', description: label, args: [],
    browser: 'conditional', requiresBrowser: () => false,
    func: async () => label,
  };
}

describe('registry transaction ownership', () => {
  const sites: string[] = [];

  afterEach(() => {
    for (const site of sites.splice(0)) {
      for (const key of [...getRegistry().keys()]) {
        if (key.startsWith(`${site}/`)) getRegistry().delete(key);
      }
    }
    resetRegistryTransactionStateForTests();
  });

  it('fully unwinds repeated canonical and alias writes in reverse order', async () => {
    const site = `transaction-unwind-${Date.now()}`;
    sites.push(site);
    const prior = command(site, 'prior', ['prior-alias']);
    const middle = command(site, 'middle', ['middle-alias']);
    const latest = command(site, 'latest', ['latest-alias']);
    registerCommand(prior);
    const transaction = createRegistryTransaction();
    await runRegistryTransaction(transaction, async () => {
      registerCommand(middle);
      registerCommand(latest);
    });

    rollbackRegistryTransaction(transaction, getRegistry());

    expect(getRegistry().get(`${site}/list`)).toBe(prior);
    expect(getRegistry().get(`${site}/prior-alias`)).toBe(prior);
    expect(getRegistry().get(`${site}/middle-alias`)).toBeUndefined();
    expect(getRegistry().get(`${site}/latest-alias`)).toBeUndefined();
  });

  it('does not ABA-rollback an external write of the same command object or its alias state', async () => {
    const site = `transaction-aba-${Date.now()}`;
    sites.push(site);
    const prior = command(site, 'prior', ['prior-alias']);
    const reused = command(site, 'reused', ['reused-alias']);
    registerCommand(prior);
    const transaction = createRegistryTransaction();
    await runRegistryTransaction(transaction, async () => registerCommand(reused));

    registerCommand(reused);
    rollbackRegistryTransaction(transaction, getRegistry());

    expect(getRegistry().get(`${site}/list`)).toBe(reused);
    expect(getRegistry().get(`${site}/reused-alias`)).toBe(reused);
    expect(getRegistry().get(`${site}/prior-alias`)).toBeUndefined();
  });

  it('shares transaction context and revisions across independently evaluated module copies', async () => {
    const site = `transaction-copy-${Date.now()}`;
    sites.push(site);
    const prior = command(site, 'prior', ['prior-alias']);
    const pluginCommand = command(site, 'plugin', ['plugin-alias']);
    registerCommand(prior);
    // @ts-expect-error Vite treats a query-suffixed module as a separate module instance.
    const transactionCopy = await import('./registry-transaction.ts?copy=transaction-copy');
    // @ts-expect-error Vite treats a query-suffixed module as a separate module instance.
    const registryCopy = await import('./registry.ts?copy=registry-copy');
    const transaction = transactionCopy.createRegistryTransaction();

    await transactionCopy.runRegistryTransaction(transaction, async () => {
      registryCopy.registerCommand(pluginCommand);
    });
    expect(transaction.writes.length).toBeGreaterThan(0);
    transactionCopy.rollbackRegistryTransaction(transaction, getRegistry());

    expect(getRegistry().get(`${site}/list`)).toBe(prior);
    expect(getRegistry().get(`${site}/prior-alias`)).toBe(prior);
    expect(getRegistry().get(`${site}/plugin-alias`)).toBeUndefined();
  });

  it('closes transaction state idempotently', () => {
    const transaction = createRegistryTransaction();
    closeRegistryTransaction(transaction);
    closeRegistryTransaction(transaction);
    expect(transaction.active).toBe(false);
  });
});
