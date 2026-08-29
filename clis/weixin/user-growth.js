import { EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { resolveBrowserCredentials } from './_wechat/auth-session.js';
import {
  collectGrowth,
  parseGrowthSources,
  resolveGrowthRange,
} from './_wechat/user-analysis.js';

const COLUMNS = [
  'date',
  'source',
  'source_code',
  'new_followers',
  'unfollows',
  'net_new_followers',
  'cumulative_followers',
];

export const userGrowthCommand = cli({
  site: 'weixin',
  name: 'user-growth',
  access: 'read',
  domain: 'mp.weixin.qq.com',
  description: '读取公众号用户增长趋势，包括新增、取消、净增和累计关注人数',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'begin', help: '开始日期（YYYY-MM-DD）；默认 30 天窗口的第一天' },
    { name: 'end', help: '结束日期（YYYY-MM-DD）；默认昨天' },
    { name: 'source', default: 'all', help: '传播渠道名称或代码；多个值用逗号分隔' },
  ],
  columns: COLUMNS,
  func: async (page, args) => {
    const { token } = await resolveBrowserCredentials(page);
    const { begin, end } = resolveGrowthRange(args);
    const sources = parseGrowthSources(args.source);
    const rows = await collectGrowth({ page, token, begin, end, sources });
    if (rows.length === 0) {
      throw new EmptyResultError('weixin user-growth', `No user growth rows are available from ${begin} through ${end}.`);
    }
    return rows.map(row => ({
      date: row.date,
      source: row.source,
      source_code: row.sourceCode,
      new_followers: row.newFollowers,
      unfollows: row.unfollows,
      net_new_followers: row.netNewFollowers,
      cumulative_followers: row.cumulativeFollowers,
    }));
  },
});
