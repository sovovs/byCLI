import { describe, expect, it, vi } from 'vitest';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import {
  MAX_ARTICLES, MAX_PAGES, MAX_PAGE_SIZE, collectArticles, isUsableArticle,
  isTrustedWechatArticleUrl,
} from './article-service.js';

const article = (id, extra = {}) => ({
  title: id,
  url: `https://mp.weixin.qq.com/s/${id}`,
  publishedAt: null,
  digest: '',
  author: '',
  ...extra,
});

describe('isUsableArticle', () => {
  it('rejects missing, deleted, empty URL, and tempkey articles', () => {
    expect(isUsableArticle(article('ok'))).toBe(true);
    expect(isUsableArticle(null)).toBe(false);
    expect(isUsableArticle(article('deleted', { isDeleted: true }))).toBe(false);
    expect(isUsableArticle(article('empty', { url: '' }))).toBe(false);
    expect(isUsableArticle(article('temp', { url: 'https://mp.weixin.qq.com/s/x?tempkey=1' }))).toBe(false);
  });

  it.each([
    'http://mp.weixin.qq.com/s/x',
    'https://user:pass@mp.weixin.qq.com/s/x',
    'https://mp.weixin.qq.com:444/s/x',
    'https://mp.weixin.qq.com.evil.test/s/x',
    'https://localhost/s/x',
    'data:text/html,x',
    'file:///etc/passwd',
    'https://mp.weixin.qq.com/cgi-bin/home',
  ])('rejects untrusted article URL %s', url => {
    expect(isTrustedWechatArticleUrl(url)).toBe(false);
    expect(isUsableArticle(article('bad', { url }))).toBe(false);
  });

  it.each([
    'https://mp.weixin.qq.com/s/x',
    'https://mp.weixin.qq.com/s?__biz=x&mid=1',
  ])('accepts trusted article URL %s', url => {
    expect(isTrustedWechatArticleUrl(url)).toBe(true);
  });
});

