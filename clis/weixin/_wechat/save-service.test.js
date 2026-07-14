import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CommandExecutionError } from '@sovovs/bycli/errors';
import { saveArticles } from './save-service.js';

const article = (title, url = `https://mp.weixin.qq.com/s/${encodeURIComponent(title)}`) => ({ title, url, publishedAt: '2026-01-02', author: 'A' });
const html = title => `<div id="js_content"><h2>${title}</h2><p>body</p></div>`;

function memoryFs(overrides = {}) {
  const files = new Map();
  return {
    files,
    mkdirSync: vi.fn(),
    realpathSync: vi.fn(value => path.resolve(value)),
    lstatSync: vi.fn(() => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }),
    writeFileSync: vi.fn((file, body, options) => {
      if (options?.flag === 'wx' && files.has(file)) { const error = new Error('exists'); error.code = 'EEXIST'; throw error; }
      files.set(file, body);
    }),
    ...overrides,
  };
}

describe('saveArticles', () => {
  it('resolves root once, writes absolute collision-safe names, and returns uniform rows', async () => {
    const fsImpl = memoryFs();
    const result = await saveArticles({ articles: [article('same'), article('same', 'https://mp.weixin.qq.com/s/2')], accountName: 'acct', outputDir: './out', fetchArticleHtml: async item => html(item.title), fsImpl });
    expect(fsImpl.realpathSync).toHaveBeenCalledTimes(1);
    expect([...fsImpl.files.keys()].map(value => path.basename(value))).toEqual(['same.md', 'same-2.md']);
    expect(result).toEqual([
      expect.objectContaining({ title: 'same', status: 'saved', saved: expect.stringMatching(/\/same\.md$/) }),
      expect.objectContaining({ title: 'same', status: 'saved', saved: expect.stringMatching(/\/same-2\.md$/) }),
    ]);
    expect(result.every(row => path.isAbsolute(row.saved))).toBe(true);
  });

  it('continues after a per-article fetch or parse failure', async () => {
    const fsImpl = memoryFs();
    const result = await saveArticles({ articles: [article('bad'), article('empty'), article('ok')], accountName: 'acct', outputDir: '/out', fetchArticleHtml: async item => {
      if (item.title === 'bad') throw new Error('network');
      return item.title === 'empty' ? '<p>no article</p>' : html('ok');
    }, fsImpl });
    expect(result.map(row => row.status)).toEqual(['failed', 'failed', 'saved']);
    expect(result.every(row => Object.keys(row).sort().join(',') === 'saved,status,title,url')).toBe(true);
  });

  it('fails fast with CommandExecutionError on mkdir or write failure', async () => {
    const mkdirFs = memoryFs({ mkdirSync: vi.fn(() => { throw new Error('denied'); }) });
    await expect(saveArticles({ articles: [], accountName: 'a', outputDir: '/out', fetchArticleHtml: vi.fn(), fsImpl: mkdirFs })).rejects.toBeInstanceOf(CommandExecutionError);
    const writeFs = memoryFs({ writeFileSync: vi.fn(() => { throw new Error('denied'); }) });
    await expect(saveArticles({ articles: [article('a')], accountName: 'a', outputDir: '/out', fetchArticleHtml: async () => html('a'), fsImpl: writeFs })).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('rejects a symlink target instead of writing through it', async () => {
    const fsImpl = memoryFs({ lstatSync: vi.fn(() => ({ isSymbolicLink: () => true })) });
    await expect(saveArticles({ articles: [article('../escape')], accountName: 'a', outputDir: '/out', fetchArticleHtml: async () => html('a'), fsImpl })).rejects.toBeInstanceOf(CommandExecutionError);
    expect(fsImpl.writeFileSync).not.toHaveBeenCalled();
  });
});
