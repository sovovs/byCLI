import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError } from '@sovovs/bycli/errors';
import { collectArticles, isUsableArticle } from './article-service.js';

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
});

describe('collectArticles', () => {
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
