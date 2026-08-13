import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from '@sovovs/bycli/errors';

const DOMAIN = 'mp.weixin.qq.com';
const TIME_ZONE = 'Asia/Shanghai';
const PUBLISH_PATH = '/cgi-bin/appmsgpublish';
const TRACKING_PARAMS = [
  'scene',
  'srcid',
  'from',
  'isappinstalled',
  'sharer_shareinfo',
  'sharer_shareinfo_first',
  'exportkey',
  'pass_ticket',
  'wx_header',
];

function commandError(message) {
  return new CommandExecutionError(`WeChat publish records ${message}`);
}

function parseJson(value, label) {
  if (typeof value !== 'string') throw commandError(`returned an invalid ${label}`);
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') throw commandError(`returned an invalid ${label}`);
    return parsed;
  } catch (error) {
    if (error instanceof CommandExecutionError) throw error;
    throw commandError(`returned damaged ${label} JSON`);
  }
}

function dateInShanghai(seconds) {
  if (!Number.isFinite(seconds)) throw commandError('returned a record without a publish date');
  const date = new Date(Number(seconds) * 1000);
  if (!Number.isFinite(date.getTime())) throw commandError('returned an invalid publish date');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  if (!values.year || !values.month || !values.day) {
    throw commandError('returned an invalid publish date');
  }
  return `${values.year}-${values.month}-${values.day}`;
}

function finiteNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function isDeleted(value) {
  return value?.is_deleted === 1 || value?.is_delete === 1 || value?.deleted === true;
}

