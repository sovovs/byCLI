import { CommandExecutionError } from '@sovovs/bycli/errors';

const DOMAIN = 'mp.weixin.qq.com';

/**
 * @typedef {{
 *   originalCount: number | null,
 *   totalUsers: number | null,
 *   yesterdayReads: number | null,
 *   yesterdayReadsChangePct: number | null,
 *   yesterdayShares: number | null,
 *   yesterdayNewFollowers: number | null,
 *   statRange: string | null,
 * }} HomeOverview
 */

/** @param {string} token */
export function buildHomeUrl(token) {
  const parameters = new URLSearchParams({
    t: 'home/index',
    lang: 'zh_CN',
    token: String(token),
  });
  return `https://${DOMAIN}/cgi-bin/home?${parameters.toString()}`;
}

/**
 * Reads the home dashboard counters from `window.wx.cgiData` with a DOM fallback.
 * Kept as a string so it can run through `page.evaluate` unchanged.
 */
export const HOME_OVERVIEW_SCRIPT = `(() => {
  const digits = value => {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(/[\\s,]/g, '');
    const match = /^-?\\d+(?:\\.\\d+)?$/.exec(text);
    return match ? Number(text) : null;
  };
  const textOf = selector => {
    const node = document.querySelector(selector);
    return node ? node.textContent : null;
  };
  const overviewByTitle = keyword => {
    const items = Array.from(document.querySelectorAll('.weui-desktop-data-overview'));
    const matched = items.find(item => {
      const title = item.querySelector('.weui-desktop-data-overview__title');
      return title ? title.textContent.indexOf(keyword) !== -1 : false;
    });
    if (!matched) return { value: null, changePct: null };
    const desc = matched.querySelector('.weui-desktop-data-overview__desc');
    const tips = matched.querySelector('.tips_num');
    return {
      value: digits(desc ? desc.textContent : null),
      changePct: digits(tips ? tips.textContent.replace('%', '') : null),
    };
  };

  const cgiData = (window.wx && window.wx.cgiData) || {};
  const summary = cgiData.yesterdaySummary || {};
  const reads = overviewByTitle('昨日阅读');
  const shares = overviewByTitle('昨日分享');
  const followers = overviewByTitle('昨日新增关注');
  const statRange = textOf('.weui-desktop-data_description');

  return {
    originalCount: digits(textOf('.weui-desktop-user_sum.original_cnt')),
    totalUsers: digits(cgiData.total_friend_cnt) ?? digits(textOf('.weui-desktop-user_num .weui-desktop-user_sum')),
    yesterdayReads: digits(summary.pv) ?? reads.value,
    yesterdayReadsChangePct: digits(summary.pvAnalysis && summary.pvAnalysis.changeRate) ?? reads.changePct,
    yesterdayShares: digits(summary.share) ?? shares.value,
    yesterdayNewFollowers: digits(summary.subscribe) ?? followers.value,
    statRange: statRange ? statRange.trim().replace(/\\s+/g, ' ') : null,
  };
})()`;

/**
 * @param {unknown} payload
 * @returns {HomeOverview}
 */
export function normalizeHomeOverview(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new CommandExecutionError(
      'WeChat home overview returned an unreadable payload',
      'Reload the Official Account home page and run the command again.',
    );
  }
  const raw = /** @type {Record<string, unknown>} */ (payload);
  const number = key => (Number.isFinite(raw[key]) ? Number(raw[key]) : null);
  const overview = {
    originalCount: number('originalCount'),
    totalUsers: number('totalUsers'),
    yesterdayReads: number('yesterdayReads'),
    yesterdayReadsChangePct: number('yesterdayReadsChangePct'),
    yesterdayShares: number('yesterdayShares'),
    yesterdayNewFollowers: number('yesterdayNewFollowers'),
    statRange: typeof raw.statRange === 'string' && raw.statRange.trim()
      ? raw.statRange.trim().replace(/\s+/g, ' ')
      : null,
  };

  const metrics = [
    overview.originalCount,
    overview.totalUsers,
    overview.yesterdayReads,
    overview.yesterdayShares,
    overview.yesterdayNewFollowers,
  ];
  if (metrics.every(value => value === null)) {
    throw new CommandExecutionError(
      'WeChat home overview exposed no counters',
      'The home dashboard layout may have changed; check that the Official Account home page renders its data panel.',
    );
  }
  return overview;
}
