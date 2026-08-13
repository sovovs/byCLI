import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentError } from '@sovovs/bycli/errors';
import { getRegistry } from '@sovovs/bycli/registry';
import * as auth from './_wechat/auth-session.js';
import * as collections from './_wechat/collections.js';

vi.mock('./_wechat/auth-session.js');
vi.mock('./_wechat/collections.js', { spy: true });
const actualCollections = await vi.importActual('./_wechat/collections.js');
await import('./collections.js');

const safeReferer = 'https://mp.weixin.qq.com/cgi-bin/appmsgalbum?action=list';

describe('weixin collections command', () => {
  const command = getRegistry().get('weixin/collections');
  beforeEach(() => vi.resetAllMocks());

  it('registers the collection-list command contract', () => {
    expect(command).toMatchObject({
      site: 'weixin',
      name: 'collections',
      access: 'read',
      description: expect.stringContaining('collection'),
      domain: 'mp.weixin.qq.com',
      strategy: 'cookie',
      browser: true,
      navigateBefore: false,
    });
    expect(command.args).toEqual([
      { name: 'limit', type: 'int', default: 20, help: expect.any(String) },
      { name: 'max-pages', type: 'int', default: 5, help: expect.any(String) },
    ]);
    expect(command.columns).toEqual([
      'collectionId', 'title', 'collectionType', 'itemCount', 'views', 'continuousRead',
      'isUpdating', 'isBanned', 'isPaid', 'createdAt', 'updatedAt', 'coverUrl',
    ]);
  });

  it('uses browser credentials and returns an exact list-row projection', async () => {
    const page = {};
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 'token', cookie: 'cookie' });
    collections.collectCollections.mockResolvedValue([{
      collectionId: '7', title: 'Series', collectionType: 'article', itemCount: 2,
      views: 30, continuousRead: true, isUpdating: false, isBanned: false,
      isPaid: true, createdAt: 10, updatedAt: 11, coverUrl: null,
      unexposed: 'must not leak',
    }]);

    const result = await command.func(page, { limit: 9, 'max-pages': 3 });

    expect(auth.resolveBrowserCredentials).toHaveBeenCalledWith(page);
    expect(collections.collectCollections).toHaveBeenCalledWith({
      page, token: 'token', safeReferer, limit: 9, pageSize: 20, maxPages: 3,
    });
    expect(result).toEqual([{
      collectionId: '7', title: 'Series', collectionType: 'article', itemCount: 2,
      views: 30, continuousRead: true, isUpdating: false, isBanned: false,
      isPaid: true, createdAt: 10, updatedAt: 11, coverUrl: null,
    }]);
    expect(Object.keys(result[0])).toEqual(command.columns);
  });

  it('integrates with the real collection client using a safe referer', async () => {
    collections.collectCollections.mockImplementation(actualCollections.collectCollections);
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 'token', cookie: 'cookie' });
    const page = {
      fetchJson: vi.fn().mockResolvedValue({
        base_resp: { ret: 0 },
        list_resp: {
          total: 1,
          items: [{
            id: '7', title: 'Series', type: 0, total: 2, uv: 30,
            continous_read_on: 1, is_updating: 0, is_ban: 0, need_pay: 1,
            create_time: 10, update_time: 11, cover_url: null,
          }],
        },
      }),
    };

    await expect(command.func(page, { limit: 20, 'max-pages': 5 }))
      .resolves.toEqual([expect.objectContaining({ collectionId: '7', title: 'Series' })]);
    expect(page.fetchJson).toHaveBeenCalledWith(
      expect.stringContaining('action=list'),
      { referrer: safeReferer, headers: { 'X-Requested-With': 'XMLHttpRequest' } },
    );
    expect(page.fetchJson.mock.calls[0][1].headers.Referer).toBeUndefined();
    expect(page.fetchJson.mock.calls[0][1].referrer).not.toContain('token');
  });

  it('throws a typed empty-result error when no collections exist', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 'token', cookie: 'cookie' });
    collections.collectCollections.mockResolvedValue([]);

    await expect(command.func({}, { limit: 20, 'max-pages': 5 }))
      .rejects.toMatchObject({ code: 'EMPTY_RESULT', message: expect.stringContaining('weixin collections') });
  });

  it.each([
    ['limit', { limit: 0, 'max-pages': 5 }],
    ['max-pages', { limit: 20, 'max-pages': 1.5 }],
  ])('rejects invalid %s before resolving credentials', async (_label, args) => {
    await expect(command.func({}, args)).rejects.toBeInstanceOf(ArgumentError);
    expect(auth.resolveBrowserCredentials).not.toHaveBeenCalled();
    expect(collections.collectCollections).not.toHaveBeenCalled();
  });
});
