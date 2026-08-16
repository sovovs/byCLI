import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import {
  collectSogouAccountArticles,
  isExactAccountName,
} from './sogou-fallback.js';

function row(title, account, url, publishTimestamp) {
  return { title, account, url, summary: `${title} summary`, publishTime: `${publishTimestamp}`, publishTimestamp };
}

function resultPage(page, rows, fingerprint = `page-${page}`) {
  return { state: 'results', page, rows, fingerprint };
}

function emptyPage(page) {
  return { state: 'empty', page, rows: [], fingerprint: '' };
}

function directResolver(_page, url) {
  const id = new URL(url).searchParams.get('url');
  return Promise.resolve({ sourceUrl: url, resolvedUrl: `https://mp.weixin.qq.com/s/${id}`, alreadyNavigated: true });
}

describe('exact-account Sogou fallback collector', () => {
  it('matches only trimmed case-insensitive account names', () => {
    expect(isExactAccountName(' Example ', 'example')).toBe(true);
    expect(isExactAccountName('Example News', 'Example')).toBe(false);
    expect(isExactAccountName('Exam ple', 'Example')).toBe(false);
    expect(isExactAccountName('Example！', 'Example')).toBe(false);
  });

  it('scans to an empty page, filters exact accounts, sorts newest first, then limits', async () => {
    const searchPage = vi.fn()
      .mockResolvedValueOnce(resultPage(1, [
        row('Old', 'Example', 'https://weixin.sogou.com/link?url=old', 10),
        row('Newest', 'example', 'https://weixin.sogou.com/link?url=new', 30),
        row('Wrong', 'Example News', 'https://weixin.sogou.com/link?url=wrong', 40),
      ]))
      .mockResolvedValueOnce(resultPage(2, [
        row('Middle', ' Example ', 'https://weixin.sogou.com/link?url=middle', 20),
      ]))
      .mockResolvedValueOnce(emptyPage(3));

    await expect(collectSogouAccountArticles({
      page: {}, accountName: 'Example', limit: 2, searchPage, resolveUrl: directResolver,
    })).resolves.toEqual({
      source: 'sogou',
      coverage: 'search-exhausted',
      pagesScanned: 3,
      articles: [
        expect.objectContaining({ title: 'Newest', url: 'https://mp.weixin.qq.com/s/new' }),
        expect.objectContaining({ title: 'Middle', url: 'https://mp.weixin.qq.com/s/middle' }),
      ],
      resolutionFailures: [],
    });
    expect(searchPage).toHaveBeenCalledTimes(3);
  });

  it('uses the 50-page default cap and reports capped coverage', async () => {
    const searchPage = vi.fn((_page, { pageNo }) => Promise.resolve(resultPage(pageNo, [
      row(`A${pageNo}`, 'Example', `https://weixin.sogou.com/link?url=${pageNo}`, pageNo),
    ])));

    const result = await collectSogouAccountArticles({
      page: {}, accountName: 'Example', limit: 1, searchPage, resolveUrl: directResolver,
    });

    expect(searchPage).toHaveBeenCalledTimes(50);
    expect(result).toMatchObject({ coverage: 'max-pages-reached', pagesScanned: 50 });
    expect(result.articles[0].title).toBe('A50');
  });

  it('rejects repeated result pages instead of treating them as completion', async () => {
    const searchPage = vi.fn()
      .mockResolvedValueOnce(resultPage(1, [row('A', 'Example', 'https://weixin.sogou.com/link?url=a', 2)], 'same'))
      .mockResolvedValueOnce(resultPage(2, [row('A', 'Example', 'https://weixin.sogou.com/link?url=a', 2)], 'same'));

    await expect(collectSogouAccountArticles({
      page: {}, accountName: 'Example', maxPages: 2, searchPage, resolveUrl: directResolver,
    })).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('deduplicates Sogou links and resolved WeChat URLs before filling the limit', async () => {
    const first = row('First', 'Example', 'https://weixin.sogou.com/link?url=first', 30);
    const duplicateSource = { ...first, title: 'First duplicate' };
    const sameFinal = row('Same final', 'Example', 'https://weixin.sogou.com/link?url=same-final', 20);
    const second = row('Second', 'Example', 'https://weixin.sogou.com/link?url=second', 10);
    const searchPage = vi.fn()
      .mockResolvedValueOnce(resultPage(1, [first, duplicateSource, sameFinal, second]))
      .mockResolvedValueOnce(emptyPage(2));
    const resolveUrl = vi.fn((_page, url) => Promise.resolve({
      sourceUrl: url,
      resolvedUrl: url.includes('same-final')
        ? 'https://mp.weixin.qq.com/s/first'
        : `https://mp.weixin.qq.com/s/${new URL(url).searchParams.get('url')}`,
      alreadyNavigated: true,
    }));

    const result = await collectSogouAccountArticles({
      page: {}, accountName: 'Example', limit: 2, searchPage, resolveUrl,
    });

    expect(result.articles.map(article => article.title)).toEqual(['First', 'Second']);
    expect(resolveUrl).toHaveBeenCalledTimes(3);
  });

  it('reports no exact account results without resolving or writing anything', async () => {
    const searchPage = vi.fn()
      .mockResolvedValueOnce(resultPage(1, [row('A', 'Example News', 'https://weixin.sogou.com/link?url=a', 1)]))
      .mockResolvedValueOnce(emptyPage(2));
    const resolveUrl = vi.fn();

    await expect(collectSogouAccountArticles({
      page: {}, accountName: 'Example', searchPage, resolveUrl,
    })).rejects.toBeInstanceOf(EmptyResultError);
    expect(resolveUrl).not.toHaveBeenCalled();
  });

  it('can preserve non-auth resolution failures as ordered rows but rethrows auth gates', async () => {
    const searchPage = vi.fn()
      .mockResolvedValueOnce(resultPage(1, [
        row('Broken', 'Example', 'https://weixin.sogou.com/link?url=broken', 20),
        row('Good', 'Example', 'https://weixin.sogou.com/link?url=good', 10),
      ]))
      .mockResolvedValueOnce(emptyPage(2));
    const resolveUrl = vi.fn((_page, url) => {
      if (url.includes('broken')) return Promise.reject(new CommandExecutionError('bad redirect'));
      return directResolver(_page, url);
    });

    const result = await collectSogouAccountArticles({
      page: {}, accountName: 'Example', searchPage, resolveUrl, resolutionPolicy: 'rows',
    });
    expect(result.articles).toEqual([expect.objectContaining({ title: 'Good', order: 1 })]);
    expect(result.resolutionFailures).toEqual([expect.objectContaining({
      title: 'Broken', status: 'failed', stage: 'resolve', order: 0,
    })]);

    const authSearchPage = vi.fn()
      .mockResolvedValueOnce(resultPage(1, [row('Blocked', 'Example', 'https://weixin.sogou.com/link?url=blocked', 1)]))
      .mockResolvedValueOnce(emptyPage(2));
    await expect(collectSogouAccountArticles({
      page: {}, accountName: 'Example', searchPage: authSearchPage,
      resolveUrl: () => Promise.reject(new AuthRequiredError('weixin.sogou.com')),
      resolutionPolicy: 'rows',
    })).rejects.toBeInstanceOf(AuthRequiredError);
  });
});