describe('collectArticles', () => {
  it.each([
    ['pageSize', 0], ['pageSize', -1], ['pageSize', 1.5], ['pageSize', Infinity],
    ['limit', 0], ['limit', -1], ['limit', 1.5], ['limit', Number.MAX_SAFE_INTEGER + 1],
    ['maxPages', 0], ['maxPages', -1], ['maxPages', 1.5], ['maxPages', Infinity],
  ])('rejects invalid %s=%s before requesting a page', async (key, value) => {
    const fetchPage = vi.fn();
    const options = { fakeid: 'id', fetchPage, [key]: value };
    await expect(collectArticles(options)).rejects.toBeInstanceOf(ArgumentError);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it.each([
    ['pageSize', 11], ['pageSize', Number.MAX_SAFE_INTEGER],
    ['limit', 1001], ['limit', Number.MAX_SAFE_INTEGER],
    ['maxPages', 101], ['maxPages', Number.MAX_SAFE_INTEGER],
  ])('rejects %s=%s above its absolute cap', async (key, value) => {
    const fetchPage = vi.fn();
    await expect(collectArticles({ fakeid: 'id', fetchPage, [key]: value }))
      .rejects.toBeInstanceOf(ArgumentError);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('exports absolute caps and accepts their boundary values', async () => {
    expect({ MAX_PAGES, MAX_PAGE_SIZE, MAX_ARTICLES }).toEqual({
      MAX_PAGES: 100, MAX_PAGE_SIZE: 10, MAX_ARTICLES: 1000,
    });
    const fetchPage = vi.fn().mockResolvedValue({ total: 0, publishItemCount: 0, articles: [] });
    await expect(collectArticles({
      fakeid: 'id', fetchPage, pageSize: MAX_PAGE_SIZE, limit: MAX_ARTICLES, maxPages: MAX_PAGES,
    })).resolves.toMatchObject({ summary: { pages: 1 } });
  });

  it('uses a documented default hard cap for full pages without an API total', async () => {
    expect(MAX_PAGES).toBe(100);
    const fetchPage = vi.fn(({ begin }) => Promise.resolve({
      total: 0,
      publishItemCount: 1,
      articles: [article(`a${begin}`)],
    }));
    const result = await collectArticles({ fakeid: 'id', fetchPage, pageSize: 1 });
    expect(result.summary.pages).toBe(MAX_PAGES);
    expect(fetchPage).toHaveBeenCalledTimes(MAX_PAGES);
  });

  it.each([
    [{ total: Infinity, publishItemCount: 1, articles: [] }],
    [{ total: -1, publishItemCount: 1, articles: [] }],
    [{ total: 1.5, publishItemCount: 1, articles: [] }],
    [{ total: null, publishItemCount: 1, articles: [] }],
    [{ total: 0, publishItemCount: Infinity, articles: [] }],
    [{ total: 0, publishItemCount: -1, articles: [] }],
    [{ total: 0, publishItemCount: 1.5, articles: [] }],
    [{ total: 0, publishItemCount: null, articles: [] }],
  ])('rejects invalid page response metadata', async page => {
    await expect(collectArticles({ fakeid: 'id', fetchPage: async () => page }))
      .rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('filters invalid entries and deduplicates canonical URLs in source order', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ total: 4, publishItemCount: 2, articles: [
        article('a'), article('deleted', { isDeleted: true }), article('dup', { url: 'https://mp.weixin.qq.com/s/a#section' }),
      ] })
      .mockResolvedValueOnce({ total: 4, publishItemCount: 2, articles: [article('b')] });
    const result = await collectArticles({ fakeid: 'id', fetchPage, pageSize: 2 });
    expect(result.articles.map(item => item.title)).toEqual(['a', 'b']);
    expect(result.summary).toEqual({ totalFromApi: 4, scanned: 4, valid: 2, invalid: 1, duplicates: 1, pages: 2 });
    expect(fetchPage.mock.calls.map(([value]) => value)).toEqual([
      { fakeid: 'id', begin: 0, count: 2 }, { fakeid: 'id', begin: 2, count: 2 },
    ]);
  });

  it('stops at limit and preserves the requested article shape', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ total: 100, publishItemCount: 2, articles: [article('a'), article('b')] });
    const result = await collectArticles({ fakeid: 'id', fetchPage, pageSize: 2, limit: 1 });
    expect(result.articles).toEqual([article('a')]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('stops at maxPages even when every page is full', async () => {
    const fetchPage = vi.fn(({ begin }) => Promise.resolve({ total: 100, publishItemCount: 2, articles: [article(`a${begin}`)] }));
    const result = await collectArticles({ fakeid: 'id', fetchPage, pageSize: 2, maxPages: 2 });
    expect(result.summary.pages).toBe(2);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['zero publish items', { total: 100, publishItemCount: 0, articles: [] }],
    ['short page', { total: 100, publishItemCount: 1, articles: [article('a')] }],
    ['API total', { total: 2, publishItemCount: 2, articles: [article('a')] }],
  ])('stops after one %s response', async (_name, page) => {
    const fetchPage = vi.fn().mockResolvedValue(page);
    await collectArticles({ fakeid: 'id', fetchPage, pageSize: 2 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('does not loop forever when the API omits progress metadata', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ total: 0, articles: [] });
    const result = await collectArticles({ fakeid: 'id', fetchPage, pageSize: 2 });
    expect(result.summary.pages).toBe(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('treats first-page authentication failure as authoritative', async () => {
    const authError = new AuthRequiredError('mp.weixin.qq.com', 'expired');
    const fetchPage = vi.fn().mockRejectedValueOnce(authError).mockResolvedValue({ total: 0, publishItemCount: 0, articles: [] });
    await expect(collectArticles({ fakeid: 'id', fetchPage })).rejects.toBe(authError);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
