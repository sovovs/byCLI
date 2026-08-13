import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import * as auth from './_wechat/auth-session.js';
import * as publishRecords from './_wechat/publish-records.js';

vi.mock('./_wechat/auth-session.js');
vi.mock('./_wechat/publish-records.js', async importOriginal => ({
  ...await importOriginal(),
  collectPublishedRecords: vi.fn(),
}));

getRegistry().delete('weixin/published');
await import('./published.js');

const command = getRegistry().get('weixin/published');
const columns = [
  'title',
  'published_at',
  'url',
  'notified',
  'failed',
  'reads',
  'likes',
  'shares',
  'recommends',
  'comments',
  'underlines',
  'reprints',
];

function record(overrides = {}) {
  return {
    title: 'Ontology Weekly',
    publishedAt: '2026-08-07',
    url: 'https://mp.weixin.qq.com/s/ontology-weekly',
    notified: 120,
    failed: 2,
    reads: 88,
    likes: 7,
    shares: 9,
    recommends: 4,
    comments: 3,
    underlines: 5,
    reprints: 1,
    msgid: '1001',
    itemIdx: '1',
    publishDate: '2026-08-07',
    ...overrides,
  };
}

describe('weixin published command', () => {
  beforeEach(() => vi.resetAllMocks());
  afterAll(() => getRegistry().delete('weixin/published'));

  it('registers stable metadata, arguments, and public columns', () => {
    expect(command).toMatchObject({
      site: 'weixin',
      name: 'published',
      access: 'read',
      domain: 'mp.weixin.qq.com',
      description: 'List Weixin published records and engagement metrics',
      strategy: 'intercept',
      browser: true,
      navigateBefore: false,
      columns,
    });
    expect(command.args).toEqual([
      { name: 'query', positional: true, required: false, help: 'Optional article title or URL filter' },
      { name: 'limit', type: 'int', default: 10, help: 'Maximum articles to return' },
      { name: 'max-pages', type: 'int', default: 5, help: 'Maximum published-record pages to scan' },
      { name: 'timeout', type: 'int', default: 30, help: 'Maximum seconds for request capture' },
    ]);
  });

  it('uses the requested limit when no query is provided', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 'token-1', cookie: 'secret-cookie' });
    publishRecords.collectPublishedRecords.mockResolvedValue([record()]);
    const page = {};

    await expect(command.func(page, { limit: 4, 'max-pages': 3, timeout: 12 })).resolves.toEqual([
      expect.objectContaining({ title: 'Ontology Weekly' }),
    ]);

    expect(auth.resolveBrowserCredentials).toHaveBeenCalledWith(page);
    expect(publishRecords.collectPublishedRecords).toHaveBeenCalledWith(page, {
      token: 'token-1',
      limit: 4,
      maxPages: 3,
      timeout: 12,
    });
  });

  it('scans maxPages times ten records for a trimmed query, filters, and applies the output limit', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 'token-2', cookie: 'do-not-forward' });
    publishRecords.collectPublishedRecords.mockResolvedValue([
      record({ title: 'No match', url: 'https://mp.weixin.qq.com/s/no-match' }),
      record({ title: 'Target alpha', url: 'https://mp.weixin.qq.com/s/alpha', msgid: '2' }),
      record({ title: 'Target beta', url: 'https://mp.weixin.qq.com/s/beta', msgid: '3' }),
    ]);

    const result = await command.func({}, {
      query: '  Target  ',
      limit: 1,
      'max-pages': 7,
      timeout: 18,
    });

    expect(publishRecords.collectPublishedRecords).toHaveBeenCalledWith({}, {
      token: 'token-2',
      limit: 70,
      maxPages: 7,
      timeout: 18,
    });
    expect(result).toEqual([{
      title: 'Target alpha',
      published_at: '2026-08-07',
      url: 'https://mp.weixin.qq.com/s/alpha',
      notified: 120,
      failed: 2,
      reads: 88,
      likes: 7,
      shares: 9,
      recommends: 4,
      comments: 3,
      underlines: 5,
      reprints: 1,
    }]);
    expect(result[0]).not.toHaveProperty('msgid');
    expect(result[0]).not.toHaveProperty('itemIdx');
    expect(result[0]).not.toHaveProperty('publishDate');
    expect(result[0]).not.toHaveProperty('publishedAt');
    expect(result[0]).not.toHaveProperty('cookie');
  });

  it('matches a query against article URLs', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 'token-3', cookie: 'secret' });
    publishRecords.collectPublishedRecords.mockResolvedValue([
      record({ title: 'First', url: 'https://mp.weixin.qq.com/s/first' }),
      record({ title: 'Second', url: 'https://mp.weixin.qq.com/s/target-url' }),
    ]);

    await expect(command.func({}, {
      query: 'target-url', limit: 10, 'max-pages': 5, timeout: 30,
    })).resolves.toEqual([
      expect.objectContaining({ title: 'Second', url: 'https://mp.weixin.qq.com/s/target-url' }),
    ]);
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects query-mode limit %s before authentication or collection',
    async limit => {
      await expect(command.func({}, {
        query: 'target', limit, 'max-pages': 5, timeout: 30,
      })).rejects.toMatchObject({ code: 'ARGUMENT' });
      expect(auth.resolveBrowserCredentials).not.toHaveBeenCalled();
      expect(publishRecords.collectPublishedRecords).not.toHaveBeenCalled();
    },
  );

  it('throws EMPTY_RESULT when no collected record matches the query', async () => {
    auth.resolveBrowserCredentials.mockResolvedValue({ token: 'token-4', cookie: 'secret' });
    publishRecords.collectPublishedRecords.mockResolvedValue([record()]);

    await expect(command.func({}, {
      query: 'missing', limit: 10, 'max-pages': 5, timeout: 30,
    })).rejects.toMatchObject({
      code: 'EMPTY_RESULT',
      hint: 'No published record matched "missing".',
    });
  });
});
