import { copyFile, link, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';
import { downloadPublishData } from './publish-download.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    copyFile: vi.fn(actual.copyFile),
    link: vi.fn(actual.link),
    unlink: vi.fn(actual.unlink),
  };
});

const actualFs = await vi.importActual('node:fs/promises');

const DETAIL_URL = 'https://mp.weixin.qq.com/misc/appmsganalysis?action=detailpage&msgid=1001&publish_date=2026-08-07';
const DOWNLOAD_URL = `${DETAIL_URL}&download=1`;
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  copyFile.mockReset();
  copyFile.mockImplementation(actualFs.copyFile);
  link.mockReset();
  link.mockImplementation(actualFs.link);
  unlink.mockReset();
  unlink.mockImplementation(actualFs.unlink);
});

async function tempDirectory(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

async function setup(overrides = {}) {
  const downloadDir = await tempDirectory('bycli-weixin-source-');
  const outputDir = await tempDirectory('bycli-weixin-output-');
  const source = join(downloadDir, overrides.filename ?? 'detail.xls');
  if (!overrides.skipSource) await writeFile(source, overrides.content ?? 'excel-data');

  const events = [];
  const waitForDownload = vi.fn(() => {
    events.push('wait');
    return Promise.resolve(overrides.downloadResult ?? {
      downloaded: true,
      filename: source,
      url: DOWNLOAD_URL,
      state: 'complete',
      danger: 'safe',
    });
  });
  const page = {
    goto: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => overrides.detail ?? {
      title: '数据明细 Ontology Weekly',
      link: DOWNLOAD_URL,
    }),
    waitForDownload,
    click: vi.fn(async () => {
      events.push('click');
      return { matches_n: 1, match_level: 'exact' };
    }),
  };

  return {
    source,
    outputDir,
    events,
    page,
    options: {
      detailUrl: DETAIL_URL,
      title: 'Ontology Weekly',
      outputDir,
      timeoutSeconds: 12,
    },
  };
}

