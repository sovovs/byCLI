import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { ArgumentError } from '@sovovs/bycli/errors';
import { MAX_FILENAME_ATTEMPTS, saveArticles } from './save-service.js';

const article = (title, url = `https://mp.weixin.qq.com/s/${encodeURIComponent(title)}`) => ({ title, url, publishedAt: '2026-01-02', author: 'A' });
const html = title => `<div id="js_content"><h2>${title}</h2><p>body</p></div>`;

function memoryFs(overrides = {}) {
  const files = new Map();
  const fds = new Map();
  let nextFd = 10;
  const dirStat = { dev: 1, ino: 1, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
  const fileStat = fd => ({ dev: 1, ino: fd, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false });
  const missing = () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; };
  return {
    files,
    mkdirSync: vi.fn(),
    realpathSync: vi.fn(value => path.resolve(value)),
    lstatSync: vi.fn(value => path.extname(value) === '.md' ? (files.has(value) ? fileStat(99) : missing()) : dirStat),
    openSync: vi.fn((file) => {
      if (path.extname(file) !== '.md') { fds.set(3, null); return 3; }
      if (files.has(file) || [...fds.values()].includes(file)) { const error = new Error('exists'); error.code = 'EEXIST'; throw error; }
      const fd = nextFd++; fds.set(fd, file); return fd;
    }),
    fstatSync: vi.fn(fd => fd === 3 ? dirStat : fileStat(fd)),
    writeSync: vi.fn((fd, body, offset, length) => { files.set(fds.get(fd), Buffer.from(body).subarray(offset, offset + length)); return length; }),
    fsyncSync: vi.fn(), closeSync: vi.fn(fd => fds.delete(fd)), unlinkSync: vi.fn(file => files.delete(file)),
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
      expect.objectContaining({ title: 'same', status: 'saved', stage: null, saved: expect.stringMatching(/\/same\.md$/) }),
      expect.objectContaining({ title: 'same', status: 'saved', stage: null, saved: expect.stringMatching(/\/same-2\.md$/) }),
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
    expect(result.every(row => Object.keys(row).sort().join(',') === 'error,saved,stage,status,title,url')).toBe(true);
    expect(result.map(row => row.stage)).toEqual(['download', 'download', null]);
    expect(result.slice(0, 2).map(row => row.error)).toEqual(['article download failed', 'invalid article content']);
  });

  it('classifies a typed transport failure as a redacted download failure', async () => {
    const fsImpl = memoryFs();
    const [row] = await saveArticles({
      articles: [article('private')], accountName: 'acct', outputDir: '/out',
      fetchArticleHtml: async () => { throw new CommandExecutionError('HTTP 500 token=secret'); }, fsImpl,
    });
    expect(row).toMatchObject({ status: 'failed', stage: 'download', error: 'article download failed' });
    expect(JSON.stringify(row)).not.toContain('secret');
  });

  it('propagates authentication-required failures without continuing to another article', async () => {
    const fsImpl = memoryFs();
    const fetchArticleHtml = vi.fn(async () => { throw new AuthRequiredError('mp.weixin.qq.com', 'verification required'); });
    await expect(saveArticles({
      articles: [article('verification'), article('later')], accountName: 'acct', outputDir: '/out', fetchArticleHtml, fsImpl,
    })).rejects.toBeInstanceOf(AuthRequiredError);
    expect(fetchArticleHtml).toHaveBeenCalledTimes(1);
  });

  it('classifies converter failures as invalid article content', async () => {
    const fsImpl = memoryFs();
    const [row] = await saveArticles({
      articles: [article('bad-content')], accountName: 'acct', outputDir: '/out',
      fetchArticleHtml: async () => html('bad-content'),
      buildMarkdown: () => { throw new Error('converter failed'); }, fsImpl,
    });
    expect(row).toMatchObject({ status: 'failed', stage: 'download', error: 'invalid article content' });
  });

  it('rejects article arrays above the absolute cap before filesystem or fetch work', async () => {
    const fsImpl = memoryFs();
    const fetchArticleHtml = vi.fn();
    await expect(saveArticles({ articles: Array.from({ length: 1001 }, () => article('x')), accountName: 'a', outputDir: '/out', fetchArticleHtml, fsImpl }))
      .rejects.toBeInstanceOf(ArgumentError);
    expect(fsImpl.mkdirSync).not.toHaveBeenCalled();
    expect(fetchArticleHtml).not.toHaveBeenCalled();
  });

  it('fails fast with CommandExecutionError on mkdir or write failure', async () => {
    const mkdirFs = memoryFs({ mkdirSync: vi.fn(() => { throw new Error('denied'); }) });
    await expect(saveArticles({ articles: [], accountName: 'a', outputDir: '/out', fetchArticleHtml: vi.fn(), fsImpl: mkdirFs })).rejects.toBeInstanceOf(CommandExecutionError);
    const writeFs = memoryFs({ writeSync: vi.fn(() => { throw new Error('denied'); }) });
    await expect(saveArticles({ articles: [article('a')], accountName: 'a', outputDir: '/out', fetchArticleHtml: async () => html('a'), fsImpl: writeFs })).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('rejects a symlink target instead of writing through it', async () => {
    const fsImpl = memoryFs({ lstatSync: vi.fn(value => path.extname(value) === '.md'
      ? ({ isSymbolicLink: () => true })
      : ({ dev: 1, ino: 1, isDirectory: () => true, isSymbolicLink: () => false })) });
    await expect(saveArticles({ articles: [article('../escape')], accountName: 'a', outputDir: '/out', fetchArticleHtml: async () => html('a'), fsImpl })).rejects.toBeInstanceOf(CommandExecutionError);
    expect(fsImpl.openSync.mock.calls.some(([file]) => path.extname(file) === '.md')).toBe(false);
  });

  it('retries the next suffix when an exclusive write loses a TOCTOU race', async () => {
    const fsImpl = memoryFs();
    const originalOpen = fsImpl.openSync.getMockImplementation();
    let raced = false;
    fsImpl.openSync.mockImplementation((file, flags, mode) => {
      if (!raced && path.extname(file) === '.md') {
        raced = true;
        const error = new Error('raced'); error.code = 'EEXIST'; throw error;
      }
      return originalOpen(file, flags, mode);
    });
    const [row] = await saveArticles({ articles: [article('race')], accountName: 'a', outputDir: '/out', fetchArticleHtml: async () => html('race'), fsImpl });
    expect(fsImpl.openSync.mock.calls.map(([file]) => path.basename(file)).filter(name => name.endsWith('.md'))).toEqual(['race.md', 'race-2.md']);
    expect(path.basename(row.saved)).toBe('race-2.md');
  });

  it('increments suffixes across consecutive races and stops at an absolute cap', async () => {
    const fsImpl = memoryFs();
    const originalOpen = fsImpl.openSync.getMockImplementation();
    fsImpl.openSync.mockImplementation((file, flags, mode) => {
      if (path.extname(file) === '.md' && fsImpl.openSync.mock.calls.filter(([value]) => path.extname(value) === '.md').length < 4) {
        const error = new Error('raced'); error.code = 'EEXIST'; throw error;
      }
      return originalOpen(file, flags, mode);
    });
    const [row] = await saveArticles({ articles: [article('race')], accountName: 'a', outputDir: '/out', fetchArticleHtml: async () => html('race'), fsImpl });
    expect(path.basename(row.saved)).toBe('race-4.md');

    const blockedFs = memoryFs();
    const blockedOpen = blockedFs.openSync.getMockImplementation();
    blockedFs.openSync.mockImplementation((file, flags, mode) => {
      if (path.extname(file) === '.md') { const error = new Error('raced'); error.code = 'EEXIST'; throw error; }
      return blockedOpen(file, flags, mode);
    });
    await expect(saveArticles({ articles: [article('blocked')], accountName: 'a', outputDir: '/out', fetchArticleHtml: async () => html('blocked'), fsImpl: blockedFs }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    expect(blockedFs.openSync.mock.calls.filter(([file]) => path.extname(file) === '.md')).toHaveLength(MAX_FILENAME_ATTEMPTS);
  });

  it('fails closed when the resolved output root is replaced during exclusive open', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-weixin-root-'));
    const root = path.join(parent, 'out');
    const moved = path.join(parent, 'moved');
    fs.mkdirSync(root);
    let replaced = false;
    let fetches = 0;
    const fsImpl = {
      ...fs,
      openSync(file, flags, mode) {
        if (!replaced && path.extname(String(file)) === '.md') {
          replaced = true;
          fs.renameSync(root, moved);
          fs.mkdirSync(root);
        }
        return fs.openSync(file, flags, mode);
      },
    };
    try {
      await expect(saveArticles({
        articles: [article('first'), article('second')], accountName: 'a', outputDir: root,
        fetchArticleHtml: async item => { fetches += 1; return html(item.title); }, fsImpl,
      })).rejects.toBeInstanceOf(CommandExecutionError);
      expect(fetches).toBe(1);
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('never redirects an opened target fd into a replacement root', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-weixin-open-fd-'));
    const root = path.join(parent, 'out');
    const moved = path.join(parent, 'moved');
    fs.mkdirSync(root);
    let replaced = false;
    const fsImpl = {
      ...fs,
      writeSync(fd, buffer, offset, length) {
        const written = fs.writeSync(fd, buffer, offset, length);
        if (!replaced) {
          replaced = true;
          fs.renameSync(root, moved);
          fs.mkdirSync(root);
        }
        return written;
      },
    };
    try {
      await expect(saveArticles({ articles: [article('opened')], accountName: 'a', outputDir: root,
        fetchArticleHtml: async () => html('opened'), fsImpl })).rejects.toBeInstanceOf(CommandExecutionError);
      expect(fs.readdirSync(root)).toEqual([]);
      expect(fs.readdirSync(moved)).toEqual(['opened.md']);
      expect(fs.readFileSync(path.join(moved, 'opened.md'), 'utf8')).toContain('# opened');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
