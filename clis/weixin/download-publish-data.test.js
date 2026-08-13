import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { getRegistry } from '@sovovs/bycli/registry';
import * as auth from './_wechat/auth-session.js';
import * as publishDownload from './_wechat/publish-download.js';
import * as publishRecords from './_wechat/publish-records.js';

vi.mock('./_wechat/auth-session.js');
vi.mock('./_wechat/publish-download.js');
vi.mock('./_wechat/publish-records.js', async importOriginal => ({
  ...await importOriginal(),
  collectPublishedRecords: vi.fn(),
  matchPublishedRecord: vi.fn(),
  buildDetailUrl: vi.fn(),
}));

getRegistry().delete('weixin/download-publish-data');
await import('./download-publish-data.js');

const command = getRegistry().get('weixin/download-publish-data');

function privateRecord(overrides = {}) {
  return {
    title: 'Ontology Weekly',
    publishedAt: '2026-08-07',
    url: 'https://mp.weixin.qq.com/s/ontology-weekly',
    msgid: '1001',
    itemIdx: '1',
    publishDate: '2026-08-07',
    cookie: 'must-not-leak',
    ...overrides,
  };
}

function arrangeSuccess(overrides = {}) {
  const records = [privateRecord()];
  const matched = overrides.matched ?? records[0];
  auth.resolveBrowserCredentials.mockResolvedValue({ token: 'token-1', cookie: 'secret-cookie' });
  publishRecords.collectPublishedRecords.mockResolvedValue(records);
  publishRecords.matchPublishedRecord.mockReturnValue(matched);
  publishRecords.buildDetailUrl.mockReturnValue('https://mp.weixin.qq.com/misc/appmsganalysis?private=1');
  publishDownload.downloadPublishData.mockResolvedValue({
    status: 'downloaded',
    path: '/tmp/data.xls',
    size: 1234,
  });
  return { records, matched };
}

