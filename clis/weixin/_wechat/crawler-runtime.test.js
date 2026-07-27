import { readFile } from 'node:fs/promises';
import crawler from '@sovovs/wechat-article-crawler';
import { describe, expect, it } from 'vitest';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import {
  CrawlerError,
  collectArticles,
  createWechatApi,
  isTrustedWechatArticleUrl,
  saveArticles,
  callCrawler,
} from './crawler-runtime.js';

describe('wechat crawler runtime', () => {
  it('loads the published crawler through CommonJS default interop', () => {
    expect(crawler).toMatchObject({
      CrawlerError: expect.any(Function),
      collectArticles: expect.any(Function),
      createWechatApi: expect.any(Function),
      isTrustedWechatArticleUrl: expect.any(Function),
      saveArticles: expect.any(Function),
    });
    expect({ CrawlerError, collectArticles, createWechatApi, isTrustedWechatArticleUrl, saveArticles })
      .toEqual(expect.objectContaining(crawler));
  });

  it.each([
    ['INVALID_ARGUMENT', ArgumentError],
    ['AUTH_REQUIRED', AuthRequiredError],
    ['REMOTE_ERROR', CommandExecutionError],
    ['DOWNLOAD_FAILED', CommandExecutionError],
    ['CONVERSION_FAILED', CommandExecutionError],
    ['FILESYSTEM_ERROR', CommandExecutionError],
  ])('maps crawler %s without exposing details', async (code, ExpectedError) => {
    const detailsToken = `private-${code}-token`;
    const crawlerError = new CrawlerError(code, `crawler message for ${code}`, { detailsToken });
    let error;
    try {
      await callCrawler(async () => { throw crawlerError; });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ExpectedError);
    expect(error.message).toBe(`crawler message for ${code}`);
    expect(JSON.stringify(error)).not.toContain(detailsToken);
    expect(error.details).toBeUndefined();
    if (code === 'AUTH_REQUIRED') expect(error.domain).toBe('mp.weixin.qq.com');
  });

  it('preserves byCLI AuthRequiredError identity from injected callbacks', async () => {
    const authError = new AuthRequiredError('mp.weixin.qq.com', 'session expired');
    await expect(callCrawler(async () => { throw authError; })).rejects.toBe(authError);
  });

  it('returns the injected operation result', async () => {
    const result = { articles: [] };
    await expect(callCrawler(async () => result)).resolves.toBe(result);
  });

  it('imports only the crawler package root without child_process coupling', async () => {
    const source = await readFile(new URL('./crawler-runtime.js', import.meta.url), 'utf8');
    expect(source).toContain("import crawler from '@sovovs/wechat-article-crawler';");
    expect(source).not.toMatch(/@sovovs\/wechat-article-crawler\/(?:src|bin)\//);
    expect(source).not.toContain('child_process');
  });
});
