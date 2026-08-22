import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { emptySearchResults, requireBoundedInteger, requireSearchQuery, runBrowserStep } from '../_shared/search-adapter.js';

const SCOPES = ['projects', 'issues', 'merge_requests', 'commits', 'blobs', 'users'];
const ORDER = ['created_at', 'updated_at', 'latest_activity_at']; const SORT = ['asc', 'desc'];

export function buildSearchUrl({ keyword, limit = 10, page = 1, scope = 'projects', orderBy, sort }) {
  const url = new URL('https://gitlab.com/search'); url.searchParams.set('search', keyword); url.searchParams.set('page', String(page)); url.searchParams.set('per_page', String(limit));
  if (scope) url.searchParams.set('scope', scope); if (orderBy) url.searchParams.set('order_by', orderBy); if (sort) url.searchParams.set('sort', sort); return url.toString();
}

function extractItems(scope) {
  const blocked = /sign in|login|access denied|captcha/i.test(document.body?.textContent || '') && !document.querySelector('.search-result-row, .search-results'); const items = []; const seen = new Set();
  for (const card of document.querySelectorAll('.search-result-row, .search-result-item, .search-results li')) {
    const anchor = card.querySelector('a.gl-link[href], a[href*="gitlab.com/"]'); if (!anchor || !/^https?:/i.test(anchor.href) || seen.has(anchor.href)) continue;
    seen.add(anchor.href); const time = card.querySelector('time'); const type = scope === 'issues' ? 'issue' : scope === 'merge_requests' ? 'merge_request' : scope === 'projects' ? 'project' : scope || 'result';
    items.push({ title: (anchor.textContent || '').trim(), url: anchor.href, snippet: (card.querySelector('.description, .description p, p')?.textContent || '').trim(), displayUrl: new URL(anchor.href).hostname + new URL(anchor.href).pathname, source: 'gitlab', resultType: type, author: (card.querySelector('.author, [data-testid="author"]')?.textContent || '').trim() || null, publishedAt: time?.getAttribute('datetime') || null, score: null, extra: {} });
  }
  return { blocked, items };
}

export const command = cli({
  site: 'gitlab', name: 'search', access: 'read', description: 'Search GitLab', domain: 'gitlab.com', strategy: Strategy.PUBLIC, browser: true,
  args: [{ name: 'keyword', positional: true, required: true, help: 'Search query' }, { name: 'limit', type: 'int', default: 10, help: 'Number of results (1-50)' }, { name: 'page', type: 'int', default: 1, help: 'Result page number' }, { name: 'scope', help: 'Search scope: projects, issues, merge_requests, commits, blobs, users' }, { name: 'order-by', help: 'Order by: created_at, updated_at, latest_activity_at' }, { name: 'sort', help: 'Sort direction: asc or desc' }],
  columns: ['rank', 'title', 'url', 'snippet', 'displayUrl', 'source', 'resultType', 'author', 'publishedAt', 'score', 'extra'],
  func: async (page, kwargs) => {
    const keyword = requireSearchQuery(kwargs.keyword); const limit = requireBoundedInteger(kwargs.limit, 10, 1, 50, '--limit'); const pageNumber = requireBoundedInteger(kwargs.page, 1, 1, 100, '--page'); const scope = kwargs.scope || 'projects'; const orderBy = kwargs['order-by'] ?? kwargs.orderBy; const sort = kwargs.sort;
    if (!SCOPES.includes(String(scope))) throw new ArgumentError(`--scope must be one of: ${SCOPES.join(', ')}`); if (orderBy && !ORDER.includes(String(orderBy))) throw new ArgumentError(`--order-by must be one of: ${ORDER.join(', ')}`); if (sort && !SORT.includes(String(sort))) throw new ArgumentError('--sort must be one of: asc, desc');
    await runBrowserStep('GitLab search navigation', () => page.goto(buildSearchUrl({ keyword, limit, page: pageNumber, scope, orderBy, sort }))); await page.wait({ selector: '.search-result-row, .search-results', timeout: 8 }).catch(() => page.wait(2).catch(() => {}));
    const data = await runBrowserStep('GitLab search extraction', () => page.evaluate(`(${extractItems.toString()})(${JSON.stringify(scope)})`)); if (data?.blocked) throw new CommandExecutionError('GitLab search requires sign-in or was blocked', 'Open GitLab in the browser, sign in if needed, and retry.'); if (!data?.items?.length) throw emptySearchResults('GitLab', keyword);
    return data.items.slice(0, limit).map((item, index) => ({ rank: (pageNumber - 1) * limit + index + 1, ...item }));
  },
});

export const __test__ = { command, buildSearchUrl };
