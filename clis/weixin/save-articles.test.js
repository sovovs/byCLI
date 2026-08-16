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
  return { ...actual, collectArticles: vi.fn(), saveArticles: vi.fn() };
});
const { fetchArticleHtml, fetchArticleHtmlInBrowser, createArticleHtmlDownloader } = await import('./save-articles.js');

describe('weixin save-articles command', () => {
  const command = getRegistry().get('weixin/save-articles');
  beforeEach(() => vi.resetAllMocks());
  it('registers exact write metadata', () => {
    expect(command).toMatchObject({ site: 'weixin', name: 'save-articles', access: 'write', strategy: 'cookie', domain: 'mp.weixin.qq.com', browser: 'conditional', columns: ['title', 'status', 'stage', 'path', 'error', 'url', 'source', 'coverage'] });
    expect(command.args.map(a => [a.name, a.positional, a.required, a.default])).toEqual([
      ['fakeid', true, true, undefined], ['name', undefined, undefined, undefined], ['output', undefined, undefined, './weixin-articles'], ['limit', undefined, undefined, undefined], ['max-pages', undefined, undefined, undefined], ['auth-source', undefined, undefined, 'browser'],
    ]);
    expect(command.args.find(arg => arg.name === 'name').help)
      .toBe('Official-account name; exact case-insensitive match required for browser Sogou fallback');
    expect(command.args.find(arg => arg.name === 'auth-source').choices).toEqual(['browser', 'env']);
    expect(() => command.requiresBrowser({ 'auth-source': 'invalid' })).toThrowError(expect.objectContaining({ code: 'ARGUMENT' }));
  });
  it('collects then saves and normalizes partial save rows', async () => {
    auth.readEnvironmentCredentials.mockReturnValue({ token: 't', cookie: 'c' }); const fetchPage = vi.fn(); articleIndex.createArticleIndexFetcher.mockReturnValue(fetchPage);
    const articles = [{ title: 'A', url: 'u' }, { title: 'B', url: 'v' }]; runtime.collectArticles.mockResolvedValue({ articles });
    runtime.saveArticles.mockResolvedValue([{ title: 'A', status: 'saved', stage: null, saved: '/x/a.md', error: '', url: 'u' }, { title: 'B', status: 'failed', stage: 'download', saved: '', error: 'article download failed', url: 'v' }]);
    await expect(command.func(null, { fakeid: 'f', name: 'Acct', output: '/x', limit: 2, 'max-pages': 3, 'auth-source': 'env' })).resolves.toEqual([
      { title: 'A', status: 'saved', stage: null, path: '/x/a.md', error: null, url: 'u', source: 'wechat', coverage: null }, { title: 'B', status: 'failed', stage: 'download', path: null, error: 'article download failed', url: 'v', source: 'wechat', coverage: null },
    ]);
    expect(runtime.saveArticles).toHaveBeenCalledWith(expect.objectContaining({ articles, accountName: 'Acct', outputDir: '/x', fetchArticleHtml: expect.any(Function), buildMarkdown: expect.any(Function), existingFilePolicy: 'suffix' }));
    expect(runtime.collectArticles).toHaveBeenCalledWith({ fakeid: 'f', fetchPage, limit: 2, maxPages: 3 });
    expect(articleIndex.createArticleIndexFetcher).toHaveBeenCalledWith({
      page: null, source: 'env', credentials: { token: 't', cookie: 'c' },
    });
    const markdown = runtime.saveArticles.mock.calls[0][0].buildMarkdown({
      title: 'Article', author: 'Author', publishedAt: '2024-01-02', digest: 'Digest', url: 'https://mp.weixin.qq.com/s/article',
    }, '<div id="js_content"><p>body</p></div>');
    expect(markdown).toContain('body');
    expect(markdown).toContain('Acct');
    expect(markdown).toContain('Author');
    expect(markdown).toContain('2024\\-01\\-02');
    expect(markdown).toContain('Digest');
    expect(markdown).toContain('> 原文链接: <https://mp.weixin.qq.com/s/article>');
    expect(auth.resolveBrowserCredentials).not.toHaveBeenCalled();
  });

  it('wires Node-first browser fallback into browser-authenticated saves', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 't', cookie: 'c' });
    const fetchPage = vi.fn();
    articleIndex.createArticleIndexFetcher.mockReturnValue(fetchPage);
    const article = { title: 'A', url: 'https://mp.weixin.qq.com/s/article' };
    runtime.collectArticles.mockResolvedValue({ articles: [article] });
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({
        finalUrl: article.url,
        html: '<html><div id="js_content">browser</div></html>',
        byteLength: 50,
        accessIssue: '',
      }),
    };
    const nodeFetch = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: '/mp/wappoc_appmsgcaptcha' },
    }));
    runtime.saveArticles.mockImplementation(async options => {
      const html = await options.fetchArticleHtml(article);
      return [{ title: 'A', status: html.includes('browser') ? 'saved' : 'failed', stage: null, saved: '/x/a.md', error: '', url: article.url }];
    });
    vi.stubGlobal('fetch', nodeFetch);
    try {
      await expect(command.func(page, {
        fakeid: 'f', output: '/x', limit: 1, 'max-pages': 1, 'auth-source': 'browser',
      })).resolves.toEqual([
        { title: 'A', status: 'saved', stage: null, path: '/x/a.md', error: null, url: article.url, source: 'wechat', coverage: null },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(nodeFetch).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith(article.url);
  });

  it('merges ordered resolution failures with successfully saved Sogou fallback rows', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 't', cookie: 'c' });
    articleIndex.createArticleIndexFetcher.mockReturnValue(vi.fn());
    runtime.collectArticles.mockResolvedValue({ articles: [] });
    sogouFallback.collectSogouAccountArticles.mockResolvedValue({
      source: 'sogou', coverage: 'search-exhausted',
      articles: [{
        title: 'Good', author: null, digest: 'D', publishedAt: '2026-08-15',
        url: 'https://mp.weixin.qq.com/s/good', order: 1,
      }],
      resolutionFailures: [{
        title: 'Broken', status: 'failed', stage: 'resolve', error: 'bad redirect',
        url: 'https://weixin.sogou.com/link?url=broken', order: 0,
      }],
    });
    runtime.saveArticles.mockResolvedValue([{
      title: 'Good', status: 'saved', stage: null, saved: '/x/good.md', error: '',
      url: 'https://mp.weixin.qq.com/s/good',
    }]);

    await expect(command.func({}, {
      fakeid: 'f', name: ' Exact Account ', output: '/x', limit: 2,
      'max-pages': 4, 'auth-source': 'browser',
    })).resolves.toEqual([
      {
        title: 'Broken', status: 'failed', stage: 'resolve', path: null,
        error: 'bad redirect', url: 'https://weixin.sogou.com/link?url=broken',
        source: 'sogou', coverage: 'search-exhausted',
      },
      {
        title: 'Good', status: 'saved', stage: null, path: '/x/good.md', error: null,
        url: 'https://mp.weixin.qq.com/s/good', source: 'sogou', coverage: 'search-exhausted',
      },
    ]);
    expect(sogouFallback.collectSogouAccountArticles).toHaveBeenCalledWith({
      page: {}, accountName: 'Exact Account', limit: 2, maxPages: 4, resolutionPolicy: 'rows',
    });
    expect(runtime.saveArticles).toHaveBeenCalledWith(expect.objectContaining({
      articles: [expect.objectContaining({ title: 'Good' })],
    }));
  });

  it('stops globally when Sogou fallback requires verification', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 't', cookie: 'c' });
    articleIndex.createArticleIndexFetcher.mockReturnValue(vi.fn());
    runtime.collectArticles.mockResolvedValue({ articles: [] });
    sogouFallback.collectSogouAccountArticles.mockRejectedValue(
      new AuthRequiredError('weixin.sogou.com'),
    );

    await expect(command.func({}, {
      fakeid: 'f', name: 'Exact Account', output: '/x', 'auth-source': 'browser',
    })).rejects.toBeInstanceOf(AuthRequiredError);
    expect(runtime.saveArticles).not.toHaveBeenCalled();
  });

  it('does not fall back when article collection reports an authentication gate', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 't', cookie: 'c' });
    articleIndex.createArticleIndexFetcher.mockReturnValue(vi.fn());
    runtime.collectArticles.mockRejectedValue(new AuthRequiredError('mp.weixin.qq.com'));

    await expect(command.func({}, {
      fakeid: 'f', name: 'Exact Account', output: '/x', 'auth-source': 'browser',
    })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(sogouFallback.collectSogouAccountArticles).not.toHaveBeenCalled();
    expect(runtime.saveArticles).not.toHaveBeenCalled();
  });

  it('keeps primary-empty plus fallback-empty as EMPTY_RESULT with both contexts', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 't', cookie: 'c' });
    articleIndex.createArticleIndexFetcher.mockReturnValue(vi.fn());
    runtime.collectArticles.mockResolvedValue({ articles: [] });
    sogouFallback.collectSogouAccountArticles.mockRejectedValue(
      new EmptyResultError('fallback', 'Scanned 2 pages and reached the page cap.'),
    );

    const error = await command.func({}, {
      fakeid: 'f', name: 'Exact Account', output: '/x', 'auth-source': 'browser',
    }).catch(value => value);

    expect(error).toMatchObject({ code: 'EMPTY_RESULT' });
    expect(error.hint).toContain('Primary (EMPTY_RESULT)');
    expect(error.hint).toContain('fallback (EMPTY_RESULT)');
    expect(error.hint).toContain('Scanned 2 pages');
    expect(runtime.saveArticles).not.toHaveBeenCalled();
  });
});

