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

  it('does not ABA-rollback externally rewritten keys but restores other owned alias state', async () => {
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
    expect(getRegistry().get(`${site}/prior-alias`)).toBe(prior);
  });

  it('does not roll back an owned key after a direct external Map.set replacement', async () => {
    const site = `transaction-direct-set-${Date.now()}`;
    sites.push(site);
    const prior = command(site, 'prior');
    const owned = command(site, 'owned');
    const external = command(site, 'external');
    registerCommand(prior);
    const transaction = createRegistryTransaction();
    await runRegistryTransaction(transaction, async () => registerCommand(owned));

    getRegistry().set(`${site}/list`, external);
    rollbackRegistryTransaction(transaction, getRegistry());

    expect(getRegistry().get(`${site}/list`)).toBe(external);
  });

  it('does not restore owned keys after direct external Map.delete and Map.clear', async () => {
    const deleteSite = `transaction-direct-delete-${Date.now()}`;
    const clearSite = `transaction-direct-clear-${Date.now()}`;
    sites.push(deleteSite, clearSite);
    const priorDelete = command(deleteSite, 'prior-delete');
    const ownedDelete = command(deleteSite, 'owned-delete');
    const priorClear = command(clearSite, 'prior-clear', ['prior-alias']);
    const ownedClear = command(clearSite, 'owned-clear', ['owned-alias']);
    registerCommand(priorDelete);
    registerCommand(priorClear);
    const deleteTransaction = createRegistryTransaction();
    const clearTransaction = createRegistryTransaction();
    await runRegistryTransaction(deleteTransaction, async () => registerCommand(ownedDelete));
    await runRegistryTransaction(clearTransaction, async () => registerCommand(ownedClear));
    const registrySnapshot = [...getRegistry().entries()];

    try {
      getRegistry().delete(`${deleteSite}/list`);
      getRegistry().clear();
      rollbackRegistryTransaction(deleteTransaction, getRegistry());
      rollbackRegistryTransaction(clearTransaction, getRegistry());

      expect(getRegistry().has(`${deleteSite}/list`)).toBe(false);
      expect(getRegistry().has(`${clearSite}/list`)).toBe(false);
      expect(getRegistry().has(`${clearSite}/owned-alias`)).toBe(false);
    } finally {
      for (const [key, value] of registrySnapshot) getRegistry().set(key, value);
    }
  });

  it('captures direct Map writes in an active transaction and rolls back clear as one group', async () => {
    const site = `transaction-direct-active-${Date.now()}`;
    sites.push(site);
    const prior = command(site, 'prior', ['prior-alias']);
    const replacement = command(site, 'replacement');
    registerCommand(prior);
    const before = new Map(getRegistry());
    const transaction = createRegistryTransaction();

    await runRegistryTransaction(transaction, async () => {
      getRegistry().set(`${site}/list`, replacement);
      getRegistry().set(`${site}/temporary-alias`, replacement);
      getRegistry().delete(`${site}/prior-alias`);
      getRegistry().clear();
    });

    const clearGroup = transaction.writes.at(-1)!.group;
    const clearWrites = transaction.writes.filter(write => write.group === clearGroup);
    expect(clearWrites).toHaveLength(before.size);
    expect(clearWrites.every(write => write.after.present === false)).toBe(true);

    rollbackRegistryTransaction(transaction, getRegistry());
    expect([...getRegistry().entries()]).toEqual([...before.entries()]);
  });

  it('rejects direct Map mutations inherited from a closed async transaction before side effects', async () => {
    const site = `transaction-direct-closed-${Date.now()}`;
    sites.push(site);
    const existing = command(site, 'existing');
    registerCommand(existing);
    const registry = getRegistry();
    const before = [...registry.entries()];
    const errors: unknown[] = [];
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const transaction = createRegistryTransaction();

    await runRegistryTransaction(transaction, async () => {
      setTimeout(() => {
        for (const operation of [
          () => registry.set(`${site}/late`, command(site, 'late')),
          () => registry.delete(`${site}/list`),
          () => registry.clear(),
        ]) {
          try {
            operation();
          } catch (error) {
            errors.push(error);
          }
        }
        finish();
      }, 0);
    });
    await finished;

    expect(errors).toHaveLength(3);
    for (const error of errors) expect(error).toMatchObject({
      message: expect.stringMatching(/transaction.*closed/i),
    });
    expect([...registry.entries()]).toEqual(before);
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
    const trackedRegistryMarker = Symbol.for('@sovovs/bycli/tracked-registry');
    const transaction = transactionCopy.createRegistryTransaction();

    await transactionCopy.runRegistryTransaction(transaction, async () => {
      registryCopy.registerCommand(pluginCommand);
    });
    expect(registryCopy.getRegistry()).toBe(getRegistry());
    expect((getRegistry() as any)[trackedRegistryMarker]).toBe(true);
    expect(transaction.writes.length).toBeGreaterThan(0);
    const external = command(site, 'external-copy', ['external-alias']);
    registryCopy.getRegistry().set(`${site}/list`, external);
    transactionCopy.rollbackRegistryTransaction(transaction, getRegistry());

    expect(getRegistry().get(`${site}/list`)).toBe(external);
    expect(getRegistry().get(`${site}/prior-alias`)).toBe(prior);
    expect(getRegistry().get(`${site}/plugin-alias`)).toBeUndefined();
  });

  it('records each normal registerCommand key exactly once', async () => {
    const site = `transaction-register-once-${Date.now()}`;
    sites.push(site);
    const registered = command(site, 'registered', ['first-alias', 'second-alias']);
    const transaction = createRegistryTransaction();

    await runRegistryTransaction(transaction, async () => registerCommand(registered));

    expect(transaction.writes.map(write => write.key)).toEqual([
      `${site}/list`, `${site}/first-alias`, `${site}/second-alias`,
    ]);
    expect(new Set(transaction.writes.map(write => write.group))).toHaveLength(1);
    rollbackRegistryTransaction(transaction, getRegistry());
  });

  it('migrates a pre-existing plain global Map without recording copied entries', async () => {
    const originalRegistry = getRegistry();
    const site = `transaction-plain-migration-${Date.now()}`;
    const migrated = command(site, 'migrated');
    const key = `${site}/list`;
    const plainRegistry = new Map([[key, migrated]]);
    globalThis.__bycli_registry__ = plainRegistry;
    const transaction = createRegistryTransaction();

    try {
      let registryCopy: typeof import('./registry.js') | undefined;
      await runRegistryTransaction(transaction, async () => {
        // @ts-expect-error Vite treats a query-suffixed module as a separate module instance.
        registryCopy = await import('./registry.ts?copy=plain-map-migration');
      });

      expect(transaction.writes).toHaveLength(0);
      expect(registryCopy!.getRegistry()).not.toBe(plainRegistry);
      expect(globalThis.__bycli_registry__).toBe(registryCopy!.getRegistry());
      expect(registryCopy!.getRegistry().get(key)).toBe(migrated);
      expect((registryCopy!.getRegistry() as any)[Symbol.for('@sovovs/bycli/tracked-registry')]).toBe(true);
    } finally {
      globalThis.__bycli_registry__ = originalRegistry;
    }
  });

  it('closes transaction state idempotently', () => {
    const transaction = createRegistryTransaction();
    closeRegistryTransaction(transaction);
    closeRegistryTransaction(transaction);
    expect(transaction.active).toBe(false);
  });
});
