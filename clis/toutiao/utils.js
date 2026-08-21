/**
 * Shared helpers for the toutiao adapter.
 */
import { ArgumentError } from '@sovovs/bycli/errors';

const ARTICLES_MIN_PAGE = 1;
const ARTICLES_MAX_PAGE = 4;
const HOT_MIN_LIMIT = 1;
const HOT_MAX_LIMIT = 50;
const SEARCH_MIN_LIMIT = 1;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_TYPES = ['synthesis', 'information', 'video', 'atlas', 'user', 'xiaoshipin', 'weitoutiao', 'music'];

export function parseArticlesPage(raw, fallback = 1) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new ArgumentError(`--page must be an integer between ${ARTICLES_MIN_PAGE} and ${ARTICLES_MAX_PAGE}, got ${JSON.stringify(raw)}`);
    }
    if (parsed < ARTICLES_MIN_PAGE || parsed > ARTICLES_MAX_PAGE) {
        throw new ArgumentError(`--page must be between ${ARTICLES_MIN_PAGE} and ${ARTICLES_MAX_PAGE}, got ${parsed}`);
    }
    return parsed;
}

export function parseHotLimit(raw, fallback = 30) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new ArgumentError(`--limit must be an integer between ${HOT_MIN_LIMIT} and ${HOT_MAX_LIMIT}, got ${JSON.stringify(raw)}`);
    }
    if (parsed < HOT_MIN_LIMIT || parsed > HOT_MAX_LIMIT) {
        throw new ArgumentError(`--limit must be between ${HOT_MIN_LIMIT} and ${HOT_MAX_LIMIT}, got ${parsed}`);
    }
    return parsed;
}

export function parseSearchLimit(raw, fallback = 20) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new ArgumentError(`--limit must be an integer between ${SEARCH_MIN_LIMIT} and ${SEARCH_MAX_LIMIT}, got ${JSON.stringify(raw)}`);
    }
    if (parsed < SEARCH_MIN_LIMIT || parsed > SEARCH_MAX_LIMIT) {
        throw new ArgumentError(`--limit must be between ${SEARCH_MIN_LIMIT} and ${SEARCH_MAX_LIMIT}, got ${parsed}`);
    }
    return parsed;
}

export function parseSearchType(raw, fallback = 'synthesis') {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = String(raw).trim();
    if (!SEARCH_TYPES.includes(value)) {
        throw new ArgumentError(`--type must be one of ${SEARCH_TYPES.join(', ')}, got ${JSON.stringify(raw)}`);
    }
    return value;
}

const NON_TITLE_LINES = new Set([
    '展现', '阅读', '点赞', '评论',
    '查看数据', '查看评论', '修改', '更多', '首发',
    '已发布', '定时发布', '定时发布中', '由文章生成', '审核中',
]);

const STATS_RE = /展现\s*([\d,]+)\s*阅读\s*([\d,]+)\s*点赞\s*([\d,]+)\s*评论\s*([\d,]*)/;

/**
 * Extract creator-backend article rows from the rendered text dump.
 *
 * Surfaces every row anchored on a `MM-DD HH:MM` line; if the matching stats
 * line never came through (slow render / missing element), the row is still
 * emitted with `null` for stat columns rather than silently dropped.
 */
export function parseToutiaoArticlesText(text) {
    const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const results = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/^\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(line)) continue;

        const date = line;
        let title = null;
        let status = null;
        let stats = null;

        for (let back = 3; back >= 1; back--) {
            const prev = lines[i - back] || '';
            if (!prev || prev.length >= 100 || /^\d+$/.test(prev) || NON_TITLE_LINES.has(prev)) continue;
            title = prev;
            break;
        }

        for (let fwd = 1; fwd < 8; fwd++) {
            const fwdLine = lines[i + fwd] || '';
            if (fwdLine === '已发布' || fwdLine === '定时发布中' || fwdLine === '审核中' || fwdLine === '由文章生成') {
                status = fwdLine;
            }
            if (fwdLine.includes('展现') && fwdLine.includes('阅读')) {
                const match = fwdLine.match(STATS_RE);
                if (match) {
                    stats = {
                        '展现': match[1],
                        '阅读': match[2],
                        '点赞': match[3],
                        '评论': match[4] || '0',
                    };
                }
            }
        }

        if (!title) continue;

        if (stats) {
            results.push({ title, date, status, ...stats });
        } else {
            // Surface partial rows so callers can see they exist (was previously
            // silently dropped — masking creator-backend slow-render bugs).
            results.push({
                title,
                date,
                status,
                '展现': null,
                '阅读': null,
                '点赞': null,
                '评论': null,
            });
        }
    }

    return results;
}

