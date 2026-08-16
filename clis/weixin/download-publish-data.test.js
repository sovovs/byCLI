import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { getRegistry } from '@sovovs/bycli/registry';
import * as auth from './_wechat/auth-session.js';
import * as publishAnalysis from './_wechat/publish-analysis.js';
import * as publishDownload from './_wechat/publish-download.js';
import * as publishRecords from './_wechat/publish-records.js';

vi.mock('./_wechat/auth-session.js');
vi.mock('./_wechat/publish-analysis.js');
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
let temporaryDirectory;
let dataPath;
let markdownPath;

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
    path: dataPath,
    size: 25088,
  });
  publishAnalysis.collectPublishAnalysis.mockResolvedValue({
    status: 'saved',
    path: markdownPath,
    size: 1234,
  });
  return { records, matched };
}

describe('weixin download-publish-data command', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'bycli-publish-command-'));
    dataPath = join(temporaryDirectory, 'data.xls');
    markdownPath = join(temporaryDirectory, 'data.md');
    await writeFile(dataPath, Buffer.alloc(25088, 1));
    await writeFile(markdownPath, Buffer.alloc(1234, 1));
  });
  afterEach(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  afterAll(() => getRegistry().delete('weixin/download-publish-data'));

  it('registers stable metadata, arguments, and public columns', () => {
    expect(command).toMatchObject({
      site: 'weixin',
      name: 'download-publish-data',
      access: 'write',
      domain: 'mp.weixin.qq.com',
      description: 'Match a Weixin published article and save its Excel data and Markdown analysis',
      strategy: 'intercept',
      browser: true,
      navigateBefore: false,
      columns: ['title', 'publishedAt', 'url', 'status', 'markdownPath', 'markdownSize', 'dataPath', 'dataSize', 'error'],
    });
    expect(command.args).toEqual([
      { name: 'query', positional: true, required: true, help: 'Exact article URL or title text' },
      { name: 'date', help: 'Optional publication date in YYYY-MM-DD' },
      { name: 'output', default: './weixin-publish-data', help: 'Directory for generated Excel data and Markdown reports' },
      { name: 'max-pages', type: 'int', default: 5, help: 'Maximum published-record pages to scan' },
      { name: 'timeout', type: 'int', default: 60, help: 'Maximum seconds for page capture' },
    ]);
  });

  it('trims the query, collects analysis, and returns only public fields', async () => {
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
      publishedAt: '2026-08-07',
      url: 'https://mp.weixin.qq.com/s/ontology-weekly',
      status: 'downloaded',
      markdownPath,
      markdownSize: 1234,
      dataPath,
      dataSize: 25088,
      error: null,
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
    expect(publishAnalysis.collectPublishAnalysis).toHaveBeenCalledWith(page, {
      detailUrl: 'https://mp.weixin.qq.com/misc/appmsganalysis?private=1',
      title: 'Ontology Weekly', publishedAt: '2026-08-07', outputDir: '/exports', timeoutSeconds: 12,
    });
    expect(publishDownload.downloadPublishData.mock.invocationCallOrder[0])
      .toBeLessThan(publishAnalysis.collectPublishAnalysis.mock.invocationCallOrder[0]);

    const output = await command.func(page, {
      query: 'Ontology Weekly', 'max-pages': 3, timeout: 12,
    });
    expect(output[0]).not.toHaveProperty('token');
    expect(output[0]).not.toHaveProperty('cookie');
    expect(output[0]).not.toHaveProperty('msgid');
    expect(output[0]).not.toHaveProperty('itemIdx');
    expect(output[0]).not.toHaveProperty('publishDate');
    expect(output[0]).toHaveProperty('publishedAt', '2026-08-07');
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
    expect(publishAnalysis.collectPublishAnalysis).toHaveBeenCalledWith({}, expect.objectContaining({
      outputDir: './weixin-publish-data', timeoutSeconds: 60, publishedAt: '2026-08-07',
    }));
  });

  it('preserves an explicitly empty output directory value', async () => {
    arrangeSuccess();

    await command.func({}, { query: 'Ontology Weekly', output: '' });

    expect(publishDownload.downloadPublishData).toHaveBeenCalledWith({}, expect.objectContaining({
      outputDir: '',
    }));
    expect(publishAnalysis.collectPublishAnalysis).toHaveBeenCalledWith({}, expect.objectContaining({
      outputDir: '',
    }));
  });

  it('returns partial success when Excel fails but Markdown succeeds', async () => {
    arrangeSuccess();
    publishDownload.downloadPublishData.mockRejectedValue(
      new CommandExecutionError('download failed token=token-1'),
    );

    const [result] = await command.func({}, { query: 'Ontology Weekly' });

    expect(result).toEqual({
      title: 'Ontology Weekly',
      publishedAt: '2026-08-07',
      url: 'https://mp.weixin.qq.com/s/ontology-weekly',
      status: 'partial',
      markdownPath,
      markdownSize: 1234,
      dataPath: null,
      dataSize: null,
      error: expect.stringContaining('download failed'),
    });
    expect(result.error).not.toContain('token-1');
    expect(publishAnalysis.collectPublishAnalysis).toHaveBeenCalledWith({}, {
      detailUrl: 'https://mp.weixin.qq.com/misc/appmsganalysis?private=1',
      title: 'Ontology Weekly',
      publishedAt: '2026-08-07',
      outputDir: './weixin-publish-data',
      timeoutSeconds: 60,
    });
    expect(publishDownload.downloadPublishData.mock.invocationCallOrder[0])
      .toBeLessThan(publishAnalysis.collectPublishAnalysis.mock.invocationCallOrder[0]);
  });

  it('returns partial success when Markdown fails but Excel succeeds', async () => {
    arrangeSuccess();
    publishAnalysis.collectPublishAnalysis.mockRejectedValue(
      new CommandExecutionError('analysis failed secret-cookie'),
    );

    const [result] = await command.func({}, { query: 'Ontology Weekly' });

    expect(result).toEqual({
      title: 'Ontology Weekly', publishedAt: '2026-08-07',
      url: 'https://mp.weixin.qq.com/s/ontology-weekly', status: 'partial',
      markdownPath: null, markdownSize: null, dataPath, dataSize: 25088,
      error: expect.stringContaining('Markdown analysis failed'),
    });
    expect(result.error).not.toContain('secret-cookie');
  });

  it.each([
    ['wrong status', async () => ({ status: 'saved', path: dataPath, size: 25088 })],
    ['empty path', async () => ({ status: 'downloaded', path: '', size: 25088 })],
    ['zero size', async () => ({ status: 'downloaded', path: dataPath, size: 0 })],
    ['unsafe size', async () => ({ status: 'downloaded', path: dataPath, size: Number.MAX_SAFE_INTEGER + 1 })],
    ['missing file', async () => ({ status: 'downloaded', path: join(temporaryDirectory, 'missing.xls'), size: 10 })],
    ['directory path', async () => {
      const directory = join(temporaryDirectory, 'directory.xls');
      await mkdir(directory);
      return { status: 'downloaded', path: directory, size: 10 };
    }],
    ['size mismatch', async () => ({ status: 'downloaded', path: dataPath, size: 1 })],
    ['wrong extension', async () => ({ status: 'downloaded', path: markdownPath, size: 1234 })],
  ])('treats an invalid Excel artifact as partial: %s', async (_label, invalidResult) => {
    arrangeSuccess();
    publishDownload.downloadPublishData.mockResolvedValue(await invalidResult());

    const [result] = await command.func({}, { query: 'Ontology Weekly' });

    expect(result).toMatchObject({
      status: 'partial',
      markdownPath,
      markdownSize: 1234,
      dataPath: null,
      dataSize: null,
      error: expect.stringContaining('Excel download failed'),
    });
  });

  it.each([
    ['wrong status', async () => ({ status: 'downloaded', path: markdownPath, size: 1234 })],
    ['empty path', async () => ({ status: 'saved', path: '', size: 1234 })],
    ['zero size', async () => ({ status: 'saved', path: markdownPath, size: 0 })],
    ['unsafe size', async () => ({ status: 'saved', path: markdownPath, size: Number.MAX_SAFE_INTEGER + 1 })],
    ['missing file', async () => ({ status: 'saved', path: join(temporaryDirectory, 'missing.md'), size: 10 })],
    ['directory path', async () => {
      const directory = join(temporaryDirectory, 'directory.md');
      await mkdir(directory);
      return { status: 'saved', path: directory, size: 10 };
    }],
    ['size mismatch', async () => ({ status: 'saved', path: markdownPath, size: 1 })],
    ['wrong extension', async () => ({ status: 'saved', path: dataPath, size: 25088 })],
  ])('treats an invalid Markdown artifact as partial: %s', async (_label, invalidResult) => {
    arrangeSuccess();
    publishAnalysis.collectPublishAnalysis.mockResolvedValue(await invalidResult());

    const [result] = await command.func({}, { query: 'Ontology Weekly' });

    expect(result).toMatchObject({
      status: 'partial',
      markdownPath: null,
      markdownSize: null,
      dataPath,
      dataSize: 25088,
      error: expect.stringContaining('Markdown analysis failed'),
    });
  });

  it('returns failed when both helpers return invalid artifact contracts', async () => {
    arrangeSuccess();
    publishDownload.downloadPublishData.mockResolvedValue({
      status: 'downloaded', path: 'https://mp.weixin.qq.com/private?token=token-1', size: 10,
    });
    publishAnalysis.collectPublishAnalysis.mockResolvedValue({
      status: 'saved', path: '', size: 0,
    });

    const [result] = await command.func({}, { query: 'Ontology Weekly' });

    expect(result).toMatchObject({
      status: 'failed',
      markdownPath: null,
      markdownSize: null,
      dataPath: null,
      dataSize: null,
    });
    expect(result.error).toContain('Excel download failed');
    expect(result.error).toContain('Markdown analysis failed');
    expect(result.error).not.toMatch(/token-1|secret-cookie|https?:\/\/mp\.weixin\.qq\.com/iu);
  });

  it('returns a redacted failure when Excel download and Markdown fallback both fail', async () => {
    arrangeSuccess();
    publishDownload.downloadPublishData.mockRejectedValue(new CommandExecutionError(
      'download https://mp.weixin.qq.com/private?token=token-1 failed',
    ));
    publishAnalysis.collectPublishAnalysis.mockRejectedValue(new CommandExecutionError(
      'analysis failed secret-cookie',
    ));

    const [result] = await command.func({}, { query: 'Ontology Weekly' });

    expect(result).toMatchObject({
      status: 'failed',
      markdownPath: null,
      markdownSize: null,
      dataPath: null,
      dataSize: null,
    });
    expect(result.error).toContain('Excel download failed');
    expect(result.error).toContain('Markdown analysis failed');
    expect(result.error).not.toMatch(/token-1|secret-cookie|https?:\/\/mp\.weixin\.qq\.com/iu);
  });

  it.each([undefined, '', '   '])('rejects empty query %j before authentication', async query => {
    await expect(command.func({}, { query })).rejects.toMatchObject({
      code: 'ARGUMENT',
      message: expect.stringContaining('query required'),
    });
    expect(auth.resolveBrowserCredentials).not.toHaveBeenCalled();
  });

  it.each([
    'http://mp.weixin.qq.com/s/article',
    'https://evil.example/s/article',
    'https://user:pass@mp.weixin.qq.com/s/article',
    'https://mp.weixin.qq.com:444/s/article',
    'https://mp.weixin.qq.com/cgi-bin/home',
  ])('rejects an untrusted absolute query URL before authentication: %s', async query => {
    await expect(command.func({}, { query })).rejects.toMatchObject({
      code: 'ARGUMENT',
      message: expect.stringContaining('trusted WeChat article URL'),
    });
    expect(auth.resolveBrowserCredentials).not.toHaveBeenCalled();
    expect(publishRecords.collectPublishedRecords).not.toHaveBeenCalled();
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
  ])('naturally propagates %s errors', async (_label, getMock, error) => {
    arrangeSuccess();
    getMock().mockRejectedValue?.(error);
    if (getMock() === publishRecords.matchPublishedRecord) getMock().mockImplementation(() => { throw error; });

    await expect(command.func({}, { query: 'Ontology Weekly' })).rejects.toBe(error);
  });
});
