// #2 nearest-adapter — wrapper 进程跳过 discovery,loadAdapterRegistry() 从 cli-manifest.json
// 轻量构造 {site,name,domain} AdapterRef,喂给 findNearestAdapter。这里测加载/合并/容错 +
// 加载结果端到端能命中 nearest-adapter。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdapterRegistry } from './analyze-runner.js';
import { findNearestAdapter } from '../../browser/analyze.js';

function writeManifest(entries: unknown[]): { dir: string; manifestPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bycli-manifest-test-'));
  // loadAdapterRegistry reads `<clisDir>/../cli-manifest.json` via getCliManifestPath;
  // so the manifest sits one level above the clis dir we hand it.
  const manifestPath = join(dir, 'cli-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(entries), 'utf8');
  return { dir, manifestPath };
}

describe('loadAdapterRegistry', () => {
  it('builds {site,name,domain} refs from a manifest', () => {
    const { dir, manifestPath } = writeManifest([
      { site: 'bilibili', name: 'search', domain: 'bilibili.com' },
      { site: 'github', name: 'repos', domain: 'github.com' },
    ]);
    try {
      const reg = loadAdapterRegistry([manifestPath]);
      expect(reg.size).toBe(2);
      expect(reg.get('bilibili/search')).toEqual({ site: 'bilibili', name: 'search', domain: 'bilibili.com' });
      expect(reg.get('github/repos')?.domain).toBe('github.com');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets a later manifest override an earlier one on site/name collision (user > built-in)', () => {
    const builtin = writeManifest([{ site: 'acme', name: 'list', domain: 'acme.io' }]);
    const user = writeManifest([{ site: 'acme', name: 'list', domain: 'acme-override.io' }]);
    try {
      const reg = loadAdapterRegistry([builtin.manifestPath, user.manifestPath]);
      expect(reg.size).toBe(1);
      expect(reg.get('acme/list')?.domain).toBe('acme-override.io');
    } finally {
      rmSync(builtin.dir, { recursive: true, force: true });
      rmSync(user.dir, { recursive: true, force: true });
    }
  });

  it('skips a missing manifest path, still loads the present one', () => {
    const { dir, manifestPath } = writeManifest([{ site: 'x', name: 'y', domain: 'x.com' }]);
    try {
      const reg = loadAdapterRegistry(['/no/such/cli-manifest.json', manifestPath]);
      expect(reg.size).toBe(1);
      expect(reg.has('x/y')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a corrupt manifest without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bycli-manifest-test-'));
    const manifestPath = join(dir, 'cli-manifest.json');
    writeFileSync(manifestPath, '{ not valid json', 'utf8');
    try {
      const reg = loadAdapterRegistry([manifestPath]);
      expect(reg.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops entries missing site or name', () => {
    const { dir, manifestPath } = writeManifest([
      { site: 'ok', name: 'cmd', domain: 'ok.com' },
      { name: 'noSite' },
      { site: 'noName' },
    ]);
    try {
      const reg = loadAdapterRegistry([manifestPath]);
      expect(reg.size).toBe(1);
      expect(reg.has('ok/cmd')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loaded registry feeds findNearestAdapter end-to-end', () => {
    const { dir, manifestPath } = writeManifest([
      { site: 'bilibili', name: 'search', domain: 'bilibili.com' },
      { site: 'bilibili', name: 'video', domain: 'bilibili.com' },
    ]);
    try {
      const reg = loadAdapterRegistry([manifestPath]);
      const hit = findNearestAdapter('https://www.bilibili.com/video/123', reg);
      expect(hit).not.toBeNull();
      expect(hit?.site).toBe('bilibili');
      expect(hit?.example_commands).toContain('bilibili search');

      const miss = findNearestAdapter('https://unrelated.example/', reg);
      expect(miss).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
