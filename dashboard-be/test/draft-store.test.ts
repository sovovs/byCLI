// N2 草稿存储单测:0700 目录 / 0600 文件 / 内容 / 清理。
import { describe, it, expect, afterEach } from 'vitest';
import { statSync, readFileSync, existsSync } from 'node:fs';
import { makeDraftDir, writeDrafts, cleanupDraftDir } from '../src/llm/draft-store.js';

let dir = '';
afterEach(() => { if (dir) cleanupDraftDir(dir); dir = ''; });

describe('draft-store', () => {
  it('makeDraftDir 0700 + writeDrafts 0600 + 内容正确', () => {
    dir = makeDraftDir();
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const files = writeDrafts(dir, [
      { site: 'x-com', name: 'search', source: 'cli({a:1});' },
      { site: 'weird/site', name: 'n a m e', source: '// b' },
    ]);
    expect(files).toHaveLength(2);
    expect(readFileSync(files[0].path, 'utf8')).toBe('cli({a:1});');
    expect(statSync(files[0].path).mode & 0o777).toBe(0o600);
    // 文件名安全化(非法字符 → _)
    expect(files[1].path).toMatch(/weird_site__n_a_m_e\.js$/);
  });

  it('cleanupDraftDir 删整目录', () => {
    const d = makeDraftDir();
    writeDrafts(d, [{ site: 's', name: 'n', source: 'x' }]);
    cleanupDraftDir(d);
    expect(existsSync(d)).toBe(false);
  });
});
