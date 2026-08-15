import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import * as auth from './_wechat/auth-session.js';
import * as articleIndex from './_wechat/article-index.js';
import * as runtime from './_wechat/crawler-runtime.js';
vi.mock('./_wechat/auth-session.js');
vi.mock('./_wechat/article-index.js');
vi.mock('./_wechat/crawler-runtime.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, collectArticles: vi.fn() };
});
await import('./articles.js');

describe('weixin articles command', () => {
  const command = getRegistry().get('weixin/articles');
  beforeEach(() => vi.resetAllMocks());
  it('registers exact metadata', () => {
    expect(command).toMatchObject({ site: 'weixin', name: 'articles', access: 'read', strategy: 'cookie', domain: 'mp.weixin.qq.com', browser: 'conditional', columns: ['title', 'author', 'digest', 'publishedAt', 'url'] });
    expect(command.args.map(a => [a.name, a.positional, a.required, a.default])).toEqual([
      ['fakeid', true, true, undefined], ['name', undefined, undefined, undefined], ['limit', undefined, undefined, undefined], ['max-pages', undefined, undefined, undefined], ['auth-source', undefined, undefined, 'browser'],
    ]);
    expect(command.args.find(arg => arg.name === 'auth-source').choices).toEqual(['browser', 'env']);
    expect(() => command.requiresBrowser({ 'auth-source': 'invalid' })).toThrowError(expect.objectContaining({ code: 'ARGUMENT' }));
  });
  it('orchestrates env collection without browser and maps optional fields to null', async () => {
    auth.readEnvironmentCredentials.mockReturnValue({ token: 't', cookie: 'c' });
    const fetchPage = vi.fn(); articleIndex.createArticleIndexFetcher.mockReturnValue(fetchPage);
    runtime.collectArticles.mockResolvedValue({ articles: [{ title: 'T', url: 'u' }, { title: 'P', url: 'p', author: 'A', digest: '', publishedAt: null }] });
    await expect(command.func(null, { fakeid: 'f', limit: 3, 'max-pages': 2, 'auth-source': 'env' })).resolves.toEqual([
      { title: 'T', author: null, digest: null, publishedAt: null, url: 'u' }, { title: 'P', author: 'A', digest: null, publishedAt: null, url: 'p' },
    ]);
    expect(runtime.collectArticles).toHaveBeenCalledWith({ fakeid: 'f', fetchPage, limit: 3, maxPages: 2 });
    expect(articleIndex.createArticleIndexFetcher).toHaveBeenCalledWith({
      page: null, source: 'env', credentials: { token: 't', cookie: 'c' },
    });
    expect(auth.resolveBrowserCredentials).not.toHaveBeenCalled();
  });
  it('throws typed empty result', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 't', cookie: 'c' });
    articleIndex.createArticleIndexFetcher.mockReturnValue(vi.fn());
    runtime.collectArticles.mockResolvedValue({ articles: [] });
    await expect(command.func({}, { fakeid: 'f' })).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
  });
});
