import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError } from '@sovovs/bycli/errors';
import { clampInt, requireNonEmptyQuery } from '../_shared/common.js';

const JUEJIN_SEARCH_TYPES = new Map([
    ['0', '综合搜索'],
    ['2', '文章搜索'],
    ['12', '课程搜索'],
    ['9', '标签搜索'],
    ['1', '用户搜索'],
]);

const JUEJIN_SORT_TYPES = new Map([
    ['0', '综合排序'],
    ['1', '最新优先'],
    ['2', '最热优先'],
]);

function normalizeSearchType(raw) {
    const value = String(raw ?? 0).trim();
    if (JUEJIN_SEARCH_TYPES.has(value)) return value;
    throw new ArgumentError('type must be one of: 0, 2, 12, 9, 1', '掘金搜索类型：0=综合搜索，2=文章搜索，12=课程搜索，9=标签搜索，1=用户搜索。');
}

function normalizeSortType(raw) {
    const value = String(raw ?? 0).trim();
    if (JUEJIN_SORT_TYPES.has(value)) return value;
    throw new ArgumentError('sort must be one of: 0, 1, 2', '掘金排序类型：0=综合排序，1=最新优先，2=最热优先。');
}

cli({
    site: 'juejin',
    name: 'search',
    access: 'read',
    description: '掘金搜索',
    domain: 'juejin.cn',
    strategy: Strategy.PUBLIC,
    browser: true,
    args: [
        { name: 'query', positional: true, required: true, help: '搜索关键词' },
        { name: 'limit', type: 'int', default: 10, help: '返回结果数量 (max 20)' },
        { name: 'type', type: 'int', default: 0, choices: ['0', '2', '12', '9', '1'], help: '搜索类型：0=综合搜索，2=文章搜索，12=课程搜索，9=标签搜索，1=用户搜索' },
        { name: 'sort', type: 'int', default: 0, choices: ['0', '1', '2'], help: '排序类型：0=综合排序，1=最新优先，2=最热优先' },
    ],
    columns: ['rank', 'title', 'author', 'summary', 'url'],
    func: async (page, kwargs) => {
        const limit = clampInt(kwargs.limit, 10, 1, 20);
        const query = requireNonEmptyQuery(kwargs.query);
        const searchType = normalizeSearchType(kwargs.type);
        const sortType = normalizeSortType(kwargs.sort);
        await page.goto(`https://juejin.cn/search?query=${encodeURIComponent(query)}&sort=${sortType}&type=${searchType}`);
        await page.wait(3);
        const data = await page.evaluate(`
      (async () => {
        const normalize = v => (v || '').replace(/\\s+/g, ' ').trim();
        const absoluteUrl = href => {
          if (!href) return '';
          try { return new URL(href, location.origin).href; } catch { return ''; }
        };
        for (let i = 0; i < 20; i++) {
          if (document.querySelector('a[href*="/post/"], a[href*="/article/"]')) break;
          await new Promise(r => setTimeout(r, 500));
        }

        const seen = new Set();
        const rows = [];
        const titleSelectors = [
          '.title',
        ];
        const authorSelectors = [
          '.user-popover',
        ];
        const summarySelectors = [
          '.abstract',
        ];

        for (const anchor of document.querySelectorAll('a[href*="/post/"], a[href*="/article/"]')) {
          const url = absoluteUrl(anchor.getAttribute('href'));
          if (!url || seen.has(url)) continue;
          seen.add(url);

          const container = anchor.closest('article, li, .item, .result-item, .entry, .entry-list, .content-box, [class*="result"], [class*="item"]') || anchor.parentElement;
          const pickText = selectors => {
            for (const selector of selectors) {
              const el = container?.querySelector(selector);
              const text = normalize(el?.textContent);
              if (text) return text;
            }
            return '';
          };

          const title = normalize(pickText(titleSelectors) || anchor.textContent);
          if (!title || title.length < 2) continue;

          let author = pickText(authorSelectors);
          if (author === title) author = '';

          let summary = pickText(summarySelectors);
          if (!summary && container) {
            const text = normalize(container.textContent);
            summary = text
              .replace(title, '')
              .replace(author, '')
              .replace(/\\d+\\s*(点赞|评论|阅读|收藏)/g, '')
              .trim();
          }
          if (summary.length > 180) summary = summary.slice(0, 180);

          rows.push({
            rank: rows.length + 1,
            title,
            author,
            summary,
            url,
          });
          if (rows.length >= ${limit}) break;
        }
        return rows;
      })()
    `);
        return Array.isArray(data) ? data : [];
    },
});
