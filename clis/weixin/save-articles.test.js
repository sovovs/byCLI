import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import { CommandExecutionError } from '@sovovs/bycli/errors';
import * as auth from './_wechat/auth-session.js';
import * as apiModule from './_wechat/wechat-api.js';
import * as articleService from './_wechat/article-service.js';
import * as saveService from './_wechat/save-service.js';
vi.mock('./_wechat/auth-session.js'); vi.mock('./_wechat/wechat-api.js'); vi.mock('./_wechat/article-service.js'); vi.mock('./_wechat/save-service.js');
const { fetchArticleHtml } = await import('./save-articles.js');
const actualArticleService = await vi.importActual('./_wechat/article-service.js');

describe('weixin save-articles command', () => {
  const command = getRegistry().get('weixin/save-articles');
  beforeEach(() => vi.resetAllMocks());
  it('registers exact write metadata', () => {
    expect(command).toMatchObject({ site: 'weixin', name: 'save-articles', access: 'write', strategy: 'cookie', domain: 'mp.weixin.qq.com', browser: 'conditional', columns: ['title', 'status', 'stage', 'path', 'error', 'url'] });
    expect(command.args.map(a => [a.name, a.positional, a.required, a.default])).toEqual([
      ['fakeid', true, true, undefined], ['name', undefined, undefined, undefined], ['output', undefined, undefined, './weixin-articles'], ['limit', undefined, undefined, undefined], ['max-pages', undefined, undefined, undefined], ['auth-source', undefined, undefined, 'browser'],
    ]);
    expect(command.args.find(arg => arg.name === 'auth-source').choices).toEqual(['browser', 'env']);
    expect(() => command.requiresBrowser({ 'auth-source': 'invalid' })).toThrowError(expect.objectContaining({ code: 'ARGUMENT' }));
  });
  it('collects then saves and normalizes partial save rows', async () => {
    auth.readEnvironmentCredentials.mockReturnValue({ token: 't', cookie: 'c' }); const fetchPage = vi.fn(); apiModule.createWechatApi.mockReturnValue({ fetchPage });
    const articles = [{ title: 'A', url: 'u' }, { title: 'B', url: 'v' }]; articleService.collectArticles.mockResolvedValue({ articles });
    saveService.saveArticles.mockResolvedValue([{ title: 'A', status: 'saved', stage: null, saved: '/x/a.md', error: '', url: 'u' }, { title: 'B', status: 'failed', stage: 'download', saved: '', error: 'article download failed', url: 'v' }]);
    await expect(command.func(null, { fakeid: 'f', name: 'Acct', output: '/x', limit: 2, 'max-pages': 3, 'auth-source': 'env' })).resolves.toEqual([
      { title: 'A', status: 'saved', stage: null, path: '/x/a.md', error: null, url: 'u' }, { title: 'B', status: 'failed', stage: 'download', path: null, error: 'article download failed', url: 'v' },
    ]);
    expect(saveService.saveArticles).toHaveBeenCalledWith(expect.objectContaining({ articles, accountName: 'Acct', outputDir: '/x', fetchArticleHtml: expect.any(Function) }));
    expect(articleService.collectArticles).toHaveBeenCalledWith({ fakeid: 'f', fetchPage, limit: 2, maxPages: 3 });
    expect(auth.resolveBrowserCredentials).not.toHaveBeenCalled();
  });
});

describe('fetchArticleHtml', () => {
  beforeEach(() => articleService.isTrustedWechatArticleUrl.mockImplementation(actualArticleService.isTrustedWechatArticleUrl));
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
