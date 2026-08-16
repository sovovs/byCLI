import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import * as auth from './_wechat/auth-session.js';
import * as articleIndex from './_wechat/article-index.js';
import * as runtime from './_wechat/crawler-runtime.js';
import * as sogouFallback from './_wechat/sogou-fallback.js';
vi.mock('./_wechat/auth-session.js');
vi.mock('./_wechat/article-index.js');
vi.mock('./_wechat/sogou-fallback.js', () => ({ collectSogouAccountArticles: vi.fn() }));
vi.mock('./_wechat/crawler-runtime.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, collectArticles: vi.fn() };
});
await import('./articles.js');

describe('weixin articles command', () => {
  const command = getRegistry().get('weixin/articles');
  beforeEach(() => vi.resetAllMocks());
  it('registers exact metadata', () => {
    expect(command).toMatchObject({ site: 'weixin', name: 'articles', access: 'read', strategy: 'cookie', domain: 'mp.weixin.qq.com', browser: 'conditional', columns: ['title', 'author', 'digest', 'publishedAt', 'url', 'source', 'coverage'] });
    expect(command.args.map(a => [a.name, a.positional, a.required, a.default])).toEqual([
      ['fakeid', true, true, undefined], ['name', undefined, undefined, undefined], ['limit', undefined, undefined, undefined], ['max-pages', undefined, undefined, undefined], ['auth-source', undefined, undefined, 'browser'],
    ]);
    expect(command.args.find(arg => arg.name === 'name').help)
      .toBe('Official-account name; exact case-insensitive match required for browser Sogou fallback');
    expect(command.args.find(arg => arg.name === 'auth-source').choices).toEqual(['browser', 'env']);
    expect(() => command.requiresBrowser({ 'auth-source': 'invalid' })).toThrowError(expect.objectContaining({ code: 'ARGUMENT' }));
  });
  it('orchestrates env collection without browser and maps optional fields to null', async () => {
    auth.readEnvironmentCredentials.mockReturnValue({ token: 't', cookie: 'c' });
    const fetchPage = vi.fn(); articleIndex.createArticleIndexFetcher.mockReturnValue(fetchPage);
    runtime.collectArticles.mockResolvedValue({ articles: [{ title: 'T', url: 'u' }, { title: 'P', url: 'p', author: 'A', digest: '', publishedAt: null }] });
    await expect(command.func(null, { fakeid: 'f', limit: 3, 'max-pages': 2, 'auth-source': 'env' })).resolves.toEqual([
      { title: 'T', author: null, digest: null, publishedAt: null, url: 'u', source: 'wechat', coverage: null }, { title: 'P', author: 'A', digest: null, publishedAt: null, url: 'p', source: 'wechat', coverage: null },
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
    expect(sogouFallback.collectSogouAccountArticles).not.toHaveBeenCalled();
  });

  it.each([
    ['empty primary result', { articles: [] }],
    ['primary execution failure', new CommandExecutionError('primary failed')],
  ])('falls back after %s when browser auth and exact name are available', async (_label, outcome) => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 't', cookie: 'c' });
    articleIndex.createArticleIndexFetcher.mockReturnValue(vi.fn());
    if (outcome instanceof Error) runtime.collectArticles.mockRejectedValue(outcome);
    else runtime.collectArticles.mockResolvedValue(outcome);
    sogouFallback.collectSogouAccountArticles.mockResolvedValue({
      source: 'sogou', coverage: 'search-exhausted',
      articles: [{ title: 'S', author: null, digest: 'D', publishedAt: '2026-08-16', url: 'https://mp.weixin.qq.com/s/s' }],
      resolutionFailures: [],
    });

    await expect(command.func({}, {
      fakeid: 'f', name: ' Exact Account ', limit: 2, 'max-pages': 4, 'auth-source': 'browser',
    })).resolves.toEqual([{
      title: 'S', author: null, digest: 'D', publishedAt: '2026-08-16',
      url: 'https://mp.weixin.qq.com/s/s', source: 'sogou', coverage: 'search-exhausted',
    }]);
    expect(sogouFallback.collectSogouAccountArticles).toHaveBeenCalledWith({
      page: {}, accountName: 'Exact Account', limit: 2, maxPages: 4, freshPage: true,
    });
  });

  it('does not fall back when article collection reports an authentication gate', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 't', cookie: 'c' });
    articleIndex.createArticleIndexFetcher.mockReturnValue(vi.fn());
    runtime.collectArticles.mockRejectedValue(new AuthRequiredError('mp.weixin.qq.com'));

    await expect(command.func({}, {
      fakeid: 'f', name: 'Exact Account', 'auth-source': 'browser',
    })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(sogouFallback.collectSogouAccountArticles).not.toHaveBeenCalled();
  });

  it('keeps primary-empty plus fallback-empty as EMPTY_RESULT with both contexts', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 't', cookie: 'c' });
    articleIndex.createArticleIndexFetcher.mockReturnValue(vi.fn());
    runtime.collectArticles.mockResolvedValue({ articles: [] });
    sogouFallback.collectSogouAccountArticles.mockRejectedValue(
      new EmptyResultError('fallback', 'Scanned 2 pages and reached the page cap.'),
    );

    const error = await command.func({}, {
      fakeid: 'f', name: 'Exact Account', 'auth-source': 'browser',
    }).catch(value => value);

    expect(error).toMatchObject({ code: 'EMPTY_RESULT' });
    expect(error.hint).toContain('Primary (EMPTY_RESULT)');
    expect(error.hint).toContain('fallback (EMPTY_RESULT)');
    expect(error.hint).toContain('Scanned 2 pages');
  });

  it('does not fall back for environment auth, authentication errors, or unknown failures', async () => {
    auth.readEnvironmentCredentials.mockReturnValue({ token: 't', cookie: 'c' });
    articleIndex.createArticleIndexFetcher.mockReturnValue(vi.fn());
    runtime.collectArticles.mockResolvedValue({ articles: [] });
    await expect(command.func(null, {
      fakeid: 'f', name: 'Exact Account', 'auth-source': 'env',
    })).rejects.toMatchObject({ code: 'EMPTY_RESULT' });

    auth.resolveBrowserCredentials.mockRejectedValue(new AuthRequiredError('mp.weixin.qq.com'));
    await expect(command.func({}, {
      fakeid: 'f', name: 'Exact Account', 'auth-source': 'browser',
    })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });

    auth.resolveBrowserCredentials.mockResolvedValue({ token: 't', cookie: 'c' });
    runtime.collectArticles.mockRejectedValue(new Error('unknown'));
    await expect(command.func({}, {
      fakeid: 'f', name: 'Exact Account', 'auth-source': 'browser',
    })).rejects.toThrow('unknown');
    expect(sogouFallback.collectSogouAccountArticles).not.toHaveBeenCalled();
  });
});
