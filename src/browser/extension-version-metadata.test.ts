import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('extension release metadata', () => {
  it('ships focus-window negotiation as extension 2.1.0 consistently', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8')) as { version: string };
    const packageJson = JSON.parse(readFileSync(new URL('../../extension/package.json', import.meta.url), 'utf8')) as { version: string };
    const lock = JSON.parse(readFileSync(new URL('../../extension/package-lock.json', import.meta.url), 'utf8')) as {
      version: string;
      packages: { '': { version: string } };
    };

    expect(manifest.version).toBe('2.1.0');
    expect(packageJson.version).toBe('2.1.0');
    expect(lock.version).toBe('2.1.0');
    expect(lock.packages[''].version).toBe('2.1.0');
  });
});
