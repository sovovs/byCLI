import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface ReleaseVersionHelpers {
  compareDottedVersions(left: string, right: string): number;
  assertReleaseTagMatchesVersion(refName: string | undefined, version: string): void;
  assertExtensionVersionAdvanced(input: {
    currentVersion: string;
    latestTag: string | undefined;
    hasExtensionChanges: boolean;
  }): void;
}

async function loadReleaseVersionHelpers(): Promise<ReleaseVersionHelpers> {
  const scriptUrl = pathToFileURL(path.resolve(
    process.cwd(),
    'extension',
    'scripts',
    'check-release-version.mjs',
  )).href;
  return await import(scriptUrl) as ReleaseVersionHelpers;
}

describe('extension manifest regression', () => {
  it('keeps host permissions required by chrome.cookies.getAll', async () => {
    const manifestPath = path.resolve(process.cwd(), 'extension', 'manifest.json');
    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as {
      permissions?: string[];
      host_permissions?: string[];
    };

    expect(manifest.permissions).toContain('cookies');
    expect(manifest.host_permissions).toContain('<all_urls>');
  });

  it('keeps extension release versions synchronized beyond 2.1.20', async () => {
    const extensionDir = path.resolve(process.cwd(), 'extension');
    const [manifestRaw, packageRaw, lockfileRaw] = await Promise.all([
      fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf8'),
      fs.readFile(path.join(extensionDir, 'package.json'), 'utf8'),
      fs.readFile(path.join(extensionDir, 'package-lock.json'), 'utf8'),
    ]);
    const manifest = JSON.parse(manifestRaw) as { version?: string };
    const extensionPackage = JSON.parse(packageRaw) as { version?: string };
    const lockfile = JSON.parse(lockfileRaw) as {
      version?: string;
      packages?: Record<string, { version?: string }>;
    };

    expect(manifest.version).toBe(extensionPackage.version);
    expect(lockfile.version).toBe(extensionPackage.version);
    expect(lockfile.packages?.['']?.version).toBe(extensionPackage.version);
    expect(extensionPackage.version).toMatch(/^\d+\.\d+\.\d+$/);
    const { compareDottedVersions } = await loadReleaseVersionHelpers();
    expect(compareDottedVersions(extensionPackage.version ?? '', '2.1.20')).toBeGreaterThan(0);
  });

  it('compares dotted extension versions numerically', async () => {
    const { compareDottedVersions } = await loadReleaseVersionHelpers();

    expect(compareDottedVersions('2.1.21', '2.1.20')).toBeGreaterThan(0);
    expect(compareDottedVersions('2.1.20', '2.1.20')).toBe(0);
    expect(compareDottedVersions('2.1.9', '2.1.20')).toBeLessThan(0);
  });

  it('rejects an extension tag that does not match the package version', async () => {
    const { assertReleaseTagMatchesVersion } = await loadReleaseVersionHelpers();

    expect(() => assertReleaseTagMatchesVersion('ext-v2.1.20', '2.1.21')).toThrow(/does not match/i);
    expect(() => assertReleaseTagMatchesVersion('ext-v2.1.21', '2.1.21')).not.toThrow();
    expect(() => assertReleaseTagMatchesVersion('main', '2.1.21')).not.toThrow();
  });

  it('requires extension changes to advance beyond the latest release tag', async () => {
    const { assertExtensionVersionAdvanced } = await loadReleaseVersionHelpers();

    expect(() => assertExtensionVersionAdvanced({
      currentVersion: '2.1.20',
      latestTag: 'ext-v2.1.20',
      hasExtensionChanges: true,
    })).toThrow(/must be greater/i);
    expect(() => assertExtensionVersionAdvanced({
      currentVersion: '2.1.21',
      latestTag: 'ext-v2.1.20',
      hasExtensionChanges: true,
    })).not.toThrow();
    expect(() => assertExtensionVersionAdvanced({
      currentVersion: '2.1.20',
      latestTag: 'ext-v2.1.20',
      hasExtensionChanges: false,
    })).not.toThrow();
  });
});
