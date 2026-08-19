import { CommandExecutionError } from '@sovovs/bycli/errors';

/**
 * Reading and interaction counters shown on the article analysis detail page.
 *
 * @typedef {{
 *   readUsers: number | null,
 *   avgReadSeconds: number | null,
 *   avgReadMinutes: number | null,
 *   finishedReadRatio: number | null,
 *   newFollowers: number | null,
 *   listenUsers: number | null,
 *   listenPlays: number | null,
 *   shares: number | null,
 *   zaikan: number | null,
 *   likes: number | null,
 *   rewardYuan: number | null,
 *   comments: number | null,
 *   collections: number | null,
 * }} ArticleMetrics
 */

/**
 * Reads `window.wx.cgiData.articleData.article_data_new`, which serves these
 * counters as raw integers, and falls back to the rendered panels when the
 * bootstrap payload is missing. Kept as a string so it can run through
 * `page.evaluate` unchanged.
 *
 * The DOM fallback is deliberately positional: the interaction panel labels
 * 在看 and 点赞 with bare SVG icons, so only their row order identifies them.
 */
export const ARTICLE_METRICS_SCRIPT = `(() => {
  const digits = value => {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(/[\\s,%]/g, '');
    return /^-?\\d+(?:\\.\\d+)?$/.test(text) ? Number(text) : null;
  };
  const panelRows = () => {
    const heading = Array.from(document.querySelectorAll('.data_list.top_data_list'))
      .find(node => String(node.textContent || '').indexOf('互动') !== -1);
    const panel = heading ? heading.parentElement : null;
    if (!panel) return [];
    return Array.from(panel.querySelectorAll('.data_list'))
      .filter(row => !row.classList.contains('top_data_list'))
      .map(row => {
        const label = row.querySelector('.list_left');
        const value = row.querySelector('.data_num');
        return {
          label: label ? String(label.textContent || '').replace(/\\s+/g, ' ').trim() : '',
          value: digits(value ? value.textContent : null),
        };
      });
  };
  const readingTile = keyword => {
    const tile = Array.from(document.querySelectorAll('.bottom_data_tips')).find(node => {
      const name = node.querySelector('.tips_name');
      return name ? String(name.textContent || '').indexOf(keyword) !== -1 : false;
    });
    if (!tile) return null;
    return digits(tile.querySelector('.tips_val_num') ? tile.querySelector('.tips_val_num').textContent : null);
  };

  const rows = panelRows();
  const labelled = keyword => {
    const row = rows.find(item => item.label.indexOf(keyword) !== -1);
    return row ? row.value : null;
  };
  // 在看 and 点赞 render as icon-only rows between 分享 and 赞赏.
  const iconRows = rows.filter(row => row.label === '');

  const cgiData = (window.wx && window.wx.cgiData) || {};
  const articleData = cgiData.articleData || {};
  const metrics = articleData.article_data_new || {};
  const readSeconds = digits(metrics.avg_article_read_time);
  const domReadMinutes = readingTile('平均阅读时长');
  const domFinishedPercent = readingTile('完读率');
  const rewardFen = digits(metrics.praise_money);

  return {
    readUsers: digits(metrics.read_uv) ?? readingTile('阅读'),
    avgReadSeconds: readSeconds ?? (domReadMinutes === null ? null : domReadMinutes * 60),
    finishedReadRatio: digits(metrics.finished_read_pv_ratio)
      ?? (domFinishedPercent === null ? null : domFinishedPercent / 100),
    newFollowers: digits(metrics.follow_after_read_uv) ?? readingTile('新增关注'),
    listenUsers: digits(metrics.listen_uv) ?? readingTile('听全文'),
    listenPlays: digits(metrics.listen_pv),
    shares: digits(metrics.share_uv) ?? labelled('分享'),
    zaikan: digits(metrics.zaikan_cnt) ?? (iconRows[0] ? iconRows[0].value : null),
    likes: digits(metrics.like_cnt) ?? (iconRows[1] ? iconRows[1].value : null),
    rewardFen,
    rewardYuanFallback: labelled('赞赏'),
    comments: digits(metrics.comment_cnt) ?? labelled('留言'),
    collections: digits(metrics.collection_uv) ?? labelled('收藏'),
  };
})()`;

function finiteNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function roundTo(value, digits) {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * @param {unknown} payload
 * @returns {ArticleMetrics}
 */
export function normalizeArticleMetrics(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new CommandExecutionError(
      'WeChat article metrics returned an unreadable payload',
      'Reload the article analysis page and run the command again.',
    );
  }
  const raw = /** @type {Record<string, unknown>} */ (payload);
  const number = key => finiteNumber(raw[key]);

  const avgReadSeconds = number('avgReadSeconds');
  // `praise_money` arrives in fen; the page divides it by 100 before display.
  const rewardFen = number('rewardFen');
  const rewardYuan = rewardFen === null ? number('rewardYuanFallback') : rewardFen / 100;

  const metrics = {
    readUsers: number('readUsers'),
    avgReadSeconds,
    avgReadMinutes: roundTo(avgReadSeconds === null ? null : avgReadSeconds / 60, 2),
    finishedReadRatio: roundTo(number('finishedReadRatio'), 6),
    newFollowers: number('newFollowers'),
    listenUsers: number('listenUsers'),
    listenPlays: number('listenPlays'),
    shares: number('shares'),
    zaikan: number('zaikan'),
    likes: number('likes'),
    rewardYuan: roundTo(rewardYuan, 2),
    comments: number('comments'),
    collections: number('collections'),
  };

  if (Object.values(metrics).every(value => value === null)) {
    throw new CommandExecutionError(
      'WeChat article metrics exposed no counters',
      'The analysis layout may have changed; check that the article detail page renders its data panels.',
    );
  }
  return metrics;
}

/** @param {ArticleMetrics} metrics */
export function articleMetricsSections(metrics) {
  const percent = metrics.finishedReadRatio === null
    ? null
    : `${roundTo(metrics.finishedReadRatio * 100, 2)}%`;
  return {
    阅读: {
      阅读人数: metrics.readUsers,
      平均阅读时长分钟: metrics.avgReadMinutes,
      完读率: percent,
      新增关注: metrics.newFollowers,
      听全文人数: metrics.listenUsers,
    },
    互动: {
      分享人数: metrics.shares,
      在看人数: metrics.zaikan,
      点赞人数: metrics.likes,
      赞赏金额元: metrics.rewardYuan,
      留言条数: metrics.comments,
      收藏人数: metrics.collections,
    },
  };
}

/**
 * @param {any} page
 * @returns {Promise<ArticleMetrics|null>}
 */
export async function collectArticleMetrics(page) {
  if (typeof page?.evaluate !== 'function') return null;
  try {
    return normalizeArticleMetrics(await page.evaluate(ARTICLE_METRICS_SCRIPT));
  } catch {
    // The counters enrich the report; a layout change must not fail the download.
    return null;
  }
}
