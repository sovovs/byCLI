import { cli, Strategy } from '@sovovs/bycli/registry';
import { resolveBrowserCredentials } from './_wechat/auth-session.js';
import {
  HOME_OVERVIEW_SCRIPT,
  buildHomeUrl,
  normalizeHomeOverview,
} from './_wechat/home-overview.js';

const DOMAIN = 'mp.weixin.qq.com';

const COLUMNS = [
  'original_count',
  'total_users',
  'yesterday_reads',
  'yesterday_reads_change_pct',
  'yesterday_shares',
  'yesterday_new_followers',
  'stat_range',
];

export const homeOverviewCommand = cli({
  site: 'weixin',
  name: 'home-overview',
  access: 'read',
  domain: DOMAIN,
  aliases: ['overview', 'dashboard', 'fans'],
  description: '读取公众号首页概览：原创内容、总用户数（粉丝数）、昨日阅读/分享/新增关注人数及阅读增长百分比；账号级昨日汇总，单篇文章数据请用 published',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'settle', type: 'int', default: 3, help: '打开首页后等待渲染的秒数' },
  ],
  columns: COLUMNS,
  func: async (page, args) => {
    const { token } = await resolveBrowserCredentials(page);
    await page.goto(buildHomeUrl(token));
    const settle = Number(args.settle ?? 3);
    await page.wait(Number.isFinite(settle) && settle > 0 ? settle : 3);
    const overview = normalizeHomeOverview(await page.evaluate(HOME_OVERVIEW_SCRIPT));
    return [{
      original_count: overview.originalCount,
      total_users: overview.totalUsers,
      yesterday_reads: overview.yesterdayReads,
      yesterday_reads_change_pct: overview.yesterdayReadsChangePct,
      yesterday_shares: overview.yesterdayShares,
      yesterday_new_followers: overview.yesterdayNewFollowers,
      stat_range: overview.statRange,
    }];
  },
});