describe('fetchArticleHtml', () => {
  const response = (body, init = {}) => new Response(body, { status: 200, ...init });

  it.each([
    'http://mp.weixin.qq.com/s/x', 'data:text/html,x', 'file:///etc/passwd',
    'https://localhost/s/x', 'https://mp.weixin.qq.com.evil.test/s/x',
  ])('rejects an initial untrusted URL before fetch: %s', async url => {
    const fetchImpl = vi.fn();
    await expect(fetchArticleHtml({ url }, { fetchImpl })).rejects.toBeInstanceOf(CommandExecutionError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('follows a same-origin redirect manually', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/s/final' } }))
      .mockResolvedValueOnce(response('<div>ok</div>'));
    await expect(fetchArticleHtml({ url: 'https://mp.weixin.qq.com/s/start' }, { fetchImpl }))
      .resolves.toBe('<div>ok</div>');
    expect(fetchImpl.mock.calls.map(([url, options]) => [url, options.redirect]))
      .toEqual([['https://mp.weixin.qq.com/s/start', 'manual'], ['https://mp.weixin.qq.com/s/final', 'manual']]);
  });

  it.each([
    ['cross-origin', '/s/start', 'https://evil.test/steal'],
    ['missing location', '/s/start', null],
  ])('rejects %s redirects without fetching a target', async (_label, path, location) => {
    const headers = location ? { location } : {};
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers }));
    await expect(fetchArticleHtml({ url: `https://mp.weixin.qq.com${path}` }, { fetchImpl }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects redirect loops and a sixth redirect', async () => {
    const loopFetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: '/s/start' } }));
    await expect(fetchArticleHtml({ url: 'https://mp.weixin.qq.com/s/start' }, { fetchImpl: loopFetch }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    expect(loopFetch).toHaveBeenCalledTimes(1);

    const chainFetch = vi.fn((_url, _options) => Promise.resolve(new Response(null, {
      status: 302, headers: { location: `/s/${chainFetch.mock.calls.length}` },
    })));
    await expect(fetchArticleHtml({ url: 'https://mp.weixin.qq.com/s/0' }, { fetchImpl: chainFetch }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    expect(chainFetch).toHaveBeenCalledTimes(6);
  });

  it('rejects oversized content-length without reading the body', async () => {
    const getReader = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200,
      headers: new Headers({ 'content-length': String(10 * 1024 * 1024 + 1) }), body: { getReader } });
    await expect(fetchArticleHtml({ url: 'https://mp.weixin.qq.com/s/x' }, { fetchImpl }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    expect(getReader).not.toHaveBeenCalled();
  });

  it('cancels a chunked body immediately after it exceeds the cap', async () => {
    const cancel = vi.fn();
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(6 * 1024 * 1024) })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(5 * 1024 * 1024) });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(),
      body: { getReader: () => ({ read, cancel }) } });
    await expect(fetchArticleHtml({ url: 'https://mp.weixin.qq.com/s/x' }, { fetchImpl }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('fetchArticleHtmlInBrowser', () => {
  it('loads a trusted article through the browser and returns bounded HTML', async () => {
    const url = 'https://mp.weixin.qq.com/s/article';
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({ finalUrl: url, html: '<html><div id="js_content">ok</div></html>', byteLength: 47, accessIssue: '' }),
    };

    await expect(fetchArticleHtmlInBrowser({ url }, page)).resolves.toContain('js_content');
    expect(page.goto).toHaveBeenCalledWith(url);
    expect(page.wait).toHaveBeenCalledWith(5);
  });

  it('rejects an environment verification page with AuthRequiredError', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({ finalUrl: 'https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha', html: '', byteLength: 0, accessIssue: 'environment verification required' }),
    };
    await expect(fetchArticleHtmlInBrowser({ url: 'https://mp.weixin.qq.com/s/article' }, page))
      .rejects.toBeInstanceOf(AuthRequiredError);
  });

  it.each([
    [{ finalUrl: 'https://evil.test/s/article', html: '<html></html>', byteLength: 13, accessIssue: '' }, 'non-article final URL'],
    [{ finalUrl: 'https://mp.weixin.qq.com/s/article', html: '', byteLength: 10 * 1024 * 1024 + 1, tooLarge: true, accessIssue: '' }, 'oversized HTML'],
  ])('rejects browser %s results', async (result) => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(result),
    };
    await expect(fetchArticleHtmlInBrowser({ url: 'https://mp.weixin.qq.com/s/article' }, page))
      .rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('rechecks the returned HTML size outside the page context', async () => {
    const url = 'https://mp.weixin.qq.com/s/article';
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({
        finalUrl: url,
        html: 'x'.repeat(10 * 1024 * 1024 + 1),
        byteLength: 1,
        tooLarge: false,
        accessIssue: '',
      }),
    };

    await expect(fetchArticleHtmlInBrowser({ url }, page))
      .rejects.toBeInstanceOf(CommandExecutionError);
  });
});

