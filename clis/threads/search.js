import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { emptySearchResults, requireBoundedInteger, requireSearchQuery, runBrowserStep } from '../_shared/search-adapter.js';

export function buildSearchUrl({ keyword, limit = 10, page = 1, author, since, until }) {
  const url = new URL('https://www.threads.com/search'); url.searchParams.set('q', keyword); url.searchParams.set('limit', String(limit)); url.searchParams.set('page', String(page));
  if (author) url.searchParams.set('author', String(author).replace(/^@+/, '')); if (since) url.searchParams.set('since', since); if (until) url.searchParams.set('until', until); return url.toString();
}

function extractItems() {
  const body = document.body?.textContent || ''; const authRequired = /log in|sign up|登录|注册/i.test(body) && !document.querySelector('article[data-pressable-container], article'); const blocked = /captcha|unusual activity|try again later|暂时无法/i.test(body); const items = []; const seen = new Set();
  for (const card of document.querySelectorAll('article[data-pressable-container], article')) {
    const anchor = card.querySelector('a[href*="/post/"]'); if (!anchor || !/^https?:/i.test(anchor.href) || seen.has(anchor.href)) continue; seen.add(anchor.href);
    const authorAnchor = card.querySelector('a[href^="/@"], a[href*="/@"]'); const author = (authorAnchor?.textContent || authorAnchor?.getAttribute('href') || '').trim().replace(/^@+/, '').replace(/^\//, '').split('/')[0] || null; const time = card.querySelector('time');
    items.push({ title: (card.querySelector('.text, [data-pressable-container] div')?.textContent || card.textContent || '').trim().slice(0, 500), url: anchor.href, snippet: (card.textContent || '').trim().slice(0, 500), displayUrl: new URL(anchor.href).hostname + new URL(anchor.href).pathname, source: 'threads', resultType: 'post', author, publishedAt: time?.getAttribute('datetime') || null, score: null, extra: {} });
  }
  return { authRequired, blocked, items };
}

export const command = cli({
  site: 'threads', name: 'search', access: 'read', description: 'Search Threads', domain: 'www.threads.com', strategy: Strategy.PUBLIC, browser: true,
  args: [{ name: 'keyword', positional: true, required: true, help: 'Search query' }, { name: 'limit', type: 'int', default: 10, help: 'Number of posts (1-50)' }, { name: 'page', type: 'int', default: 1, help: 'Result page number' }, { name: 'author', help: 'Filter by author handle' }, { name: 'since', help: 'Only posts on or after YYYY-MM-DD' }, { name: 'until', help: 'Only posts on or before YYYY-MM-DD' }],
  columns: ['rank', 'title', 'url', 'snippet', 'displayUrl', 'source', 'resultType', 'author', 'publishedAt', 'score', 'extra'],
  func: async (page, kwargs) => {
    const keyword = requireSearchQuery(kwargs.keyword); const limit = requireBoundedInteger(kwargs.limit, 10, 1, 50, '--limit'); const pageNumber = requireBoundedInteger(kwargs.page, 1, 1, 100, '--page');
    for (const [value, flag] of [[kwargs.since, 'since'], [kwargs.until, 'until']]) if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new ArgumentError(`--${flag} must use YYYY-MM-DD format`);
    await runBrowserStep('Threads search navigation', () => page.goto(buildSearchUrl({ keyword, limit, page: pageNumber, author: kwargs.author, since: kwargs.since, until: kwargs.until }))); await page.wait({ selector: 'article', timeout: 8 }).catch(() => page.wait(2).catch(() => {}));
    const data = await runBrowserStep('Threads search extraction', () => page.evaluate(`(${extractItems.toString()})()`)); if (data?.authRequired) throw new AuthRequiredError('Threads search requires login', 'Open Threads in the browser and sign in before retrying.'); if (data?.blocked) throw new CommandExecutionError('Threads search was blocked by an anti-bot page', 'Complete the browser prompt and retry.'); if (!data?.items?.length) throw emptySearchResults('Threads', keyword);
    return data.items.slice(0, limit).map((item, index) => ({ rank: (pageNumber - 1) * limit + index + 1, ...item }));
  },
});

export const __test__ = { command, buildSearchUrl };