describe('downloadPublishData', () => {
  it('names a completed spreadsheet after the selected article and reports its size', async () => {
    const context = await setup({ filename: '数据明细.xls', content: 'workbook' });

    const result = await downloadPublishData(context.page, context.options);

    expect(result).toEqual({
      status: 'downloaded',
      path: join(context.outputDir, 'Ontology Weekly.xls'),
      size: 8,
    });
    await expect(readFile(result.path, 'utf8')).resolves.toBe('workbook');
    await expect(readFile(context.source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(context.page.goto.mock.calls).toEqual([
      [DETAIL_URL],
      [DOWNLOAD_URL, { waitUntil: 'none' }],
    ]);
    expect(context.page.waitForDownload).toHaveBeenCalledWith(
      '&msgid=1001&publish_date=2026-08-07&',
      12_000,
      expect.objectContaining({ includeRecent: true, startedAfterMs: expect.any(Number) }),
    );
    expect(context.page.click).not.toHaveBeenCalled();
  });

  it('sanitizes unsafe article-title characters for the destination filename', async () => {
    const context = await setup({
      filename: 'wechat-export.xls',
      detail: { title: '数据明细   A/B:C*D?E"F<G>H|I\nJ  ', link: DOWNLOAD_URL },
    });
    context.options.title = '  A/B:C*D?E"F<G>H|I\nJ  ';

    const result = await downloadPublishData(context.page, context.options);

    expect(result.path).toBe(join(context.outputDir, 'A_B_C_D_E_F_G_H_I_J.xls'));
  });

  it('uses a stable fallback when the article title is whitespace only', async () => {
    const context = await setup({
      filename: 'wechat-export.xls',
      detail: { title: '数据明细    ', link: DOWNLOAD_URL },
    });
    context.options.title = '   ';

    const result = await downloadPublishData(context.page, context.options);

    expect(result.path).toBe(join(context.outputDir, 'publish-data.xls'));
  });

  it('allocates a numbered filename without overwriting an existing file', async () => {
    const context = await setup({ filename: 'same.xls', content: 'new' });
    context.options.title = 'same';
    context.page.evaluate.mockResolvedValue({ title: '数据明细 same', link: DOWNLOAD_URL });
    await writeFile(join(context.outputDir, 'same.xls'), 'old');

    const result = await downloadPublishData(context.page, context.options);

    expect(result.path).toBe(join(context.outputDir, 'same-1.xls'));
    await expect(readFile(join(context.outputDir, 'same.xls'), 'utf8')).resolves.toBe('old');
    await expect(readFile(result.path, 'utf8')).resolves.toBe('new');
  });

  it('matches a normalized Chrome download by stable msgid without logging duplicate credentials', async () => {
    const domLink = `${DOWNLOAD_URL}&token=t&lang=zh_CN&token=t&lang=zh_CN`;
    const normalizedDownloadUrl = `${DOWNLOAD_URL}&token=t&lang=zh_CN`;
    const context = await setup({
      detail: { title: 'Ontology Weekly', link: domLink },
    });
    const similarIdUrl = normalizedDownloadUrl.replace('msgid=1001', 'msgid=10010');
    const similarParameterUrl = normalizedDownloadUrl.replace('msgid=1001', 'othermsgid=1001');
    context.page.waitForDownload.mockImplementation(async pattern => {
      const targetMatches = normalizedDownloadUrl.includes(pattern);
      const similarIdMatches = similarIdUrl.includes(pattern);
      const similarParameterMatches = similarParameterUrl.includes(pattern);
      if (!targetMatches || similarIdMatches || similarParameterMatches || pattern === domLink) {
        return { downloaded: false, elapsedMs: 12_000 };
      }
      return {
        downloaded: true,
        filename: context.source,
        finalUrl: normalizedDownloadUrl,
        state: 'complete',
        danger: 'safe',
      };
    });

    const result = await downloadPublishData(context.page, context.options);

    expect(result).toMatchObject({ status: 'downloaded', size: 10 });
    const pattern = context.page.waitForDownload.mock.calls[0][0];
    expect(pattern).toBe('&msgid=1001&publish_date=2026-08-07&');
    expect(normalizedDownloadUrl).toContain(pattern);
    expect(similarIdUrl).not.toContain(pattern);
    expect(similarParameterUrl).not.toContain(pattern);
    expect(pattern).not.toMatch(/token|lang/);
  });

  it('rejects a trusted-looking detail link without publish_date before download navigation', async () => {
    const link = 'https://mp.weixin.qq.com/misc/appmsganalysis?action=detailpage&msgid=1001&download=1';
    const context = await setup({ detail: { title: 'Ontology Weekly', link } });
    context.options.detailUrl = 'https://mp.weixin.qq.com/misc/appmsganalysis?action=detailpage&msgid=1001';

    await expect(downloadPublishData(context.page, context.options)).rejects.toBeInstanceOf(CommandExecutionError);
    expect(context.page.click).not.toHaveBeenCalled();
    expect(context.page.goto.mock.calls).toEqual([[context.options.detailUrl]]);
    expect(context.page.waitForDownload).not.toHaveBeenCalled();
  });

  it.each([
    'https://evil.example/misc/appmsganalysis?action=detailpage&msgid=1001&publish_date=2026-08-07&download=1',
    'https://mp.weixin.qq.com/misc/appmsganalysis?action=detailpage&msgid=other&publish_date=2026-08-07&download=1',
    'https://mp.weixin.qq.com/misc/appmsganalysis?action=detailpage&msgid=1001&publish_date=2026-08-08&download=1',
    'https://mp.weixin.qq.com/misc/appmsganalysis?action=detailpage&msgid=1001&publish_date=2026-08-07&download=0',
  ])('rejects an untrusted download link: %s', async link => {
    const context = await setup({ detail: { title: 'Ontology Weekly', link } });

    await expect(downloadPublishData(context.page, context.options)).rejects.toBeInstanceOf(CommandExecutionError);
    expect(context.page.goto.mock.calls).toEqual([[DETAIL_URL]]);
    expect(context.page.waitForDownload).not.toHaveBeenCalled();
  });

  it('rejects a detail page whose title does not contain the selected article title', async () => {
    const context = await setup({ detail: { title: 'Different article', link: DOWNLOAD_URL } });

    await expect(downloadPublishData(context.page, context.options)).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('waits for download navigation to complete before observing a download scoped to navigation time', async () => {
    const context = await setup();
    let resolveNavigation;
    context.page.goto.mockImplementation((url, options) => {
      if (url === DETAIL_URL) return Promise.resolve();
      context.events.push('navigate-download');
      expect(url).toBe(DOWNLOAD_URL);
      expect(options).toEqual({ waitUntil: 'none' });
      return new Promise(resolve => { resolveNavigation = resolve; });
    });
    const before = Date.now();

    const promise = downloadPublishData(context.page, context.options);
    await vi.waitFor(() => expect(context.page.goto).toHaveBeenCalledTimes(2));
    expect(context.page.waitForDownload).not.toHaveBeenCalled();

    resolveNavigation();
    const result = await promise;
    const after = Date.now();

    expect(result.status).toBe('downloaded');
    expect(context.events).toEqual(['navigate-download', 'wait']);
    expect(context.page.click).not.toHaveBeenCalled();
    const waitOptions = context.page.waitForDownload.mock.calls[0][2];
    expect(waitOptions).toEqual({ includeRecent: true, startedAfterMs: expect.any(Number) });
    expect(waitOptions.startedAfterMs).toBeGreaterThanOrEqual(before);
    expect(waitOptions.startedAfterMs).toBeLessThanOrEqual(after);
  });

  it('rejects an unrelated recent spreadsheet and preserves its source file', async () => {
    const context = await setup({
      downloadResult: {
        downloaded: true,
        filename: '',
        url: 'https://mp.weixin.qq.com/misc/appmsganalysis?action=detailpage&msgid=unrelated&publish_date=2026-08-07&download=1',
        state: 'complete',
        danger: 'safe',
      },
    });
    context.page.waitForDownload.mockResolvedValue({
      downloaded: true,
      filename: context.source,
      finalUrl: 'https://mp.weixin.qq.com/misc/appmsganalysis?action=detailpage&msgid=unrelated&publish_date=2026-08-07&download=1',
      state: 'complete',
      danger: 'safe',
    });

    await expect(downloadPublishData(context.page, context.options)).rejects.toBeInstanceOf(CommandExecutionError);
    await expect(readFile(context.source, 'utf8')).resolves.toBe('excel-data');
    await expect(readdir(context.outputDir)).resolves.toEqual([]);
  });

  it('accepts a trusted final download URL for the selected article', async () => {
    const context = await setup();
    context.page.waitForDownload.mockResolvedValue({
      downloaded: true,
      filename: context.source,
      url: 'https://redirect.invalid/download.xls',
      finalUrl: DOWNLOAD_URL,
      state: 'complete',
      danger: 'accepted',
    });

    await expect(downloadPublishData(context.page, context.options)).resolves.toMatchObject({
      status: 'downloaded',
      size: 10,
    });
  });

  it('maps an unmatched download to a typed timeout', async () => {
    const context = await setup({ downloadResult: { downloaded: false, elapsedMs: 12_000 } });

    const error = await downloadPublishData(context.page, context.options).catch(value => value);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe('Weixin publish-data download timed out after 12s');
  });

  it.each([
    { downloaded: true, filename: '', url: DOWNLOAD_URL, state: 'complete', danger: 'safe' },
    { downloaded: true, filename: '/tmp/file.xls', url: DOWNLOAD_URL, state: 'interrupted', danger: 'safe' },
  ])('rejects incomplete or dangerous download metadata: %j', async downloadResult => {
    const context = await setup({ downloadResult });

    await expect(downloadPublishData(context.page, context.options)).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it.each([undefined, 'dangerous', 'file', 'url', 'content', 'uncommon', 'host', 'unwanted'])(
    'rejects non-whitelisted download danger state: %s',
    async danger => {
      const context = await setup();
      context.page.waitForDownload.mockResolvedValue({
        downloaded: true,
        filename: context.source,
        url: DOWNLOAD_URL,
        state: 'complete',
        danger,
      });

      await expect(downloadPublishData(context.page, context.options)).rejects.toBeInstanceOf(CommandExecutionError);
      await expect(readFile(context.source, 'utf8')).resolves.toBe('excel-data');
      await expect(readdir(context.outputDir)).resolves.toEqual([]);
    },
  );

  it('rejects an empty downloaded file', async () => {
    const context = await setup({ content: '' });

    const error = await downloadPublishData(context.page, context.options).catch(value => value);
    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(error.message).toContain('empty');
  });

  it('cleans unsafe article-title characters and appends the spreadsheet suffix', async () => {
    const context = await setup();
    context.options.title = 'report:bad?.txt';
    context.page.evaluate.mockResolvedValue({ title: '数据明细 report:bad?.txt', link: DOWNLOAD_URL });

    const result = await downloadPublishData(context.page, context.options);

    expect(result.path).toBe(join(context.outputDir, 'report_bad_.txt.xls'));
  });

  it('still succeeds when removing the saved source download fails', async () => {
    const context = await setup();
    unlink.mockImplementation(async path => {
      if (path === context.source) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return actualFs.unlink(path);
    });

    const result = await downloadPublishData(context.page, context.options);

    await expect(readFile(result.path, 'utf8')).resolves.toBe('excel-data');
    await expect(readFile(context.source, 'utf8')).resolves.toBe('excel-data');
  });

  it('does not leave a final or hidden temporary file when atomic publication fails', async () => {
    const context = await setup();
    link.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EPERM' }));

    await expect(downloadPublishData(context.page, context.options)).rejects.toBeInstanceOf(CommandExecutionError);
    await expect(readdir(context.outputDir)).resolves.toEqual([]);
    await expect(readFile(context.source, 'utf8')).resolves.toBe('excel-data');
  });

  it('cleans a partial hidden temporary file when staging fails', async () => {
    const context = await setup();
    copyFile.mockImplementationOnce(async (_source, target) => {
      await actualFs.writeFile(target, 'partial');
      throw Object.assign(new Error('disk failure'), { code: 'EIO' });
    });

    await expect(downloadPublishData(context.page, context.options)).rejects.toBeInstanceOf(CommandExecutionError);
    await expect(readdir(context.outputDir)).resolves.toEqual([]);
    await expect(readFile(context.source, 'utf8')).resolves.toBe('excel-data');
  });

  it('requires browser download waiting support', async () => {
    const context = await setup();
    delete context.page.waitForDownload;

    await expect(downloadPublishData(context.page, context.options)).rejects.toBeInstanceOf(CommandExecutionError);
    expect(context.page.goto).not.toHaveBeenCalled();
  });
});
