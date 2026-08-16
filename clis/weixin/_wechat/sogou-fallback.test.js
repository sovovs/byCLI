import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import {
  collectSogouAccountArticles,
  isExactAccountName,
  normalizeSogouPublishTimestamp,
} from './sogou-fallback.js';

function row(title, account, url, publishTimestamp, publishTime = `${publishTimestamp}`) {
  return { title, account, url, summary: `${title} summary`, publishTime, publishTimestamp };
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

  it('counts a recovered shell retry as one logical page and continues scanning', async () => {
    const shell = { blocked: false, empty: false, invalidCount: 0, rows: [] };
    const recovered = {
      blocked: false, empty: false, invalidCount: 0,
      rows: [row('Recovered', 'Example', 'https://weixin.sogou.com/link?url=recovered', 10)],
    };
    const exhausted = { blocked: false, empty: true, invalidCount: 0, rows: [] };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn()
        .mockResolvedValueOnce(shell)
        .mockResolvedValueOnce(recovered)
        .mockResolvedValueOnce(exhausted),
    };

    const result = await collectSogouAccountArticles({
      page, accountName: 'Example', maxPages: 3, resolveUrl: directResolver,
    });

    expect(result).toMatchObject({ coverage: 'search-exhausted', pagesScanned: 2 });
    expect(result.articles).toEqual([expect.objectContaining({ title: 'Recovered' })]);
    expect(page.goto.mock.calls.map(([url]) => new URL(url).searchParams.get('page')))
      .toEqual(['1', '1', '2']);
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

  it('reports when an empty exact-account result reached the page cap', async () => {
    const searchPage = vi.fn()
      .mockResolvedValueOnce(resultPage(1, [
        row('A', 'Example News', 'https://weixin.sogou.com/link?url=a', 2),
      ]))
      .mockResolvedValueOnce(resultPage(2, [
        row('B', 'Example Daily', 'https://weixin.sogou.com/link?url=b', 1),
      ]));

    const error = await collectSogouAccountArticles({
      page: {}, accountName: 'Example', maxPages: 2, searchPage, resolveUrl: directResolver,
    }).catch(value => value);

    expect(error).toMatchObject({ code: 'EMPTY_RESULT' });
    expect(error.hint).toMatch(/scanned 2 pages/i);
    expect(error.hint).toMatch(/page cap/i);
    expect(error.hint).toMatch(/later pages may still contain a match/i);
  });

  it('reports when an empty exact-account result exhausted Sogou search', async () => {
    const searchPage = vi.fn()
      .mockResolvedValueOnce(resultPage(1, [
        row('A', 'Example News', 'https://weixin.sogou.com/link?url=a', 1),
      ]))
      .mockResolvedValueOnce(emptyPage(2));

    const error = await collectSogouAccountArticles({
      page: {}, accountName: 'Example', searchPage, resolveUrl: directResolver,
    }).catch(value => value);

    expect(error).toMatchObject({ code: 'EMPTY_RESULT' });
    expect(error.hint).toContain('"Example"');
    expect(error.hint).toMatch(/search exhausted after 2 pages/i);
    expect(error.hint).not.toMatch(/later pages may still contain a match/i);
  });

  it.each([
    ['2026-08-14 08:30:15', Date.UTC(2026, 7, 14, 0, 30, 15) / 1000],
    ['2026/08/14 08:30', Date.UTC(2026, 7, 14, 0, 30, 0) / 1000],
    ['2026年8月14日', Date.UTC(2026, 7, 13, 16, 0, 0) / 1000],
  ])('normalizes rendered absolute China time: %s', (publishTime, expected) => {
    expect(normalizeSogouPublishTimestamp({
      publishTimestamp: null,
      publishTime,
      scanStartedAt: Date.UTC(2026, 7, 16, 4, 0, 0),
    })).toBe(expected);
  });

  it.each([
    ['3天前', Date.UTC(2026, 7, 13, 4, 0, 0) / 1000],
    ['前天 09:15', Date.UTC(2026, 7, 14, 1, 15, 0) / 1000],
  ])('normalizes rendered relative China time: %s', (publishTime, expected) => {
    expect(normalizeSogouPublishTimestamp({
      publishTimestamp: null,
      publishTime,
      scanStartedAt: Date.UTC(2026, 7, 16, 4, 0, 0),
    })).toBe(expected);
  });

  it('sorts supported rendered publication times newest first using one scan time', async () => {
    const scanStartedAt = Date.UTC(2026, 7, 16, 4, 0, 0);
    const searchPage = vi.fn()
      .mockResolvedValueOnce(resultPage(1, [
        row('Absolute', 'Example', 'https://weixin.sogou.com/link?url=absolute', null, '2026-08-14 08:00'),
        row('Yesterday', 'Example', 'https://weixin.sogou.com/link?url=yesterday', null, '昨天 23:30'),
        row('Hours', 'Example', 'https://weixin.sogou.com/link?url=hours', null, '2小时前'),
        row('Minutes', 'Example', 'https://weixin.sogou.com/link?url=minutes', null, '5分钟前'),
      ]))
      .mockResolvedValueOnce(emptyPage(2));

    const result = await collectSogouAccountArticles({
      page: {}, accountName: 'Example', scanStartedAt, searchPage, resolveUrl: directResolver,
    });

    expect(result.articles.map(article => article.title))
      .toEqual(['Minutes', 'Hours', 'Yesterday', 'Absolute']);
  });

  it('prefers raw timestamps and keeps equal or unknown rendered times stable', async () => {
    const scanStartedAt = Date.UTC(2026, 7, 16, 4, 0, 0);
    const rawFuture = Math.floor(scanStartedAt / 1000) + 3600;
    const searchPage = vi.fn()
      .mockResolvedValueOnce(resultPage(1, [
        row('Invalid first', 'Example', 'https://weixin.sogou.com/link?url=invalid-first', null, '2026-02-30'),
        row('Equal first', 'Example', 'https://weixin.sogou.com/link?url=equal-first', null, '2小时前'),
        row('Raw authoritative', 'Example', 'https://weixin.sogou.com/link?url=raw', rawFuture, '2020-01-01'),
        row('Equal second', 'Example', 'https://weixin.sogou.com/link?url=equal-second', null, '2小时前'),
        row('Unknown second', 'Example', 'https://weixin.sogou.com/link?url=unknown-second', null, 'not-a-date'),
      ]))
      .mockResolvedValueOnce(emptyPage(2));

    const result = await collectSogouAccountArticles({
      page: {}, accountName: 'Example', scanStartedAt, searchPage, resolveUrl: directResolver,
    });

    expect(result.articles.map(article => article.title)).toEqual([
      'Raw authoritative', 'Equal first', 'Equal second', 'Invalid first', 'Unknown second',
    ]);
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
