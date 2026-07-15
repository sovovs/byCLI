import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadFromManifest } from './discovery.js';
import { getRegistry, type InternalCliCommand } from './registry.js';

describe('manifest discovery', () => {
  const tempDirs: string[] = [];
  const registryKeys: string[] = [];

  afterEach(() => {
    for (const key of registryKeys.splice(0)) getRegistry().delete(key);
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('registers a type-valid lazy conditional placeholder for hydration', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-discovery-manifest-'));
    tempDirs.push(root);
    const site = `conditional-discovery-${Date.now()}`;
    const key = `${site}/list`;
    registryKeys.push(key);
    const manifestPath = path.join(root, 'cli-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify([{
      site,
      name: 'list',
      description: 'conditional command',
      access: 'read',
      strategy: 'cookie',
      browser: 'conditional',
      args: [{ name: 'auth-source', default: 'browser' }],
      type: 'js',
      modulePath: `${site}/list.js`,
    }]));

    await expect(loadFromManifest(manifestPath, root)).resolves.toBe(true);

    const command = getRegistry().get(key) as InternalCliCommand;
    expect(command).toMatchObject({
      browser: 'conditional',
      _hydrateBeforeBrowserRouting: true,
      _lazy: true,
      _modulePath: path.join(root, site, 'list.js'),
    });
    if (command.browser !== 'conditional') throw new Error('expected conditional placeholder');
    expect(command.requiresBrowser).toEqual(expect.any(Function));
  });
});
