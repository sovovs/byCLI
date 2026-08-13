import { EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { resolveBrowserCredentials } from './_wechat/auth-session.js';
import { collectPublishedRecords, positiveSafeInteger } from './_wechat/publish-records.js';

const COLUMNS = [
  'title',
  'published_at',
  'url',
  'notified',
  'failed',
  'reads',
  'likes',
  'shares',
  'recommends',
  'comments',
  'underlines',
  'reprints',
];

export const publishedCommand = cli({
  site: 'weixin',
  name: 'published',
  access: 'read',
  domain: 'mp.weixin.qq.com',
  description: 'List Weixin published records and engagement metrics',
  strategy: Strategy.INTERCEPT,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'query', positional: true, required: false, help: 'Optional article title or URL filter' },
    { name: 'limit', type: 'int', default: 10, help: 'Maximum articles to return' },
    { name: 'max-pages', type: 'int', default: 5, help: 'Maximum published-record pages to scan' },
    { name: 'timeout', type: 'int', default: 30, help: 'Maximum seconds for request capture' },
  ],
  columns: COLUMNS,
  func: async (page, args) => {
    const limit = positiveSafeInteger(args.limit, 'limit', 10);
    const { token } = await resolveBrowserCredentials(page);
    const query = String(args.query ?? '').trim();
    const maxPages = args['max-pages'] ?? 5;
    const rows = await collectPublishedRecords(page, {
      token,
      limit: query ? maxPages * 10 : limit,
      maxPages,
      timeout: args.timeout,
    });
    const matched = rows.filter(row => (
      !query || row.title.includes(query) || row.url.includes(query)
    ));
    if (matched.length === 0) {
      throw new EmptyResultError(
        'weixin published',
        `No published record matched "${query}".`,
      );
    }
    return matched.slice(0, limit).map(row => ({
      title: row.title,
      published_at: row.publishedAt,
      url: row.url,
      notified: row.notified,
      failed: row.failed,
      reads: row.reads,
      likes: row.likes,
      shares: row.shares,
      recommends: row.recommends,
      comments: row.comments,
      underlines: row.underlines,
      reprints: row.reprints,
    }));
  },
});
