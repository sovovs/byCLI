import { ArgumentError, EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { resolveBrowserCredentials } from './_wechat/auth-session.js';
import {
  collectGrowth,
  parseGrowthSources,
  resolveGrowthRange,
} from './_wechat/user-analysis.js';
import { downloadUserGrowthXls } from './_wechat/user-growth-download.js';

const COLUMNS = [
  'date',
  'source',
  'source_code',
  'new_followers',
  'unfollows',
  'net_new_followers',
  'cumulative_followers',
  'official_xls_path',
  'official_xls_size',
];

export const userGrowthCommand = cli({
  site: 'weixin',
  name: 'user-growth',
  access: 'write',
  domain: 'mp.weixin.qq.com',
  description: '读取公众号用户增长趋势，可选返回全部渠道并下载官方“全部来源”XLS',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'begin', help: '开始日期（YYYY-MM-DD）；默认 30 天窗口的第一天' },
    { name: 'end', help: '结束日期（YYYY-MM-DD）；默认昨天' },
    { name: 'source', default: 'all', help: '传播渠道名称或代码；多个值用逗号分隔' },
    { name: 'output', help: '可选的官方“全部来源”XLS 保存目录；不传则不下载' },
  ],
  columns: COLUMNS,
  func: async (page, args) => {
    const outputDir = typeof args.output === 'string' ? args.output.trim() : null;
    if (args.output !== undefined && (!outputDir || typeof args.output !== 'string')) {
      throw new ArgumentError('output must be a non-empty directory');
    }
    const { token } = await resolveBrowserCredentials(page);
    const { begin, end } = resolveGrowthRange(args);
    const sources = parseGrowthSources(args.source);
    const rows = await collectGrowth({ page, token, begin, end, sources });
    if (rows.length === 0) {
      throw new EmptyResultError('weixin user-growth', `No user growth rows are available from ${begin} through ${end}.`);
    }
    const artifact = outputDir
      ? await downloadUserGrowthXls(page, { token, begin, end, outputDir })
      : null;
    return rows.map(row => ({
      date: row.date,
      source: row.source,
      source_code: row.sourceCode,
      new_followers: row.newFollowers,
      unfollows: row.unfollows,
      net_new_followers: row.netNewFollowers,
      cumulative_followers: row.cumulativeFollowers,
      official_xls_path: artifact?.path ?? null,
      official_xls_size: artifact?.size ?? null,
    }));
  },
});
