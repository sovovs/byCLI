import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { emptySearchResults, requireBoundedInteger, requireSearchQuery, runBrowserStep } from '../_shared/search-adapter.js';

const TYPES = ['web', 'news', 'video', 'image']; const SAFE = ['off', 'on'];

export function buildSearchUrl({ keyword, limit = 10, page = 1, type, safe }) {
  const url = new URL('https://so.com/s'); url.searchParams.set('q', keyword); url.searchParams.set('pn', String(page)); url.searchParams.set('num', String(limit));
  if (type && type !== 'web') url.searchParams.set('type', type); if (safe) url.searchParams.set('safe', safe); return url.toString();
}

function extractItems() {
  const blocked = /验证码|安全验证|访问异常|captcha|access denied/i.test(document.body?.textContent || ''); const items = []; const seen = new Set();
  for (const card of document.querySelectorAll('.result, .res-list')) {
    if (/result-ad|ad-result|推广/.test(card.className || '') || /推广/.test(card.textContent || '')) continue;
    const anchor = card.querySelector('h3 a[href], h2 a[href]'); if (!anchor || !/^https?:/i.test(anchor.href) || seen.has(anchor.href)) continue;
    seen.add(anchor.href); items.push({ title: (anchor.textContent || '').trim(), url: anchor.href, snippet: (card.querySelector('.res-desc, .res-rich, p')?.textContent || '').trim(), displayUrl: (card.querySelector('cite, .res-link')?.textContent || '').trim(), resultType: 'web', extra: {} });
  }
  return { blocked, items };
}

export const command = cli({
  site: 'so', name: 'search', access: 'read', description: 'Search 360 Search', domain: 'so.com', strategy: Strategy.PUBLIC, browser: true,
  args: [{ name: 'keyword', positional: true, required: true, help: 'Search query' }, { name: 'limit', type: 'int', default: 10, help: 'Number of results (1-50)' }, { name: 'page', type: 'int', default: 1, help: 'Result page number' }, { name: 'type', help: 'Result type: web, news, video, image' }, { name: 'safe', help: 'Safe search: off or on' }],
  columns: ['rank', 'title', 'url', 'snippet', 'displayUrl', 'source', 'resultType', 'author', 'publishedAt', 'score', 'extra'],
  func: async (page, kwargs) => {
    const keyword = requireSearchQuery(kwargs.keyword); const limit = requireBoundedInteger(kwargs.limit, 10, 1, 50, '--limit'); const pageNumber = requireBoundedInteger(kwargs.page, 1, 1, 100, '--page');
    if (kwargs.type !== undefined && !TYPES.includes(String(kwargs.type))) throw new ArgumentError(`--type must be one of: ${TYPES.join(', ')}`); if (kwargs.safe !== undefined && !SAFE.includes(String(kwargs.safe))) throw new ArgumentError('--safe must be one of: off, on');
    await runBrowserStep('360 search navigation', () => page.goto(buildSearchUrl({ keyword, limit, page: pageNumber, type: kwargs.type, safe: kwargs.safe })));
    await page.wait({ selector: '.result, .res-list', timeout: 8 }).catch(() => page.wait(2).catch(() => {})); const data = await runBrowserStep('360 search extraction', () => page.evaluate(`(${extractItems.toString()})()`));
    if (data?.blocked) throw new CommandExecutionError('360 Search was blocked by a verification page', 'Complete the verification in the browser and retry.'); if (!data?.items?.length) throw emptySearchResults('360 Search', keyword);
    return data.items.slice(0, limit).map((item, index) => ({ rank: (pageNumber - 1) * limit + index + 1, ...item, source: 'so', author: null, publishedAt: null, score: null }));
  },
});

export const __test__ = { command, buildSearchUrl };
