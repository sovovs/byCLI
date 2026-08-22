import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { emptySearchResults, requireBoundedInteger, requireSearchQuery, runBrowserStep } from '../_shared/search-adapter.js';

const SORTS = ['relevance', 'date'];

export function buildSearchUrl({ keyword, limit = 10, page = 1, lr, lang, sort }) {
  const url = new URL('https://yandex.com/search/');
  url.searchParams.set('text', keyword); url.searchParams.set('numdoc', String(limit)); url.searchParams.set('p', String(page - 1));
  if (lr) url.searchParams.set('lr', lr); if (lang) url.searchParams.set('lang', lang); if (sort === 'date') url.searchParams.set('how', 'tm');
  return url.toString();
}

function extractItems() {
  const blocked = /captcha|verify|access denied|consent/i.test(document.body?.textContent || '') && !document.querySelector('.serp-item');
  const items = []; const seen = new Set();
  for (const card of document.querySelectorAll('.serp-item')) {
    const anchor = card.querySelector('h2 a[href], .OrganicTitle a[href]'); if (!anchor || !/^https?:/i.test(anchor.href) || seen.has(anchor.href)) continue;
    seen.add(anchor.href); items.push({ title: (anchor.textContent || '').trim(), url: anchor.href, snippet: (card.querySelector('.OrganicText, .TextContainer')?.textContent || '').trim(), displayUrl: (card.querySelector('.Path, .OrganicUrl')?.textContent || '').trim(), resultType: 'web', extra: {} });
  }
  return { blocked, items };
}

export const command = cli({
  site: 'yandex', name: 'search', access: 'read', description: 'Search Yandex', domain: 'yandex.com', strategy: Strategy.PUBLIC, browser: true,
  args: [
    { name: 'keyword', positional: true, required: true, help: 'Search query' }, { name: 'limit', type: 'int', default: 10, help: 'Number of results (1-50)' }, { name: 'page', type: 'int', default: 1, help: 'Result page number' },
    { name: 'lr', help: 'Yandex region code' }, { name: 'lang', help: 'Language code' }, { name: 'sort', help: 'Sort order: relevance or date' },
  ],
  columns: ['rank', 'title', 'url', 'snippet', 'displayUrl', 'source', 'resultType', 'author', 'publishedAt', 'score', 'extra'],
  func: async (page, kwargs) => {
    const keyword = requireSearchQuery(kwargs.keyword); const limit = requireBoundedInteger(kwargs.limit, 10, 1, 50, '--limit'); const pageNumber = requireBoundedInteger(kwargs.page, 1, 1, 100, '--page');
    if (kwargs.sort !== undefined && !SORTS.includes(String(kwargs.sort))) throw new ArgumentError('--sort must be one of: relevance, date');
    await runBrowserStep('Yandex search navigation', () => page.goto(buildSearchUrl({ keyword, limit, page: pageNumber, lr: kwargs.lr, lang: kwargs.lang, sort: kwargs.sort })));
    await page.wait({ selector: '.serp-item', timeout: 8 }).catch(() => page.wait(2).catch(() => {}));
    const data = await runBrowserStep('Yandex search extraction', () => page.evaluate(`(${extractItems.toString()})()`));
    if (data?.blocked) throw new CommandExecutionError('Yandex search was blocked by a consent or verification page', 'Complete the page prompt in the browser and retry.');
    if (!data?.items?.length) throw emptySearchResults('Yandex', keyword);
    return data.items.slice(0, limit).map((item, index) => ({ rank: (pageNumber - 1) * limit + index + 1, ...item, source: 'yandex', author: null, publishedAt: null, score: null }));
  },
});

export const __test__ = { command, buildSearchUrl };
