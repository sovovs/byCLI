import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { emptySearchResults, requireBoundedInteger, requireNonNegativeInteger, requireSearchQuery, runBrowserStep, toHttpsUrl } from '../_shared/search-adapter.js';

const TYPES = ['web', 'news', 'image', 'video'];
const FILETYPES = ['pdf', 'doc', 'xls', 'ppt', 'rtf', 'all'];

export function buildSearchUrl({ keyword, limit = 10, page = 1, site, filetype, platform, time }) {
  const url = new URL('https://www.baidu.com/s');
  url.searchParams.set('wd', keyword);
  url.searchParams.set('pn', String((page - 1) * limit));
  if (site) url.searchParams.set('si', site);
  if (filetype) url.searchParams.set('ft', filetype);
  if (platform) url.searchParams.set('ie', platform === 'mobile' ? 'utf-8' : 'utf-8');
  if (time) url.searchParams.set('gpc', `stf=${time}`);
  return url.toString();
}

function validateChoice(value, choices, flag) {
  if (value !== undefined && !choices.includes(String(value))) throw new ArgumentError(`--${flag} must be one of: ${choices.join(', ')}`);
  return value === undefined ? undefined : String(value);
}

function extractItems() {
  const blocked = /验证码|安全验证|百度安全验证|访问过于频繁|请完成验证/.test(document.body?.textContent || '');
  const items = [];
  const seen = new Set();
  for (const card of document.querySelectorAll('.result, .c-container')) {
    const anchor = card.querySelector('h3 a, h3 a[href]');
    if (!anchor) continue;
    const url = anchor.href || '';
    if (!/^https?:/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    items.push({ title: (anchor.textContent || '').trim(), url, snippet: (card.querySelector('.c-abstract, .content-right_8Zs40, .c-span-last')?.textContent || '').trim(), displayUrl: (card.querySelector('.c-showurl, .c-color-gray2')?.textContent || '').trim(), resultType: 'web', extra: {} });
  }
  return { blocked, items };
}

export const command = cli({
  site: 'baidu', name: 'search', access: 'read', description: 'Search Baidu', domain: 'www.baidu.com', strategy: Strategy.PUBLIC, browser: true,
  args: [
    { name: 'keyword', positional: true, required: true, help: 'Search query' },
    { name: 'limit', type: 'int', default: 10, help: 'Number of results (1-50)' },
    { name: 'page', type: 'int', default: 1, help: 'Result page number' },
    { name: 'site', help: 'Restrict results to a domain' },
    { name: 'filetype', help: 'File type: pdf, doc, xls, ppt, rtf, all' },
    { name: 'platform', help: 'Client platform: pc or mobile' },
    { name: 'time', help: 'Recent time filter understood by Baidu' },
  ],
  columns: ['rank', 'title', 'url', 'snippet', 'displayUrl', 'source', 'resultType', 'author', 'publishedAt', 'score', 'extra'],
  func: async (page, kwargs) => {
    const keyword = requireSearchQuery(kwargs.keyword);
    const limit = requireBoundedInteger(kwargs.limit, 10, 1, 50, '--limit');
    const pageNumber = requireBoundedInteger(kwargs.page, 1, 1, 100, '--page');
    const filetype = validateChoice(kwargs.filetype, FILETYPES, 'filetype');
    const platform = validateChoice(kwargs.platform, ['pc', 'mobile'], 'platform');
    const raw = await runBrowserStep('Baidu search navigation', () => page.goto(buildSearchUrl({ keyword, limit, page: pageNumber, site: kwargs.site, filetype, platform, time: kwargs.time })));
    void raw;
    await page.wait({ selector: '.result, .c-container', timeout: 8 }).catch(() => page.wait(2).catch(() => {}));
    const data = await runBrowserStep('Baidu search extraction', () => page.evaluate(`(${extractItems.toString()})()`));
    if (data?.blocked) throw new CommandExecutionError('Baidu search was blocked by a verification page', 'Complete the verification in the browser and retry.');
    const items = data?.items || [];
    if (!items.length) throw emptySearchResults('Baidu', keyword);
    return items.slice(0, limit).map((item, index) => ({ rank: (pageNumber - 1) * limit + index + 1, ...item, source: 'baidu', author: null, publishedAt: null, score: null }));
  },
});

export const __test__ = { command, buildSearchUrl };
