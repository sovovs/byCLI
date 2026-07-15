import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import * as auth from './_wechat/auth-session.js';
import * as apiModule from './_wechat/wechat-api.js';
import * as articleService from './_wechat/article-service.js';
import * as saveService from './_wechat/save-service.js';
vi.mock('./_wechat/auth-session.js'); vi.mock('./_wechat/wechat-api.js'); vi.mock('./_wechat/article-service.js'); vi.mock('./_wechat/save-service.js');
await import('./save-articles.js');

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
