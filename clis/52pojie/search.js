import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { emptySearchResults, requireBoundedInteger, requireSearchQuery, runBrowserStep } from '../_shared/search-adapter.js';

const SORTS = ['relevance', 'latest', 'replies', 'views'];

export function buildSearchUrl({ keyword, limit = 10, page = 1, section, sort }) {
  const url = new URL('https://www.52pojie.cn/search.php'); url.searchParams.set('srchtxt', keyword); url.searchParams.set('page', String(page)); url.searchParams.set('perpage', String(limit));
  if (section) url.searchParams.set('section', section); if (sort) url.searchParams.set('sort', sort); return url.toString();
}

function extractItems() {
  const body = document.body?.textContent || ''; const blocked = /验证码|访问频繁|captcha|access denied/i.test(body); const items = []; const seen = new Set(); const numberFrom = (card, selector) => { const value = (card.querySelector(selector)?.textContent || '').replace(/[^\d.]/g, ''); return value ? Number(value) : null; };
  for (const card of document.querySelectorAll('.forum-item, .search-list li, .sltm')) {
    const anchor = card.querySelector('.thread-title[href], h3 a[href], h2 a[href]'); if (!anchor || !/^https?:/i.test(anchor.href) || seen.has(anchor.href)) continue; seen.add(anchor.href); const time = card.querySelector('time');
    items.push({ title: (anchor.textContent || '').trim(), url: anchor.href, snippet: (card.querySelector('.summary, .desc, p')?.textContent || '').trim(), displayUrl: new URL(anchor.href).hostname + new URL(anchor.href).pathname, source: '52pojie', resultType: 'thread', author: (card.querySelector('.author, .username')?.textContent || '').trim() || null, publishedAt: time?.getAttribute('datetime') || null, score: null, extra: { replies: numberFrom(card, '.replies, .reply'), views: numberFrom(card, '.views, .view'), section: (card.querySelector('.section, .forum')?.textContent || '').trim() || null } });
  }
  return { blocked, items };
}

export const command = cli({
  site: '52pojie', name: 'search', access: 'read', description: 'Search 52pojie', domain: 'www.52pojie.cn', strategy: Strategy.PUBLIC, browser: true,
  args: [{ name: 'keyword', positional: true, required: true, help: 'Search query' }, { name: 'limit', type: 'int', default: 10, help: 'Number of threads (1-50)' }, { name: 'page', type: 'int', default: 1, help: 'Result page number' }, { name: 'section', help: 'Forum section identifier' }, { name: 'sort', help: 'Sort order: relevance, latest, replies, views' }],
  columns: ['rank', 'title', 'url', 'snippet', 'displayUrl', 'source', 'resultType', 'author', 'publishedAt', 'score', 'extra'],
  func: async (page, kwargs) => {
    const keyword = requireSearchQuery(kwargs.keyword); const limit = requireBoundedInteger(kwargs.limit, 10, 1, 50, '--limit'); const pageNumber = requireBoundedInteger(kwargs.page, 1, 1, 100, '--page'); if (kwargs.sort && !SORTS.includes(String(kwargs.sort))) throw new ArgumentError(`--sort must be one of: ${SORTS.join(', ')}`);
    await runBrowserStep('52pojie search navigation', () => page.goto(buildSearchUrl({ keyword, limit, page: pageNumber, section: kwargs.section, sort: kwargs.sort }))); await page.wait({ selector: '.forum-item, .search-list, .sltm', timeout: 8 }).catch(() => page.wait(2).catch(() => {})); const data = await runBrowserStep('52pojie search extraction', () => page.evaluate(`(${extractItems.toString()})()`));
    if (data?.blocked) throw new CommandExecutionError('52pojie search was blocked by a verification page', 'Complete the verification in the browser and retry.'); if (!data?.items?.length) throw emptySearchResults('52pojie', keyword); return data.items.slice(0, limit).map((item, index) => ({ rank: (pageNumber - 1) * limit + index + 1, ...item }));
  },
});

export const __test__ = { command, buildSearchUrl };
