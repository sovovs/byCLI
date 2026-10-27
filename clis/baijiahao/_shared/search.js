import { ArgumentError, CommandExecutionError, EmptyResultError, TimeoutError } from '@sovovs/bycli/errors';
import { requireBoundedInteger, requireSearchQuery, unwrapBrowserResult } from '../../_shared/search-adapter.js';
import { publicTarget } from './model.js';

export const searchColumns = ['rank', 'id', 'title', 'author', 'duration', 'playsText', 'publishedAtText', 'url', 'source'];
export const searchArgs = [
  { name: 'query', positional: true, required: true, help: '公开视频关键词；使用好看视频原生检索' },
  { name: 'limit', type: 'int', default: 10, help: '最多返回 1–50 条；通过原生页面滚动加载' },
  { name: 'timeout', type: 'int', default: 30, help: '导航后的检索与滚动总等待秒数，1–120' },
];

export function searchOptions(args) {
  const query = requireSearchQuery(args.query, 'query');
  if (query.length > 255) throw new ArgumentError('query must be at most 255 characters');
  return { query, limit: requireBoundedInteger(args.limit, 10, 1, 50, '--limit'), timeout: requireBoundedInteger(args.timeout, 30, 1, 120, '--timeout') };
}

export function searchUrl(query) {
  const url = new URL('https://haokan.baidu.com/web/search/page');
  url.searchParams.set('query', query);
  // Select videos explicitly; the native page also has an author tab.
  url.searchParams.set('tab', 'video');
  return url.href;
}

// Extract only the native search list, never homepage/recommendation/ad links.
export function searchSnapshot() {
  const text = document.body?.innerText || document.body?.textContent || '';
  const list = document.querySelector('.tabs-content .message-list');
  const items = [...(list?.querySelectorAll(':scope > a.videolist') || [])].map(a => {
    const fields = [...a.querySelectorAll('.list-body p span')].map(e => (e.textContent || '').trim());
    const field = prefix => fields.find(t => t.startsWith(prefix))?.slice(prefix.length).trim() || null;
    return { url: a.href, title: a.querySelector('.list-body strong')?.textContent.trim() || '',
      author: field('视频作者：'), duration: a.querySelector('.list-header-avatar-videotime')?.textContent.trim() || null,
      playsText: field('播放量：'), publishedAtText: field('发布时间：') };
  });
  return { url: location.href, query: document.querySelector('#search_input')?.value ?? null,
    activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() || null,
    blocked: /安全验证|百度安全验证|访问过于频繁|请完成验证/.test(document.title + '\n' + text),
    items, ready: !!list, ended: !!document.querySelector('.tabs-content .message-list-footer'),
    empty: !!document.querySelector('.tabs-content .msg-empty-list .msg-empty-tips') };
}

export function searchRows(state, query) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.items)) throw new CommandExecutionError('Invalid Haokan search snapshot');
  if (state.blocked) throw new CommandExecutionError('Haokan search requires browser verification; complete it and retry');
  let url;
  try { url = new URL(state.url); } catch { /* Reject browser error pages below. */ }
  if (url?.origin !== 'https://haokan.baidu.com' || url.pathname !== '/web/search/page'
    || url.searchParams.getAll('query').length !== 1 || url.searchParams.get('query') !== query
    || url.searchParams.getAll('tab').length > 1 || (url.searchParams.get('tab') || 'video') !== 'video') {
    throw new CommandExecutionError('Haokan search navigation did not retain the requested video query');
  }
  if (state.query !== query || state.activeTab !== '视频') return null;
  if (!state.ready && !state.empty) return null;
  const rows = [], seen = new Set();
  for (const item of state.items) {
    // Preserve 64-bit IDs as strings and reuse the downloader's URL contract.
    let target;
    try { target = publicTarget(item?.url); }
    catch { throw new CommandExecutionError('Invalid public URL in the native Haokan video search list'); }
    if (target.source !== 'haokan-video' || typeof item.title !== 'string' || !item.title.trim()) {
      throw new CommandExecutionError('Unexpected item in the native Haokan video search list');
    }
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    rows.push({ rank: rows.length + 1, id: target.id, title: item.title.trim(), author: item.author,
      duration: item.duration, playsText: item.playsText, publishedAtText: item.publishedAtText,
      url: target.url, source: 'haokan' });
  }
  // An unrendered list is not evidence of zero matches.
  return rows.length || state.empty || state.ended ? rows : null;
}

export async function searchVideos(page, args) {
  const options = searchOptions(args);
  await page.goto(searchUrl(options.query), { stealth: false });
  const deadline = Date.now() + options.timeout * 1000;
  const read = async previousCount => {
    // Attempt cap also bounds calls when a test/client implements wait as a no-op.
    for (let n = 0; n <= options.timeout * 4; n++) {
      const state = unwrapBrowserResult(await page.evaluate(`(${searchSnapshot.toString()})()`));
      const rows = searchRows(state, options.query);
      if (rows !== null && (previousCount === null || state.items.length > previousCount || state.ended)) return { state, rows };
      if (Date.now() >= deadline) break;
      await page.wait(0.25);
    }
    throw new TimeoutError('Haokan native video search results', options.timeout);
  };
  let { state, rows } = await read(null);
  for (let load = 0; rows.length < options.limit && !state.ended && !state.empty; load++) {
    if (load >= 10) throw new CommandExecutionError('Haokan search reached its scroll bound before the requested limit');
    const count = state.items.length;
    await page.evaluate('(() => { window.scrollBy(0, -1); window.scrollTo(0, document.documentElement.scrollHeight); })()');
    ({ state, rows } = await read(count));
  }
  if (!rows.length) throw new EmptyResultError('baijiahao search', 'The native Haokan search page displayed no video results; this does not prove the index has no matches');
  return rows.slice(0, options.limit);
}
