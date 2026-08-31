import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import * as auth from './_wechat/auth-session.js';
import * as fingerprint from './_wechat/fingerprint.js';
import * as searchBiz from './_wechat/search-biz.js';

vi.mock('./_wechat/auth-session.js');
vi.mock('./_wechat/fingerprint.js');
vi.mock('./_wechat/search-biz.js');
await import('./get-public-account-info.js');

describe('weixin get-public-account-info command', () => {
  const command = getRegistry().get('weixin/get-public-account-info');
  beforeEach(() => vi.resetAllMocks());

  it('registers only the renamed metadata and conditional browser predicate', () => {
    expect(command).toMatchObject({ site: 'weixin', name: 'get-public-account-info', access: 'read', strategy: 'intercept', domain: 'mp.weixin.qq.com', browser: 'conditional', columns: ['nickname', 'fakeid', 'alias'] });
    expect(getRegistry().has('weixin/accounts')).toBe(false);
    expect(command.requiresBrowser({ 'auth-source': 'browser' })).toBe(true);
    expect(command.requiresBrowser({ 'auth-source': 'env' })).toBe(false);
    expect(() => command.requiresBrowser({ 'auth-source': 'invalid' })).toThrowError(expect.objectContaining({ code: 'ARGUMENT' }));
    expect(command.args).toEqual([
      expect.objectContaining({ name: 'query', positional: true, required: true }),
      expect.objectContaining({ name: 'limit', default: 10 }),
      expect.objectContaining({ name: 'auth-source', default: 'browser' }),
    ]);
    expect(command.args.find(arg => arg.name === 'auth-source').choices).toEqual(['browser', 'env']);
  });

  it('uses browser credentials, captures fingerprint, and returns all similar accounts', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 't', cookie: 'c' });
    fingerprint.captureSearchBizFingerprint.mockResolvedValue('fp');
    searchBiz.executeSearchBiz.mockResolvedValue([{ nickname: 'Acme', fakeid: '1' }, { nickname: 'Acme Lab', fakeid: '2', alias: 'lab' }]);
    const page = {};
    await expect(command.func(page, { query: 'Acme', limit: 2, 'auth-source': 'browser' })).resolves.toEqual([
      { nickname: 'Acme', fakeid: '1', alias: null }, { nickname: 'Acme Lab', fakeid: '2', alias: 'lab' },
    ]);
    expect(searchBiz.executeSearchBiz).toHaveBeenCalledWith({ page, source: 'browser', credentials: { token: 't', cookie: 'c', fingerprint: 'fp' }, query: 'Acme', limit: 2 });
  });

  it('uses env credentials without touching the browser and rejects empty results', async () => {
    auth.readEnvironmentCredentials.mockReturnValue({ token: 't', cookie: 'c', fingerprint: 'fp' });
    searchBiz.executeSearchBiz.mockResolvedValue([]);
    await expect(command.func(null, { query: 'x', 'auth-source': 'env' })).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
    expect(auth.readEnvironmentCredentials).toHaveBeenCalledWith(true);
    expect(auth.resolveBrowserCredentials).not.toHaveBeenCalled();
    expect(fingerprint.captureSearchBizFingerprint).not.toHaveBeenCalled();
  });
});