describe('weixin download-publish-data command', () => {
  beforeEach(() => vi.resetAllMocks());
  afterAll(() => getRegistry().delete('weixin/download-publish-data'));

  it('registers stable metadata, arguments, and public columns', () => {
    expect(command).toMatchObject({
      site: 'weixin',
      name: 'download-publish-data',
      access: 'write',
      domain: 'mp.weixin.qq.com',
      description: 'Match a Weixin published article and download its detail spreadsheet',
      strategy: 'intercept',
      browser: true,
      navigateBefore: false,
      columns: ['title', 'published_at', 'url', 'status', 'path', 'size'],
    });
    expect(command.args).toEqual([
      { name: 'query', positional: true, required: true, help: 'Exact article URL or title text' },
      { name: 'date', help: 'Optional publication date in YYYY-MM-DD' },
      { name: 'output', default: './weixin-publish-data', help: 'Directory for downloaded spreadsheets' },
      { name: 'max-pages', type: 'int', default: 5, help: 'Maximum published-record pages to scan' },
      { name: 'timeout', type: 'int', default: 60, help: 'Maximum seconds for capture and download' },
    ]);
  });

  it('trims the query, orchestrates collection and download, and returns only public fields', async () => {
    const { records, matched } = arrangeSuccess();
    const page = {};

    await expect(command.func(page, {
      query: '  Ontology Weekly  ',
      date: '2026-08-07',
      output: '/exports',
      'max-pages': 3,
      timeout: 12,
    })).resolves.toEqual([{
      title: 'Ontology Weekly',
      published_at: '2026-08-07',
      url: 'https://mp.weixin.qq.com/s/ontology-weekly',
      status: 'downloaded',
      path: '/tmp/data.xls',
      size: 1234,
    }]);

    expect(auth.resolveBrowserCredentials).toHaveBeenCalledWith(page);
    expect(publishRecords.collectPublishedRecords).toHaveBeenCalledWith(page, {
      token: 'token-1',
      limit: 30,
      maxPages: 3,
      timeout: 12,
    });
    expect(publishRecords.matchPublishedRecord).toHaveBeenCalledWith(
      records,
      'Ontology Weekly',
      '2026-08-07',
    );
    expect(publishRecords.buildDetailUrl).toHaveBeenCalledWith(matched, 'token-1');
    expect(publishDownload.downloadPublishData).toHaveBeenCalledWith(page, {
      detailUrl: 'https://mp.weixin.qq.com/misc/appmsganalysis?private=1',
      title: 'Ontology Weekly',
      outputDir: '/exports',
      timeoutSeconds: 12,
    });

    const output = await command.func(page, {
      query: 'Ontology Weekly', 'max-pages': 3, timeout: 12,
    });
    expect(output[0]).not.toHaveProperty('token');
    expect(output[0]).not.toHaveProperty('cookie');
    expect(output[0]).not.toHaveProperty('msgid');
    expect(output[0]).not.toHaveProperty('itemIdx');
    expect(output[0]).not.toHaveProperty('publishDate');
    expect(output[0]).not.toHaveProperty('publishedAt');
  });

  it('uses command defaults and forwards an omitted date', async () => {
    const { records } = arrangeSuccess();

    await command.func({}, { query: 'Ontology Weekly' });

    expect(publishRecords.collectPublishedRecords).toHaveBeenCalledWith({}, {
      token: 'token-1',
      limit: 50,
      maxPages: 5,
      timeout: 60,
    });
    expect(publishRecords.matchPublishedRecord).toHaveBeenCalledWith(
      records,
      'Ontology Weekly',
      undefined,
    );
    expect(publishDownload.downloadPublishData).toHaveBeenCalledWith({}, expect.objectContaining({
      outputDir: './weixin-publish-data',
      timeoutSeconds: 60,
    }));
  });

  it('preserves an explicitly empty output directory value', async () => {
    arrangeSuccess();

    await command.func({}, { query: 'Ontology Weekly', output: '' });

    expect(publishDownload.downloadPublishData).toHaveBeenCalledWith({}, expect.objectContaining({
      outputDir: '',
    }));
  });

  it.each([undefined, '', '   '])('rejects empty query %j before authentication', async query => {
    await expect(command.func({}, { query })).rejects.toMatchObject({
      code: 'ARGUMENT',
      message: expect.stringContaining('query required'),
    });
    expect(auth.resolveBrowserCredentials).not.toHaveBeenCalled();
  });

  it.each([
    ['timeout', 0],
    ['timeout', -1],
    ['timeout', Number.MAX_SAFE_INTEGER + 1],
    ['max-pages', 0],
    ['max-pages', -1],
    ['max-pages', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects invalid %s value %s before authentication', async (name, value) => {
    await expect(command.func({}, { query: 'Article', [name]: value }))
      .rejects.toMatchObject({ code: 'ARGUMENT' });
    expect(auth.resolveBrowserCredentials).not.toHaveBeenCalled();
    expect(publishRecords.collectPublishedRecords).not.toHaveBeenCalled();
  });

  it.each(['2026-8-8', '2026-02-30'])(
    'rejects invalid date %s before authentication or collection',
    async date => {
      await expect(command.func({}, { query: 'Article', date }))
        .rejects.toMatchObject({ code: 'ARGUMENT' });
      expect(auth.resolveBrowserCredentials).not.toHaveBeenCalled();
      expect(publishRecords.collectPublishedRecords).not.toHaveBeenCalled();
    },
  );

  it('accepts the largest max-pages value whose scan limit remains safe', async () => {
    arrangeSuccess();
    const maxPages = Math.floor(Number.MAX_SAFE_INTEGER / 10);

    await command.func({}, { query: 'Ontology Weekly', 'max-pages': maxPages });

    expect(auth.resolveBrowserCredentials).toHaveBeenCalled();
    expect(publishRecords.collectPublishedRecords).toHaveBeenCalledWith({}, expect.objectContaining({
      maxPages,
      limit: maxPages * 10,
    }));
  });

  it('rejects max-pages when multiplying by ten would exceed the safe integer range', async () => {
    const maxPages = Math.floor(Number.MAX_SAFE_INTEGER / 10) + 1;

    await expect(command.func({}, { query: 'Article', 'max-pages': maxPages }))
      .rejects.toMatchObject({ code: 'ARGUMENT' });
    expect(auth.resolveBrowserCredentials).not.toHaveBeenCalled();
    expect(publishRecords.collectPublishedRecords).not.toHaveBeenCalled();
  });

  it.each([
    ['authentication', () => auth.resolveBrowserCredentials, new ArgumentError('auth failed')],
    ['collection', () => publishRecords.collectPublishedRecords, new CommandExecutionError('collect failed')],
    ['matching', () => publishRecords.matchPublishedRecord, new ArgumentError('match failed')],
    ['download', () => publishDownload.downloadPublishData, new CommandExecutionError('download failed')],
  ])('naturally propagates %s errors', async (_label, getMock, error) => {
    arrangeSuccess();
    getMock().mockRejectedValue?.(error);
    if (getMock() === publishRecords.matchPublishedRecord) getMock().mockImplementation(() => { throw error; });

    await expect(command.func({}, { query: 'Ontology Weekly' })).rejects.toBe(error);
  });
});