function routePart(value) {
  if (Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function decodePublishInfo(value) {
  const decoded = parseJson(value, 'publish_info');
  if (!Object.prototype.hasOwnProperty.call(decoded, 'publish_info')) return decoded;
  const nested = decoded.publish_info;
  if (typeof nested === 'string') return parseJson(nested, 'nested publish_info');
  if (nested && typeof nested === 'object') return nested;
  throw commandError('returned an invalid nested publish_info');
}

function parseEntry(info, article) {
  const title = typeof article?.title === 'string' ? article.title.trim() : '';
  const url = typeof article?.content_url === 'string' ? article.content_url.trim() : '';
  if (isDeleted(info) || isDeleted(article) || !title || !url) return null;

  const msgid = routePart(article?.appmsgid) ?? routePart(article?.msgid) ?? routePart(info?.msgid);
  const itemIdx = routePart(article?.itemidx);
  if (msgid === null || itemIdx === null) {
    throw commandError('returned an article without a detail route');
  }
  const publishedAt = dateInShanghai(info?.sent_info?.time);
  return {
    title,
    publishedAt,
    url,
    notified: finiteNumber(info?.sent_status?.succ),
    failed: finiteNumber(info?.sent_status?.fail),
    reads: finiteNumber(article?.read_num),
    likes: finiteNumber(article?.like_num),
    shares: finiteNumber(article?.share_num),
    recommends: finiteNumber(article?.moment_like_num),
    comments: finiteNumber(article?.comment_num),
    underlines: finiteNumber(article?.line_info?.line_count),
    reprints: finiteNumber(article?.reprint_num),
    msgid,
    itemIdx,
    publishDate: publishedAt,
  };
}

/** @param {unknown} payload */
export function parsePublishResponse(payload) {
  if (!payload || typeof payload !== 'object') {
    throw commandError('returned an unreadable response');
  }
  const response = /** @type {Record<string, any>} */ (payload);
  const ret = response.base_resp?.ret;
  const message = String(response.base_resp?.err_msg ?? '');
  const normalizedMessage = message.trim().toLowerCase();
  if (ret === 200013 && normalizedMessage === 'invalid credential') {
    throw new AuthRequiredError(DOMAIN, 'WeChat publish credentials have expired');
  }
  if (ret !== 0) {
    throw commandError(`request failed (ret=${String(ret ?? 'unknown')})`);
  }

  const page = parseJson(response.publish_page, 'publish_page');
  if (!Array.isArray(page.publish_list)) {
    throw commandError('returned an invalid publish list');
  }
  const entries = [];
  for (const rawRecord of page.publish_list) {
    if (!rawRecord || typeof rawRecord !== 'object' || typeof rawRecord.publish_info !== 'string') {
      throw commandError('returned an invalid publish record');
    }
    const info = decodePublishInfo(rawRecord.publish_info);
    if (!Array.isArray(info.appmsg_info)) {
      throw commandError('returned an invalid article list');
    }
    for (const article of info.appmsg_info) {
      const entry = parseEntry(info, article);
      if (entry) entries.push(entry);
    }
  }

  return {
    totalCount: Number.isSafeInteger(page.total_count) ? page.total_count : entries.length,
    entries,
  };
}

export function positiveSafeInteger(value, name, fallback) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ArgumentError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

/**
 * @param {any} page
 * @param {{token?:string,limit?:number,maxPages?:number,timeout?:number}} [options]
 */
export async function collectPublishedRecords(page, options = {}) {
  const limit = positiveSafeInteger(options.limit, 'limit', 10);
  const maxPages = positiveSafeInteger(options.maxPages, 'maxPages', 5);
  const timeout = positiveSafeInteger(options.timeout, 'timeout', 30);
  if (typeof page?.fetchJson !== 'function') {
    throw commandError('requires authenticated JSON fetch support');
  }
  const seedUrl = new URL(`https://${DOMAIN}${PUBLISH_PATH}`);
  seedUrl.searchParams.set('sub', 'list');
  seedUrl.searchParams.set('f', 'json');
  seedUrl.searchParams.set('begin', '0');
  seedUrl.searchParams.set('count', '10');
  seedUrl.searchParams.set('token', String(options.token ?? ''));
  seedUrl.searchParams.set('lang', 'zh_CN');

  const records = [];
  const seen = new Set();
  for (let pageIndex = 0; pageIndex < maxPages && records.length < limit; pageIndex += 1) {
    const requestUrl = new URL(seedUrl.href);
    requestUrl.searchParams.set('begin', String(pageIndex * 10));
    requestUrl.searchParams.set('count', '10');
    const payload = await page.fetchJson(requestUrl.href, { timeoutMs: timeout * 1000 });
    const parsed = parsePublishResponse(payload);
    for (const entry of parsed.entries) {
      const key = `${entry.msgid}:${entry.itemIdx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(entry);
      if (records.length >= limit) break;
    }
    if ((pageIndex + 1) * 10 >= parsed.totalCount) break;
  }

  if (records.length === 0) {
    throw new EmptyResultError(
      'weixin published',
      'No published records were returned by Weixin.',
    );
  }
  return records.slice(0, limit);
}

function normalizeTitle(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function isCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function validatePublishDate(value) {
  if (value === undefined) return undefined;
  const date = String(value);
  if (!isCalendarDate(date)) throw new ArgumentError('date must use YYYY-MM-DD');
  return date;
}

function parseAbsoluteUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeArticleUrl(value) {
  const url = parseAbsoluteUrl(value);
  if (!url
    || url.protocol !== 'https:'
    || url.hostname !== DOMAIN
    || url.port !== ''
    || url.username !== ''
    || url.password !== '') return null;
  url.hash = '';
  for (const parameter of TRACKING_PARAMS) url.searchParams.delete(parameter);
  url.searchParams.sort();
  return url.href;
}

function ambiguityError(matches) {
  const choices = matches.slice(0, 5)
    .map(record => `${record.publishedAt ?? record.publishDate} ${record.title} ${record.url}`)
    .join('\n');
  return new ArgumentError(
    `Multiple published records matched. Use the complete URL or --date.\n${choices}`,
  );
}

function uniqueMatch(matches) {
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw ambiguityError(matches);
  return null;
}

export function matchPublishedRecord(records, query, date) {
  const text = normalizeTitle(query);
  if (!text) throw new ArgumentError('query must not be empty');
  const validatedDate = validatePublishDate(date);
  const candidates = (Array.isArray(records) ? records : [])
    .filter(record => validatedDate === undefined || record.publishedAt === validatedDate);

  if (parseAbsoluteUrl(text)) {
    const normalizedUrl = normalizeArticleUrl(text);
    if (normalizedUrl) {
      const matched = uniqueMatch(candidates.filter(record => normalizeArticleUrl(record.url) === normalizedUrl));
      if (matched) return matched;
    }
  } else {
    const exact = uniqueMatch(candidates.filter(record => normalizeTitle(record.title) === text));
    if (exact) return exact;
    const substring = uniqueMatch(candidates.filter(record => normalizeTitle(record.title).includes(text)));
    if (substring) return substring;
  }

  throw new EmptyResultError(
    'weixin download-publish-data',
    `No published record matched "${text}".`,
  );
}

export function buildDetailUrl(record, token) {
  const parameters = new URLSearchParams({
    action: 'detailpage',
    msgid: `${record.msgid}_${record.itemIdx}`,
    publish_date: record.publishDate,
    type: 'int',
    pageVersion: '1',
    token: String(token),
    lang: 'zh_CN',
  });
  return `https://${DOMAIN}/misc/appmsganalysis?${parameters.toString()}`;
}
