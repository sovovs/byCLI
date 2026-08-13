import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import {
  buildCollectionDetailUrl,
  buildCollectionsUrl,
  collectCollections,
  collectionTypeName,
  fetchCollectionDetail,
  findCollectionById,
  mapCollectionDetailPayload,
  mapCollectionsPayload,
} from './collections.js';

const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const token = 'token-secret';
const safeReferer = 'https://mp.weixin.qq.com/cgi-bin/appmsgalbum?action=list';

function query(url) {
  const parsed = new URL(url);
  expect(parsed.origin + parsed.pathname).toBe('https://mp.weixin.qq.com/cgi-bin/appmsgalbummgr');
  return Object.fromEntries(parsed.searchParams);
}

describe('URL builders', () => {
  it('builds the exact collections list query', () => {
    expect(query(buildCollectionsUrl({ token, begin: 20, count: 10 }))).toEqual({
      action: 'list', begin: '20', count: '10', latest: '1', type: '', token,
      lang: 'zh_CN', f: 'json', ajax: '1',
    });
  });

  it('builds the exact numeric collection detail query', () => {
    expect(query(buildCollectionDetailUrl({ token, collectionId: '9001', collectionType: 5, begin: 2, count: 20 }))).toEqual({
      action: 'edit', type: '5', id: '9001', begin: '2', count: '20', token,
      lang: 'zh_CN', f: 'json', ajax: '1',
    });
  });

  it.each([
    ['list begin', () => buildCollectionsUrl({ token, begin: -1, count: 20 })],
    ['list count', () => buildCollectionsUrl({ token, begin: 0, count: 1.5 })],
    ['null list count', () => buildCollectionsUrl({ token, begin: 0, count: null })],
    ['null detail count', () => buildCollectionDetailUrl({ token, collectionId: '1', collectionType: 0, begin: 0, count: null })],
    ['numeric list token', () => buildCollectionsUrl({ token: 1234, begin: 0, count: 20 })],
    ['numeric detail token', () => buildCollectionDetailUrl({ token: 1234, collectionId: '1', collectionType: 0, begin: 0, count: 20 })],
    ['lone surrogate list token', () => buildCollectionsUrl({ token: '\ud800', begin: 0, count: 20 })],
    ['lone surrogate detail token', () => buildCollectionDetailUrl({ token: '\ud800', collectionId: '1', collectionType: 0, begin: 0, count: 20 })],
    ['detail type', () => buildCollectionDetailUrl({ token, collectionId: '1', collectionType: 'video', begin: 0, count: 20 })],
  ])('rejects invalid %s values', (_label, invoke) => {
    expect(invoke).toThrow(ArgumentError);
  });
});

