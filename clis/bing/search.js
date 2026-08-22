import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { emptySearchResults, requireBoundedInteger, requireSearchQuery, runBrowserStep } from '../_shared/search-adapter.js';

const FRESHNESS = ['day', 'week', 'month', 'year'];
const ANSWERS = ['web', 'news', 'video', 'images'];
const SAFE = ['off', 'moderate', 'strict'];

export function buildSearchUrl({ keyword, limit = 10, page = 1, freshness, market, answer, safe }) {
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('q', keyword);
  url.searchParams.set('count', String(limit));
  url.searchParams.set('first', String((page - 1) * limit + 1));
  if (freshness) url.searchParams.set('freshness', freshness);
  if (market) url.searchParams.set('cc', String(market).split('-').pop().toUpperCase());
  if (answer && answer !== 'web') url.searchParams.set('scope', answer);
  if (safe) url.searchParams.set('safesearch', safe);
  return url.toString();
}

function validate(value, choices, flag) {
  if (value !== undefined && !choices.includes(String(value))) throw new ArgumentError(`--${flag} must be one of: ${choices.join(', ')}`);
  return value === undefined ? undefined : String(value);
}

function extractItems() {
  const blocked = /unusual traffic|verify you are human|captcha|access denied/i.test(document.body?.textContent || '');
  const items = [];
  const seen = new Set();
  for (const card of document.querySelectorAll('li.b_algo')) {
    const anchor = card.querySelector('h2 a[href]');
    if (!anchor || !/^https?:/i.test(anchor.href) || seen.has(anchor.href)) continue;
    seen.add(anchor.href);
    items.push({ title: (anchor.textContent || '').trim(), url: anchor.href, snippet: (card.querySelector('.b_caption p')?.textContent || '').trim(), displayUrl: (card.querySelector('cite')?.textContent || '').trim(), resultType: 'web', extra: {} });
  }
  return { blocked, items };
}

export const command = cli({
  site: 'bing', name: 'search', access: 'read', description: 'Search Bing', domain: 'www.bing.com', strategy: Strategy.PUBLIC, browser: true,
  args: [
    { name: 'keyword', positional: true, required: true, help: 'Search query' }, { name: 'limit', type: 'int', default: 10, help: 'Number of results (1-50)' }, { name: 'page', type: 'int', default: 1, help: 'Result page number' },
    { name: 'freshness', help: 'Time range: day, week, month, year' }, { name: 'market', help: 'Market code such as en-US or zh-CN' }, { name: 'answer', help: 'Result scope: web, news, video, images' }, { name: 'safe', help: 'Safe search: off, moderate, strict' },
  ],
  columns: ['rank', 'title', 'url', 'snippet', 'displayUrl', 'source', 'resultType', 'author', 'publishedAt', 'score', 'extra'],
  func: async (page, kwargs) => {
    const keyword = requireSearchQuery(kwargs.keyword); const limit = requireBoundedInteger(kwargs.limit, 10, 1, 50, '--limit'); const pageNumber = requireBoundedInteger(kwargs.page, 1, 1, 100, '--page');
    const freshness = validate(kwargs.freshness, FRESHNESS, 'freshness'); const answer = validate(kwargs.answer, ANSWERS, 'answer'); const safe = validate(kwargs.safe, SAFE, 'safe');
    await runBrowserStep('Bing search navigation', () => page.goto(buildSearchUrl({ keyword, limit, page: pageNumber, freshness, market: kwargs.market, answer, safe })));
    await page.wait({ selector: 'li.b_algo', timeout: 8 }).catch(() => page.wait(2).catch(() => {}));
    const data = await runBrowserStep('Bing search extraction', () => page.evaluate(`(${extractItems.toString()})()`));
    if (data?.blocked) throw new CommandExecutionError('Bing search was blocked by a verification page', 'Complete the verification in the browser and retry.');
    if (!data?.items?.length) throw emptySearchResults('Bing', keyword);
    return data.items.slice(0, limit).map((item, index) => ({ rank: (pageNumber - 1) * limit + index + 1, ...item, source: 'bing', author: null, publishedAt: null, score: null }));
  },
});

export const __test__ = { command, buildSearchUrl };