function trimOrNull(v) {
    const s = String(v ?? '').trim();
    return s ? s : null;
}

function pickImage(item) {
    const url = item?.Image?.url;
    if (typeof url === 'string' && url) return url;
    const firstFromList = Array.isArray(item?.Image?.url_list)
        ? item.Image.url_list
            .map((entry) => typeof entry === 'string' ? entry : entry?.url)
            .find((u) => typeof u === 'string' && u)
        : null;
    return firstFromList || null;
}

function parseHot(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Project a row from the public toutiao hot-board API into stable shape.
 */
export function mapHotRow(item, index) {
    if (!item || typeof item !== 'object') return null;
    const groupId = trimOrNull(item.ClusterIdStr || (item.ClusterId != null ? String(item.ClusterId) : null));
    const title = trimOrNull(item.Title);
    if (!title) return null;
    return {
        rank: index + 1,
        group_id: groupId,
        title,
        query: trimOrNull(item.QueryWord) || title,
        hot_value: parseHot(item.HotValue),
        label: trimOrNull(item.Label),
        url: trimOrNull(item.Url),
        image_url: pickImage(item),
    };
}

export const HOT_BOARD_URL = 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc';
export const TOUTIAO_SEARCH_URL = 'https://www.toutiao.com/search/';

function parseSearchNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function absoluteSearchUrl(value) {
    const url = trimOrNull(value);
    if (!url) return null;
    try {
        return new URL(url, 'https://www.toutiao.com/').toString();
    } catch {
        return null;
    }
}

function searchImage(item) {
    const candidates = [
        item?.image_url,
        item?.large_image_url,
        item?.other_image_url,
        ...(Array.isArray(item?.image_list) ? item.image_list.map((image) => image?.url || image) : []),
        ...(Array.isArray(item?.detail_image_list) ? item.detail_image_list.map((image) => image?.url || image) : []),
    ];
    return candidates.map(trimOrNull).find(Boolean) || null;
}

function searchRowFromCard(item, index) {
    if (!item || typeof item !== 'object') return null;
    const title = trimOrNull(item.title);
    const url = absoluteSearchUrl(
        item.article_url || item.open_url || item.source_url || item.item_source_url || item?.display?.info?.url,
    );
    if (!title || !url) return null;
    return {
        rank: index + 1,
        title,
        url,
        source: trimOrNull(item.source || item.media_name),
        publish_time: trimOrNull(item.datetime || item.publish_time || item.display_time),
        summary: trimOrNull(item.abstract || item.summary || item?.emphasized?.summary),
        image_url: searchImage(item),
        like_count: parseSearchNumber(item.like_count ?? item.digg_count),
        comment_count: parseSearchNumber(item.comment_count),
        share_count: parseSearchNumber(item.share_count ?? item.repin_count ?? item.forward_count),
        read_count: parseSearchNumber(item.read_count),
    };
}

/**
 * Extract search result cards embedded in the public Toutiao search page.
 * The page currently serializes each result as an application/json script.
 */
export function parseToutiaoSearchHtml(html, limit = 20) {
    const source = String(html || '');
    const rows = [];
    const seenUrls = new Set();
    const scriptPattern = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptPattern.exec(source))) {
        let payload;
        try {
            payload = JSON.parse(match[1]);
        } catch {
            continue;
        }
        const candidate = payload?.data;
        const row = searchRowFromCard(candidate, rows.length);
        if (!row || seenUrls.has(row.url)) continue;
        seenUrls.add(row.url);
        rows.push(row);
        if (rows.length >= limit) break;
    }
    return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

export function looksToutiaoAuthWallText(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!text) return false;
    return /登录|请登录|账号登录|扫码登录|安全验证|验证码|captcha/.test(text) ||
        /\b(login|sign in|captcha|verification required)\b/.test(text) ||
        /mp\.toutiao\.com\/profile_v4\/login/.test(text);
}

export const __test__ = {
    ARTICLES_MIN_PAGE,
    ARTICLES_MAX_PAGE,
    HOT_MIN_LIMIT,
    HOT_MAX_LIMIT,
    SEARCH_MIN_LIMIT,
    SEARCH_MAX_LIMIT,
    SEARCH_TYPES,
};
