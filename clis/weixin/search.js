import { EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import {
  normalizePositiveInteger,
  searchSogouArticlePage,
} from './_wechat/sogou-search.js';

const SOGOU_WEIXIN_DOMAIN = 'weixin.sogou.com';
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 10;

function normalizePage(page) {
  return normalizePositiveInteger(page, 'page', DEFAULT_PAGE);
}

function normalizeLimit(limit) {
  return normalizePositiveInteger(limit, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
}

export const weixinSearchCommand = cli({
  site: 'weixin',
  name: 'sougousearch',
  access: 'read',
  description: '使用搜狗微信搜索公众号文章；如需导出正文 Markdown，请使用 weixin download 处理公众号文章链接',
  domain: SOGOU_WEIXIN_DOMAIN,
  strategy: Strategy.PUBLIC,
  browser: true,
  args: [
    { name: 'query', positional: true, required: true, help: '搜索关键词；如需正文 Markdown，请使用 weixin download 处理公众号文章链接' },
    { name: 'page', type: 'int', default: 1, help: '结果页码，从 1 开始' },
    { name: 'limit', type: 'int', default: 10, help: '返回条数，最大 10' },
  ],
  columns: ['rank', 'page', 'title', 'account', 'url', 'summary', 'publish_time'],
  func: async (page, kwargs) => {
    const query = String(kwargs.query ?? '').trim();
    const pageNo = normalizePage(kwargs.page);
    const limit = normalizeLimit(kwargs.limit);
    const result = await searchSogouArticlePage(page, { query, pageNo });
    if (result.state === 'empty') {
      throw new EmptyResultError('weixin sougousearch', 'Try a different keyword or a different page number.');
    }
    return result.rows.slice(0, limit).map((row, index) => ({
      rank: (pageNo - 1) * 10 + index + 1,
      page: pageNo,
      title: row.title,
      account: row.account,
      url: row.url,
      summary: row.summary,
      publish_time: row.publishTime,
    }));
  },
});

export const __test__ = {
  MAX_LIMIT,
  normalizePage,
  normalizeLimit,
};
