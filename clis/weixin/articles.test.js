import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import * as auth from './_wechat/auth-session.js';
import * as apiModule from './_wechat/wechat-api.js';
import * as service from './_wechat/article-service.js';
vi.mock('./_wechat/auth-session.js');
vi.mock('./_wechat/wechat-api.js');
vi.mock('./_wechat/article-service.js');
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
    const fetchPage = vi.fn(); apiModule.createWechatApi.mockReturnValue({ fetchPage });
    service.collectArticles.mockResolvedValue({ articles: [{ title: 'T', url: 'u' }, { title: 'P', url: 'p', author: 'A', digest: '', publishedAt: null }] });
    await expect(command.func(null, { fakeid: 'f', limit: 3, 'max-pages': 2, 'auth-source': 'env' })).resolves.toEqual([
      { title: 'T', author: null, digest: null, publishedAt: null, url: 'u' }, { title: 'P', author: 'A', digest: null, publishedAt: null, url: 'p' },
    ]);
    expect(service.collectArticles).toHaveBeenCalledWith({ fakeid: 'f', fetchPage, limit: 3, maxPages: 2 });
    expect(auth.resolveBrowserCredentials).not.toHaveBeenCalled();
  });
  it('throws typed empty result', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 't', cookie: 'c' }); apiModule.createWechatApi.mockReturnValue({ fetchPage: vi.fn() });
    service.collectArticles.mockResolvedValue({ articles: [] });
    await expect(command.func({}, { fakeid: 'f' })).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
  });
});