describe('payload mapping', () => {
  it('names known and unknown collection types', () => {
    expect([0, 5, 7, 8, 99].map(collectionTypeName)).toEqual(['article', 'video', 'audio', 'image', 'unknown:99']);
  });

  it('maps a list payload with stable field order and types', () => {
    const result = mapCollectionsPayload(fixture('collections-list'));
    expect(result.total).toBe(3);
    expect(Object.keys(result.rows[0])).toEqual([
      'collectionId', 'title', 'collectionType', 'itemCount', 'views', 'continuousRead',
      'isUpdating', 'isBanned', 'isPaid', 'createdAt', 'updatedAt', 'coverUrl',
    ]);
    expect(result.rows[0]).toEqual({
      collectionId: '900000000000000001', title: 'Synthetic article collection', collectionType: 'article',
      itemCount: 12, views: 3456, continuousRead: true, isUpdating: true, isBanned: false,
      isPaid: true, createdAt: '2023-11-14T22:13:20.000Z', updatedAt: '2023-11-14T23:13:20.000Z',
      coverUrl: 'https://example.invalid/article.jpg',
    });
    expect(result.rows[1].collectionId).toBe('9002');
  });

  it('maps detail settings and items while preserving order and nulling absent optionals', () => {
    const result = mapCollectionDetailPayload(fixture('collection-detail'), {
      collectionId: '900000000000000001', collectionType: 0,
    });
    expect(Reflect.ownKeys(result)).toEqual([
      'collectionId', 'title', 'description', 'collectionType', 'coverUrl', 'itemCount',
      'createdAt', 'updatedAt', 'settings', 'items',
    ]);
    expect(result.settings).toEqual({
      continuousRead: true, isUpdating: true, isReverse: false, isNumbered: true,
      isPaid: true, fee: 6.5, isBanned: false, canModifyTitle: true, sendQuota: 4,
      subtype: 2, themeColor: '#07c160', updateFrequency: { month: 1 },
    });
    expect(result.items.map(item => item.title)).toEqual(['Synthetic first item', 'Synthetic second item']);
    expect(result.items[0]).toEqual({
      appmsgId: '70001', itemIndex: 1, position: 1, title: 'Synthetic first item',
      link: 'https://example.invalid/items/1', coverUrl: 'https://example.invalid/items/1.jpg',
      createdAt: '2023-11-14T22:15:00.000Z', type: 0, status: 2, failReason: '', sharePageType: 1,
      isPaid: true, payAlbumId: 'pay-synthetic-1', wecoinCount: 10,
    });
    expect(result.items[1]).toMatchObject({
      appmsgId: '70002', position: 2, failReason: null, sharePageType: null,
      isPaid: null, payAlbumId: null, wecoinCount: null,
    });
  });

  it.each([200040, 200003])('maps auth ret %i to AuthRequiredError', ret => {
    expect(() => mapCollectionsPayload({ base_resp: { ret }, list_resp: { total: 0, items: [] } }))
      .toThrow(AuthRequiredError);
    expect(() => mapCollectionDetailPayload({ base_resp: { ret } }, { collectionId: '1', collectionType: 0 }))
      .toThrow(AuthRequiredError);
  });

  it.each([
    null,
    { base_resp: { ret: 9 }, list_resp: { total: 0, items: [] } },
    { base_resp: { ret: 0 }, list_resp: { total: 0, items: {} } },
    { base_resp: { ret: 0 }, list_resp: { total: -1, items: [] } },
    { base_resp: { ret: 0 }, list_resp: { total: 1, items: [{ id: '', type: 0 }] } },
  ])('rejects malformed or unsuccessful list payloads', payload => {
    expect(() => mapCollectionsPayload(payload)).toThrow(CommandExecutionError);
  });

  it('rejects malformed detail payloads and mismatched IDs', () => {
    expect(() => mapCollectionDetailPayload({ base_resp: { ret: 0 }, edit_resp: {} }, { collectionId: '1', collectionType: 0 }))
      .toThrow(CommandExecutionError);
    const mismatched = fixture('collection-detail');
    expect(() => mapCollectionDetailPayload(mismatched, { collectionId: 'different', collectionType: 0 }))
      .toThrow(CommandExecutionError);
  });

  it('does not require unexposed list URL or detail novel cover fields', () => {
    const list = fixture('collections-list');
    delete list.list_resp.items[0].url;
    expect(mapCollectionsPayload(list).rows).toHaveLength(2);

    const detail = fixture('collection-detail');
    delete detail.edit_resp.novel_cover_url;
    expect(mapCollectionDetailPayload(detail, {
      collectionId: '900000000000000001', collectionType: 0,
    }).items).toHaveLength(2);
  });

  it.each([
    ['positionOffset', '5'],
    ['positionOffset', -1],
    ['positionOffset', Number.MAX_SAFE_INTEGER + 1],
    ['begin', '0'],
    ['begin', -1],
    ['begin', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects malformed detail context %s=%s', (field, value) => {
    expect(() => mapCollectionDetailPayload(fixture('collection-detail'), {
      collectionId: '900000000000000001', collectionType: 0, [field]: value,
    })).toThrow(ArgumentError);
  });

  it('maps epoch zero timestamps to ISO and missing optional item time to null', () => {
    const list = fixture('collections-list');
    list.list_resp.items[0].create_time = 0;
    expect(mapCollectionsPayload(list).rows[0].createdAt).toBe('1970-01-01T00:00:00.000Z');

    const detail = fixture('collection-detail');
    detail.edit_resp.create_time = 0;
    delete detail.edit_resp.appmsg_infos[1].create_time;
    const mapped = mapCollectionDetailPayload(detail, {
      collectionId: '900000000000000001', collectionType: 0,
    });
    expect(mapped.createdAt).toBe('1970-01-01T00:00:00.000Z');
    expect(mapped.items[1].createdAt).toBeNull();
  });

  it.each([
    ['list required time', payload => { payload.list_resp.items[0].create_time = -1; }, mapCollectionsPayload],
    ['detail required time', payload => { payload.edit_resp.update_time = Number.MAX_SAFE_INTEGER; }, payload => mapCollectionDetailPayload(payload, {
      collectionId: '900000000000000001', collectionType: 0,
    })],
    ['detail optional item time', payload => { payload.edit_resp.appmsg_infos[0].create_time = 1.5; }, payload => mapCollectionDetailPayload(payload, {
      collectionId: '900000000000000001', collectionType: 0,
    })],
  ])('rejects invalid %s', (fixtureLabel, mutate, map) => {
    const payload = fixture(fixtureLabel.startsWith('list') ? 'collections-list' : 'collection-detail');
    mutate(payload);
    expect(() => map(payload)).toThrow(CommandExecutionError);
  });

  it.each([undefined, null])('normalizes absent update frequency %s to null', value => {
    const payload = fixture('collection-detail');
    if (value === undefined) delete payload.edit_resp.update_frequence;
    else payload.edit_resp.update_frequence = value;
    expect(mapCollectionDetailPayload(payload, {
      collectionId: '900000000000000001', collectionType: 0,
    }).settings.updateFrequency).toBeNull();
  });

  it('projects only the verified update frequency month', () => {
    const payload = fixture('collection-detail');
    payload.edit_resp.update_frequence.extra = 'ignored';
    expect(mapCollectionDetailPayload(payload, {
      collectionId: '900000000000000001', collectionType: 0,
    }).settings.updateFrequency).toEqual({ month: 1 });
  });

  it.each([
    1,
    {},
    { month: -1 },
    { month: 1.5 },
    { month: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects malformed update frequency %j', updateFrequency => {
    const payload = fixture('collection-detail');
    payload.edit_resp.update_frequence = updateFrequency;
    expect(() => mapCollectionDetailPayload(payload, {
      collectionId: '900000000000000001', collectionType: 0,
    })).toThrow(CommandExecutionError);
  });
});

function listPayload(items, total = items.length) {
  return { base_resp: { ret: 0 }, list_resp: { total, items } };
}
function listItem(id, type = 0) {
  return {
    id: String(id), title: `Collection ${id}`, type, total: 1,
    uv: 1, continous_read_on: 0, is_updating: 0, is_ban: 0, need_pay: 0,
    create_time: 1, update_time: 2, cover_url: null, url: `https://example.invalid/collections/${id}`,
  };
}
function detailPayload(id, items, continueFlag, begin = 0) {
  const base = fixture('collection-detail').edit_resp;
  return { base_resp: { ret: 0 }, edit_resp: { ...base, id: String(id), begin, total: items.length, appmsg_infos: items, continue_flag: continueFlag } };
}
function assertHeaders(init) {
  expect(init).toEqual({ referrer: safeReferer, headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  expect(init.headers.Referer).toBeUndefined();
  expect(init.headers.Cookie).toBeUndefined();
}
function pageByBegin(responses) {
  return {
    fetchJson: vi.fn(async url => {
      const begin = query(url).begin;
      expect(responses).toHaveProperty(begin);
      return responses[begin];
    }),
  };
}

describe('collection transport and pagination', () => {
  it.each([
    ['empty', ''],
    ['insecure', 'http://mp.weixin.qq.com/cgi-bin/appmsgalbum?action=list'],
    ['foreign', 'https://example.com/cgi-bin/appmsgalbum?action=list'],
    ['token-bearing', 'https://mp.weixin.qq.com/cgi-bin/appmsgalbum?action=list&token=secret'],
  ])('rejects an %s safeReferer before fetching', async (_label, unsafeReferer) => {
    const page = { fetchJson: vi.fn() };

    await expect(collectCollections({
      page, token, safeReferer: unsafeReferer, limit: 1, pageSize: 20, maxPages: 1,
    })).rejects.toBeInstanceOf(ArgumentError);
    expect(page.fetchJson).not.toHaveBeenCalled();
  });

  it('advances list begin by raw page consumption and stops at limit', async () => {
    const page = pageByBegin({
      0: listPayload([listItem(1), listItem(2)], 8),
      2: listPayload([listItem(3), listItem(4)], 8),
    });
    const rows = await collectCollections({ page, token, safeReferer, limit: 3, pageSize: 2, maxPages: 9 });
    expect(rows.map(row => row.collectionId)).toEqual(['1', '2', '3']);
    expect(page.fetchJson).toHaveBeenCalledTimes(2);
    expect(query(page.fetchJson.mock.calls[1][0]).begin).toBe('2');
    assertHeaders(page.fetchJson.mock.calls[0][1]);
  });

  it.each([
    ['total', { 0: listPayload([listItem(1), listItem(2)], 2) }, 1],
    ['empty page', { 0: listPayload([listItem(1)], 8), 1: listPayload([], 8) }, 2],
    ['maxPages', { 0: listPayload([listItem(1)], 8), 1: listPayload([listItem(2)], 8) }, 1],
  ])('stops list pagination at %s', async (_label, responses, maxPages) => {
    const page = pageByBegin(responses);
    await collectCollections({ page, token, safeReferer, limit: 8, pageSize: 1, maxPages });
    expect(page.fetchJson).toHaveBeenCalledTimes(maxPages);
  });

  it.each([
    ['a repeated page', {
      0: listPayload([listItem(1), listItem(2)], 5),
      2: listPayload([listItem(1), listItem(2)], 5),
    }],
    ['a duplicate ID across otherwise different pages', {
      0: listPayload([listItem(1), listItem(2)], 5),
      2: listPayload([listItem(2), listItem(3)], 5),
    }],
  ])('rejects %s', async (_label, responses) => {
    await expect(collectCollections({
      page: pageByBegin(responses), token, safeReferer, limit: 5, pageSize: 2, maxPages: 2,
    })).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('aggregates detail pages and advances begin by actual item count', async () => {
    const all = fixture('collection-detail').edit_resp.appmsg_infos;
    const page = pageByBegin({
      0: detailPayload('900000000000000001', [all[0]], 2, 0),
      1: detailPayload('900000000000000001', [all[1]], 0, 1),
    });
    const detail = await fetchCollectionDetail({
      page, token, safeReferer, collectionId: '900000000000000001', collectionType: 0,
      limit: 10, pageSize: 20, maxPages: 3,
    });
    expect(detail.items.map(item => item.appmsgId)).toEqual(['70001', '70002']);
    expect(query(page.fetchJson.mock.calls[1][0]).begin).toBe('1');
    assertHeaders(page.fetchJson.mock.calls[0][1]);
  });

  it('rejects an empty continuing detail page to prevent an infinite loop', async () => {
    const page = pageByBegin({ 0: detailPayload('1', [], 1, 0) });
    await expect(fetchCollectionDetail({
      page, token, safeReferer, collectionId: '1', collectionType: 0, limit: 2, pageSize: 1, maxPages: 2,
    })).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('rejects a detail response whose begin differs from the requested begin', async () => {
    const first = fixture('collection-detail').edit_resp.appmsg_infos[0];
    const page = pageByBegin({ 0: detailPayload('1', [first], 0, 9) });
    await expect(fetchCollectionDetail({
      page, token, safeReferer, collectionId: '1', collectionType: 0,
      limit: 2, pageSize: 1, maxPages: 2,
    })).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('rejects a duplicate detail item identity across pages', async () => {
    const repeated = fixture('collection-detail').edit_resp.appmsg_infos[0];
    const page = pageByBegin({
      0: detailPayload('1', [repeated], 1, 0),
      1: detailPayload('1', [repeated], 0, 1),
    });
    await expect(fetchCollectionDetail({
      page, token, safeReferer, collectionId: '1', collectionType: 0,
      limit: 2, pageSize: 1, maxPages: 2,
    })).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('normalizes an explicitly null optional pay album ID', () => {
    const payload = fixture('collection-detail');
    payload.edit_resp.appmsg_infos[1].pay_album_id = null;
    expect(mapCollectionDetailPayload(payload, {
      collectionId: '900000000000000001', collectionType: 0,
    }).items[1].payAlbumId).toBeNull();
  });

  it('finds an exact ID beyond the first row and preserves its numeric raw type', async () => {
    const page = pageByBegin({
      0: listPayload([listItem(1)], 3),
      1: listPayload([listItem(2, 7)], 3),
    });
    await expect(findCollectionById({
      page, token, safeReferer, collectionId: '2', pageSize: 1, maxPages: 2,
    })).resolves.toEqual({ row: expect.objectContaining({ collectionId: '2', collectionType: 'audio' }), collectionTypeRaw: 7 });
  });

  it('returns null when an exact collection ID is absent', async () => {
    const page = pageByBegin({ 0: listPayload([listItem(1)], 1) });
    await expect(findCollectionById({ page, token, safeReferer, collectionId: '2', pageSize: 20, maxPages: 2 }))
      .resolves.toBeNull();
  });

  it.each(['limit', 'pageSize', 'maxPages'])('rejects an invalid external %s without fetching', async field => {
    const page = { fetchJson: vi.fn() };
    await expect(collectCollections({ page, token, safeReferer, limit: 2, pageSize: 20, maxPages: 2, [field]: 0 }))
      .rejects.toBeInstanceOf(ArgumentError);
    expect(page.fetchJson).not.toHaveBeenCalled();
  });

  it('rejects null pageSize consistently before list or detail transport', async () => {
    const page = { fetchJson: vi.fn() };
    await expect(collectCollections({ page, token, safeReferer, limit: 2, pageSize: null, maxPages: 2 }))
      .rejects.toBeInstanceOf(ArgumentError);
    await expect(fetchCollectionDetail({
      page, token, safeReferer, collectionId: '1', collectionType: 0,
      limit: 2, pageSize: null, maxPages: 2,
    })).rejects.toBeInstanceOf(ArgumentError);
    expect(page.fetchJson).not.toHaveBeenCalled();
  });

  it.each(['limit', 'maxPages'])('rejects a missing external %s without fetching', async field => {
    const page = { fetchJson: vi.fn() };
    const input = { page, token, safeReferer, limit: 2, pageSize: 20, maxPages: 2 };
    delete input[field];
    await expect(collectCollections(input)).rejects.toBeInstanceOf(ArgumentError);
    expect(page.fetchJson).not.toHaveBeenCalled();
  });

  it('wraps and redacts ordinary transport errors', async () => {
    const leakedUrl = `https://mp.weixin.qq.com/cgi-bin/appmsgalbummgr?action=list&token=${token}`;
    const page = { fetchJson: vi.fn().mockRejectedValue(new Error(`failed ${leakedUrl}`)) };
    const error = await collectCollections({ page, token, safeReferer, limit: 1, pageSize: 20, maxPages: 1 }).catch(value => value);
    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain('https://');
    expect(error.message).not.toContain('/cgi-bin/appmsgalbummgr');
    expect(error.message).toContain('[REDACTED]');
  });

  it('preserves safe typed errors and safely repackages typed errors containing secrets', async () => {
    const safe = new AuthRequiredError('mp.weixin.qq.com', 'session expired');
    const page = { fetchJson: vi.fn().mockRejectedValueOnce(safe) };
    await expect(collectCollections({ page, token, safeReferer, limit: 1, pageSize: 20, maxPages: 1 })).rejects.toBe(safe);

    const unsafe = new CommandExecutionError(`failed token=${token}`);
    page.fetchJson.mockRejectedValueOnce(unsafe);
    const error = await collectCollections({ page, token, safeReferer, limit: 1, pageSize: 20, maxPages: 1 }).catch(value => value);
    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(error).not.toBe(unsafe);
    expect(error.message).not.toContain(token);
  });

  it('always redacts a short token from ordinary and typed error message or hint', async () => {
    const shortToken = 'abcd';
    const page = { fetchJson: vi.fn()
      .mockRejectedValueOnce(new Error(`failed ${shortToken}`))
      .mockRejectedValueOnce(new CommandExecutionError(`failed ${shortToken}`, `hint ${shortToken}`)) };

    const ordinary = await collectCollections({
      page, token: shortToken, safeReferer, limit: 1, pageSize: 20, maxPages: 1,
    }).catch(value => value);
    expect(ordinary).toBeInstanceOf(CommandExecutionError);
    expect(`${ordinary.message} ${ordinary.hint ?? ''}`).not.toContain(shortToken);

    const typed = await collectCollections({
      page, token: shortToken, safeReferer, limit: 1, pageSize: 20, maxPages: 1,
    }).catch(value => value);
    expect(typed).toBeInstanceOf(CommandExecutionError);
    expect(`${typed.message} ${typed.hint ?? ''}`).not.toContain(shortToken);
  });

  it('rejects a lone surrogate token through transport without throwing URIError', async () => {
    const page = { fetchJson: vi.fn() };
    await expect(collectCollections({
      page, token: '\ud800', safeReferer, limit: 1, pageSize: 20, maxPages: 1,
    })).rejects.toBeInstanceOf(ArgumentError);
    expect(page.fetchJson).not.toHaveBeenCalled();
  });
});