describe('createArticleHtmlDownloader', () => {
  const article = { url: 'https://mp.weixin.qq.com/s/article' };

  it('uses Node HTML directly when the first attempt succeeds', async () => {
    const nodeFetcher = vi.fn().mockResolvedValue('<html>node</html>');
    const browserFetcher = vi.fn();
    const downloader = createArticleHtmlDownloader({
      authSource: 'browser', page: {}, nodeFetcher, browserFetcher,
    });
    await expect(downloader(article)).resolves.toBe('<html>node</html>');
    expect(browserFetcher).not.toHaveBeenCalled();
  });

  it('falls back to the browser after a Node download failure in browser mode', async () => {
    const nodeError = new CommandExecutionError('Article redirect was rejected');
    const nodeFetcher = vi.fn().mockRejectedValue(nodeError);
    const browserFetcher = vi.fn().mockResolvedValue('<html>browser</html>');
    const page = {};
    const downloader = createArticleHtmlDownloader({
      authSource: 'browser', page, nodeFetcher, browserFetcher,
    });
    await expect(downloader(article)).resolves.toBe('<html>browser</html>');
    expect(browserFetcher).toHaveBeenCalledWith(article, page);
  });

  it('keeps env authentication Node-only when the download fails', async () => {
    const nodeError = new CommandExecutionError('Article redirect was rejected');
    const nodeFetcher = vi.fn().mockRejectedValue(nodeError);
    const browserFetcher = vi.fn();
    const downloader = createArticleHtmlDownloader({
      authSource: 'env', page: null, nodeFetcher, browserFetcher,
    });
    await expect(downloader(article)).rejects.toBe(nodeError);
    expect(browserFetcher).not.toHaveBeenCalled();
  });
});
