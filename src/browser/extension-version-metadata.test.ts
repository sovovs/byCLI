import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('extension release metadata', () => {
  it('ships CLI and extension 2.1.9 metadata consistently', () => {
    const cliPackage = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    const cliLock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as {
      version: string;
      packages: { '': { version: string } };
    };
    const manifest = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8')) as { version: string };
    const packageJson = JSON.parse(readFileSync(new URL('../../extension/package.json', import.meta.url), 'utf8')) as { version: string };
    const lock = JSON.parse(readFileSync(new URL('../../extension/package-lock.json', import.meta.url), 'utf8')) as {
      version: string;
      packages: { '': { version: string } };
    };

    expect(cliPackage.version).toBe('2.1.9');
    expect(cliLock.version).toBe('2.1.9');
    expect(cliLock.packages[''].version).toBe('2.1.9');
    expect(manifest.version).toBe('2.1.9');
    expect(packageJson.version).toBe('2.1.9');
    expect(lock.version).toBe('2.1.9');
    expect(lock.packages[''].version).toBe('2.1.9');
  });
});
