import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentError } from '@sovovs/bycli/errors';
import { getRegistry } from '@sovovs/bycli/registry';
import * as auth from './_wechat/auth-session.js';
import * as collections from './_wechat/collections.js';

vi.mock('./_wechat/auth-session.js');
vi.mock('./_wechat/collections.js', { spy: true });
const actualCollections = await vi.importActual('./_wechat/collections.js');
await import('./collection-detail.js');

const safeReferer = 'https://mp.weixin.qq.com/cgi-bin/appmsgalbum?action=list';
const fixture = name => JSON.parse(fs.readFileSync(new URL(`./_wechat/fixtures/${name}.json`, import.meta.url), 'utf8'));

describe('weixin collection-detail command', () => {
  const command = getRegistry().get('weixin/collection-detail');
  beforeEach(() => vi.resetAllMocks());

  it('registers the collection-detail command contract', () => {
    expect(command).toMatchObject({
      site: 'weixin',
      name: 'collection-detail',
      access: 'read',
      description: expect.stringContaining('collection'),
      domain: 'mp.weixin.qq.com',
      strategy: 'cookie',
      browser: true,
      navigateBefore: false,
    });
    expect(command.args).toEqual([
      { name: 'collectionId', positional: true, required: true, help: expect.any(String) },
      { name: 'max-pages', type: 'int', default: 5, help: expect.any(String) },
    ]);
    expect(command.columns).toEqual([
      'collectionId', 'title', 'description', 'collectionType', 'coverUrl', 'itemCount',
      'createdAt', 'updatedAt', 'settingsJson', 'itemsJson',
    ]);
  });

  it('finds the exact collection type and returns one exact projected detail row', async () => {
    const page = {};
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 'token', cookie: 'cookie' });
    collections.findCollectionById.mockResolvedValue({
      row: { collectionId: '42', collectionType: 'video' }, collectionTypeRaw: 5,
    });
    const settings = { isPaid: false };
    const items = [{ appmsgId: '1' }];
    collections.fetchCollectionDetail.mockResolvedValue({
      collectionId: '42', title: 'Course', description: null, collectionType: 'video',
      coverUrl: 'https://example.invalid/cover.jpg', itemCount: 2, createdAt: 10,
      updatedAt: 20, settings, items,
      unexposed: 'must not leak',
    });

    const result = await command.func(page, { collectionId: ' 42 ', 'max-pages': 4 });

    expect(auth.resolveBrowserCredentials).toHaveBeenCalledWith(page);
    expect(collections.findCollectionById).toHaveBeenCalledWith({
      page, token: 'token', safeReferer, collectionId: '42', pageSize: 20, maxPages: 4,
    });
    expect(collections.fetchCollectionDetail).toHaveBeenCalledWith({
      page, token: 'token', safeReferer, collectionId: '42', collectionType: 5,
      limit: 80, pageSize: 20, maxPages: 4,
    });
    expect(result).toEqual([{
      collectionId: '42', title: 'Course', description: null, collectionType: 'video',
      coverUrl: 'https://example.invalid/cover.jpg', itemCount: 2, createdAt: 10,
      updatedAt: 20, settingsJson: JSON.stringify(settings), itemsJson: JSON.stringify(items),
    }]);
    expect(Object.keys(result[0])).toEqual(command.columns);
    expect(JSON.parse(result[0].settingsJson)).toEqual(settings);
    expect(JSON.parse(result[0].itemsJson)).toEqual(items);
    expect(result[0].settingsJson).not.toContain('token');
    expect(result[0].itemsJson).not.toContain('token');
  });

  it('integrates with the real collection client and returns detail items', async () => {
    collections.findCollectionById.mockImplementation(actualCollections.findCollectionById);
    collections.fetchCollectionDetail.mockImplementation(actualCollections.fetchCollectionDetail);
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 'token', cookie: 'cookie' });
    const list = fixture('collections-list');
    const detail = fixture('collection-detail');
    const mappedDetail = actualCollections.mapCollectionDetailPayload(detail, {
      collectionId: '900000000000000001', collectionType: 0,
    });
    const page = {
      fetchJson: vi.fn(async url => new URL(url).searchParams.get('action') === 'list' ? list : detail),
    };

    const result = await command.func(page, {
      collectionId: '900000000000000001', 'max-pages': 2,
    });

    expect(result).toEqual([expect.objectContaining({ collectionId: '900000000000000001' })]);
    expect(JSON.parse(result[0].settingsJson)).toEqual(mappedDetail.settings);
    expect(JSON.parse(result[0].itemsJson)).toEqual(mappedDetail.items);
    expect(result[0].settingsJson).not.toContain('token');
    expect(result[0].itemsJson).not.toContain('token');
    expect(page.fetchJson).toHaveBeenCalledTimes(2);
    for (const [, init] of page.fetchJson.mock.calls) {
      expect(init).toEqual({ referrer: safeReferer, headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      expect(init.headers.Referer).toBeUndefined();
      expect(init.referrer).not.toContain('token');
    }
  });

  it('rejects a blank collection ID before resolving credentials', async () => {
    await expect(command.func({}, { collectionId: '   ', 'max-pages': 5 }))
      .rejects.toBeInstanceOf(ArgumentError);
    expect(auth.resolveBrowserCredentials).not.toHaveBeenCalled();
  });

  it('serializes an empty detail item list as a compact JSON array', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 'token', cookie: 'cookie' });
    collections.findCollectionById.mockResolvedValue({ row: { collectionId: '42' }, collectionTypeRaw: 0 });
    collections.fetchCollectionDetail.mockResolvedValue({
      collectionId: '42', title: 'Empty', description: null, collectionType: 'article',
      coverUrl: null, itemCount: 0, createdAt: 1, updatedAt: 2, settings: {}, items: [],
    });

    const [row] = await command.func({}, { collectionId: '42', 'max-pages': 5 });
    expect(row.settingsJson).toBe('{}');
    expect(row.itemsJson).toBe('[]');
  });

  it('throws a typed empty-result error when the exact collection is absent', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 'token', cookie: 'cookie' });
    collections.findCollectionById.mockResolvedValue(null);

    await expect(command.func({}, { collectionId: 'missing', 'max-pages': 5 }))
      .rejects.toMatchObject({ code: 'EMPTY_RESULT', message: expect.stringContaining('weixin collection-detail') });
    expect(collections.fetchCollectionDetail).not.toHaveBeenCalled();
  });

  it('rejects an invalid max-pages before resolving credentials', async () => {
    await expect(command.func({}, { collectionId: '42', 'max-pages': 0 }))
      .rejects.toBeInstanceOf(ArgumentError);
    expect(auth.resolveBrowserCredentials).not.toHaveBeenCalled();
  });

  it('rejects max-pages when the detail item limit would overflow', async () => {
    const overflowingMaxPages = Math.floor(Number.MAX_SAFE_INTEGER / 20) + 1;

    await expect(command.func({}, { collectionId: '42', 'max-pages': overflowingMaxPages }))
      .rejects.toBeInstanceOf(ArgumentError);
    expect(auth.resolveBrowserCredentials).not.toHaveBeenCalled();
    expect(collections.findCollectionById).not.toHaveBeenCalled();
  });
});
