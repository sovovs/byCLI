import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { emptySearchResults, requireBoundedInteger, requireSearchQuery, runBrowserStep } from '../_shared/search-adapter.js';

const TYPES = ['web', 'news', 'video', 'image']; const TIMES = ['day', 'week', 'month', 'year']; const SORTS = ['relevance', 'date'];

export function buildSearchUrl({ keyword, limit = 10, page = 1, type, time, sort }) {
  const url = new URL('https://sogou.com/web'); url.searchParams.set('query', keyword); url.searchParams.set('num', String(limit)); url.searchParams.set('page', String(page));
  if (type && type !== 'web') url.searchParams.set('type', type); if (time) url.searchParams.set('tsn', time); if (sort === 'date') url.searchParams.set('sort', 'time'); return url.toString();
}

function extractItems() {
  const blocked = /验证码|安全验证|访问异常|请完成验证|captcha/i.test(document.body?.textContent || ''); const items = []; const seen = new Set();
  for (const card of document.querySelectorAll('.vrwrap, .rb')) {
    const anchor = card.querySelector('h3 a[href], h4 a[href]'); if (!anchor || !/^https?:/i.test(anchor.href) || seen.has(anchor.href)) continue;
    if (/推广|广告/.test(card.textContent || '')) continue; seen.add(anchor.href); items.push({ title: (anchor.textContent || '').trim(), url: anchor.href, snippet: (card.querySelector('.str_info, .ft, .text-layout')?.textContent || '').trim(), displayUrl: (card.querySelector('cite, .citeurl')?.textContent || '').trim(), resultType: 'web', extra: {} });
  }
  return { blocked, items };
}

export const command = cli({
  site: 'sogou', name: 'search', access: 'read', description: 'Search Sogou', domain: 'sogou.com', strategy: Strategy.PUBLIC, browser: true,
  args: [{ name: 'keyword', positional: true, required: true, help: 'Search query' }, { name: 'limit', type: 'int', default: 10, help: 'Number of results (1-50)' }, { name: 'page', type: 'int', default: 1, help: 'Result page number' }, { name: 'type', help: 'Result type: web, news, video, image' }, { name: 'time', help: 'Time range: day, week, month, year' }, { name: 'sort', help: 'Sort order: relevance or date' }],
  columns: ['rank', 'title', 'url', 'snippet', 'displayUrl', 'source', 'resultType', 'author', 'publishedAt', 'score', 'extra'],
  func: async (page, kwargs) => {
    const keyword = requireSearchQuery(kwargs.keyword); const limit = requireBoundedInteger(kwargs.limit, 10, 1, 50, '--limit'); const pageNumber = requireBoundedInteger(kwargs.page, 1, 1, 100, '--page');
    for (const [value, choices, flag] of [[kwargs.type, TYPES, 'type'], [kwargs.time, TIMES, 'time'], [kwargs.sort, SORTS, 'sort']]) if (value !== undefined && !choices.includes(String(value))) throw new ArgumentError(`--${flag} must be one of: ${choices.join(', ')}`);
    await runBrowserStep('Sogou search navigation', () => page.goto(buildSearchUrl({ keyword, limit, page: pageNumber, type: kwargs.type, time: kwargs.time, sort: kwargs.sort })));
    await page.wait({ selector: '.vrwrap, .rb', timeout: 8 }).catch(() => page.wait(2).catch(() => {})); const data = await runBrowserStep('Sogou search extraction', () => page.evaluate(`(${extractItems.toString()})()`));
    if (data?.blocked) throw new CommandExecutionError('Sogou search was blocked by a verification page', 'Complete the verification in the browser and retry.'); if (!data?.items?.length) throw emptySearchResults('Sogou', keyword);
    return data.items.slice(0, limit).map((item, index) => ({ rank: (pageNumber - 1) * limit + index + 1, ...item, source: 'sogou', author: null, publishedAt: null, score: null }));
  },
});

export const __test__ = { command, buildSearchUrl };
