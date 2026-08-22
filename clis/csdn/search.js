import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { emptySearchResults, requireBoundedInteger, requireSearchQuery, runBrowserStep } from '../_shared/search-adapter.js';

const TYPES = ['all', 'blog', 'download', 'course']; const SORTS = ['relevance', 'latest', 'hot']; const TIMES = ['day', 'week', 'month', 'year'];

export function buildSearchUrl({ keyword, limit = 10, page = 1, contentType = 'all', sort, time }) {
  const url = new URL('https://so.csdn.net/so/search'); url.searchParams.set('q', keyword); url.searchParams.set('p', String(page)); url.searchParams.set('t', contentType); url.searchParams.set('size', String(limit));
  if (sort) url.searchParams.set('sort', sort); if (time) url.searchParams.set('time', time); return url.toString();
}

function extractItems() {
  const blocked = /登录|验证码|访问异常|captcha|sign in/i.test(document.body?.textContent || '') && !document.querySelector('.search-result-info, .search-result'); const items = []; const seen = new Set();
  for (const card of document.querySelectorAll('.search-result-info, .search-result')) {
    const anchor = card.querySelector('h3 a[href], h4 a[href]'); if (!anchor || !/^https?:/i.test(anchor.href) || seen.has(anchor.href)) continue;
    seen.add(anchor.href); const time = card.querySelector('time'); items.push({ rank: items.length + 1, title: (anchor.textContent || '').trim(), url: anchor.href, snippet: (card.querySelector('.search-result-desc, p')?.textContent || '').trim(), displayUrl: new URL(anchor.href).hostname + new URL(anchor.href).pathname, source: 'csdn', resultType: 'article', author: (card.querySelector('.author, .user-name')?.textContent || '').trim() || null, publishedAt: time?.getAttribute('datetime') || null, score: null, extra: {} });
  }
  return { blocked, items };
}

export const command = cli({
  site: 'csdn', name: 'search', access: 'read', description: 'Search CSDN', domain: 'so.csdn.net', strategy: Strategy.PUBLIC, browser: true,
  args: [{ name: 'keyword', positional: true, required: true, help: 'Search query' }, { name: 'limit', type: 'int', default: 10, help: 'Number of results (1-50)' }, { name: 'page', type: 'int', default: 1, help: 'Result page number' }, { name: 'content-type', help: 'Content type: all, blog, download, course' }, { name: 'sort', help: 'Sort order: relevance, latest, hot' }, { name: 'time', help: 'Time range: day, week, month, year' }],
  columns: ['rank', 'title', 'url', 'snippet', 'displayUrl', 'source', 'resultType', 'author', 'publishedAt', 'score', 'extra'],
  func: async (page, kwargs) => {
    const keyword = requireSearchQuery(kwargs.keyword); const limit = requireBoundedInteger(kwargs.limit, 10, 1, 50, '--limit'); const pageNumber = requireBoundedInteger(kwargs.page, 1, 1, 100, '--page'); const contentType = kwargs['content-type'] ?? kwargs.contentType ?? 'all';
    if (!TYPES.includes(String(contentType))) throw new ArgumentError(`--content-type must be one of: ${TYPES.join(', ')}`); if (kwargs.sort && !SORTS.includes(String(kwargs.sort))) throw new ArgumentError(`--sort must be one of: ${SORTS.join(', ')}`); if (kwargs.time && !TIMES.includes(String(kwargs.time))) throw new ArgumentError(`--time must be one of: ${TIMES.join(', ')}`);
    await runBrowserStep('CSDN search navigation', () => page.goto(buildSearchUrl({ keyword, limit, page: pageNumber, contentType, sort: kwargs.sort, time: kwargs.time }))); await page.wait({ selector: '.search-result-info, .search-result', timeout: 8 }).catch(() => page.wait(2).catch(() => {}));
    const data = await runBrowserStep('CSDN search extraction', () => page.evaluate(`(${extractItems.toString()})()`)); if (data?.blocked) throw new CommandExecutionError('CSDN search requires login or was blocked', 'Open CSDN in the browser, complete any prompt, and retry.'); if (!data?.items?.length) throw emptySearchResults('CSDN', keyword);
    return data.items.slice(0, limit).map((item, index) => ({ ...item, rank: (pageNumber - 1) * limit + index + 1 }));
  },
});

export const __test__ = { command, buildSearchUrl };
