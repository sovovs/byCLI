import {
  ArgumentError,
  AuthRequiredError,
  CliError,
  CommandExecutionError,
} from '@sovovs/bycli/errors';
import { buildSecretSet, redactText } from './redact.js';

const DOMAIN = 'mp.weixin.qq.com';
const ENDPOINT = `https://${DOMAIN}/cgi-bin/appmsgalbummgr`;
const DEFAULT_PAGE_SIZE = 20;

function argument(condition, message) {
  if (!condition) throw new ArgumentError(message);
}

function positiveInteger(value, fallback, name) {
  const raw = value === undefined ? fallback : value;
  argument(Number.isSafeInteger(raw) && raw > 0, `${name} must be a positive safe integer`);
  return raw;
}

function nonnegativeInteger(value, name) {
  argument(Number.isSafeInteger(value) && value >= 0, `${name} must be a non-negative safe integer`);
  return value;
}

function nonemptyString(value, name) {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value) : value;
  argument(typeof normalized === 'string' && normalized.trim().length > 0, `${name} is required`);
  return normalized;
}

function isWellFormedString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function requiredToken(value) {
  argument(typeof value === 'string' && value.trim().length > 0 && isWellFormedString(value), 'token must be a non-empty well-formed string');
  return value;
}

function numericType(value) {
  const normalized = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  argument(Number.isSafeInteger(normalized) && normalized >= 0, 'collectionType must be a non-negative safe integer');
  return normalized;
}

export function buildCollectionsUrl({ token, begin, count }) {
  const validToken = requiredToken(token);
  const validBegin = nonnegativeInteger(begin, 'begin');
  const validCount = positiveInteger(count, undefined, 'count');
  const params = new URLSearchParams({
    action: 'list', begin: String(validBegin), count: String(validCount), latest: '1', type: '',
    token: validToken, lang: 'zh_CN', f: 'json', ajax: '1',
  });
  return `${ENDPOINT}?${params}`;
}

export function buildCollectionDetailUrl({ token, collectionId, collectionType, begin, count }) {
  const validToken = requiredToken(token);
  const validId = nonemptyString(collectionId, 'collectionId');
  const validType = numericType(collectionType);
  const validBegin = nonnegativeInteger(begin, 'begin');
  const validCount = positiveInteger(count, undefined, 'count');
  const params = new URLSearchParams({
    action: 'edit', type: String(validType), id: validId, begin: String(validBegin), count: String(validCount),
    token: validToken, lang: 'zh_CN', f: 'json', ajax: '1',
  });
  return `${ENDPOINT}?${params}`;
}

export function collectionTypeName(value) {
  return ({ 0: 'article', 5: 'video', 7: 'audio', 8: 'image' })[value] ?? `unknown:${String(value)}`;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function execution(condition, message) {
  if (!condition) throw new CommandExecutionError(message);
}

function checkResponse(payload, label) {
  execution(object(payload), `WeChat ${label} returned an unreadable response`);
  const ret = payload.base_resp?.ret;
  if (ret === 200040 || ret === 200003) {
    throw new AuthRequiredError(DOMAIN, 'WeChat collection credentials have expired');
  }
  execution(ret === 0, `WeChat ${label} failed (ret=${String(ret ?? 'unknown')})`);
  return payload;
}

function requiredString(value, message, { allowEmpty = false } = {}) {
  execution(typeof value === 'string' && (allowEmpty || value.trim().length > 0), message);
  return value;
}

function requiredId(value, message) {
  execution((typeof value === 'string' && value.trim().length > 0)
    || (typeof value === 'number' && Number.isSafeInteger(value)), message);
  return String(value);
}

function requiredNumber(value, message, { integer = false, nonnegative = false } = {}) {
  execution(typeof value === 'number' && Number.isFinite(value), message);
  if (integer) execution(Number.isSafeInteger(value), message);
  if (nonnegative) execution(value >= 0, message);
  return value;
}

function optionalNumber(value, message, options) {
  if (value === undefined || value === null) return null;
  return requiredNumber(value, message, options);
}

function isoFromUnix(value, message, optional = false) {
  if (optional && (value === undefined || value === null)) return null;
  const seconds = requiredNumber(value, message, { integer: true, nonnegative: true });
  const milliseconds = seconds * 1000;
  execution(Number.isSafeInteger(milliseconds), message);
  const date = new Date(milliseconds);
  execution(Number.isFinite(date.getTime()), message);
  return date.toISOString();
}

function updateFrequency(value, message) {
  if (value === undefined || value === null) return null;
  execution(object(value), message);
  return {
    month: requiredNumber(value.month, message, { integer: true, nonnegative: true }),
  };
}

function flag(value, message, optional = false) {
  if (optional && (value === undefined || value === null)) return null;
  execution(value === 0 || value === 1 || typeof value === 'boolean', message);
  return value === true || value === 1;
}

function optionalString(value, message) {
  if (value === undefined || value === null) return null;
  return requiredString(value, message, { allowEmpty: true });
}

function mapListItem(item, index) {
  execution(object(item), `WeChat collections returned an invalid item at index ${index}`);
  const prefix = `WeChat collections returned an invalid item at index ${index}`;
  const collectionTypeRaw = requiredNumber(item.type, prefix, { integer: true, nonnegative: true });
  return {
    row: {
      collectionId: requiredId(item.id, prefix),
      title: requiredString(item.title, prefix),
      collectionType: collectionTypeName(collectionTypeRaw),
      itemCount: requiredNumber(item.total, prefix, { integer: true, nonnegative: true }),
      views: requiredNumber(item.uv, prefix, { integer: true, nonnegative: true }),
      continuousRead: flag(item.continous_read_on, prefix),
      isUpdating: flag(item.is_updating, prefix),
      isBanned: flag(item.is_ban, prefix),
      isPaid: flag(item.need_pay, prefix),
      createdAt: isoFromUnix(item.create_time, prefix),
      updatedAt: isoFromUnix(item.update_time, prefix),
      coverUrl: optionalString(item.cover_url, prefix),
    },
    collectionTypeRaw,
  };
}

export function mapCollectionsPayload(payload) {
  const response = checkResponse(payload, 'collections');
  execution(object(response.list_resp), 'WeChat collections returned an invalid list response');
  const total = requiredNumber(response.list_resp.total, 'WeChat collections returned an invalid total', {
    integer: true, nonnegative: true,
  });
  execution(Array.isArray(response.list_resp.items), 'WeChat collections returned an invalid item list');
  return { rows: response.list_resp.items.map((item, index) => mapListItem(item, index).row), total };
}

function detailContext(context) {
  execution(object(context), 'WeChat collection detail requires request context');
  const collectionId = requiredId(context.collectionId, 'WeChat collection detail requires a collection ID');
  const collectionType = requiredNumber(context.collectionType, 'WeChat collection detail requires a numeric type', {
    integer: true, nonnegative: true,
  });
  const begin = nonnegativeInteger(context.begin === undefined ? 0 : context.begin, 'begin');
  const positionOffset = nonnegativeInteger(
    context.positionOffset === undefined ? 0 : context.positionOffset,
    'positionOffset',
  );
  return { collectionId, collectionType, begin, positionOffset };
}

function mapDetailItem(item, index, positionOffset) {
  const prefix = `WeChat collection detail returned an invalid item at index ${index}`;
  execution(object(item), prefix);
  return {
    appmsgId: requiredId(item.appmsgid, prefix),
    itemIndex: requiredNumber(item.itemidx, prefix, { integer: true, nonnegative: true }),
    position: positionOffset + index + 1,
    title: requiredString(item.title, prefix),
    link: requiredString(item.link, prefix),
    coverUrl: optionalString(item.cover, prefix),
    createdAt: isoFromUnix(item.create_time, prefix, true),
    type: optionalNumber(item.type, prefix, { integer: true, nonnegative: true }),
    status: optionalNumber(item.status, prefix, { integer: true, nonnegative: true }),
    failReason: optionalString(item.fail_reason, prefix),
    sharePageType: optionalNumber(item.share_page_type, prefix, { integer: true, nonnegative: true }),
    isPaid: flag(item.is_pay_subscribe, prefix, true),
    payAlbumId: item.pay_album_id === undefined || item.pay_album_id === null
      ? null : requiredId(item.pay_album_id, prefix),
    wecoinCount: optionalNumber(item.wecoin_count, prefix, { integer: true, nonnegative: true }),
  };
}

function parseCollectionDetailPayload(payload, context) {
  const response = checkResponse(payload, 'collection detail');
  const expected = detailContext(context);
  execution(object(response.edit_resp), 'WeChat collection detail returned an invalid edit response');
  const edit = response.edit_resp;
  const actualId = requiredId(edit.id, 'WeChat collection detail returned an invalid collection ID');
  execution(actualId === expected.collectionId, 'WeChat collection detail returned a mismatched collection ID');
  const rawType = requiredNumber(edit.type, 'WeChat collection detail returned an invalid collection type', {
    integer: true, nonnegative: true,
  });
  execution(rawType === expected.collectionType, 'WeChat collection detail returned a mismatched collection type');
  execution(Array.isArray(edit.appmsg_infos), 'WeChat collection detail returned an invalid item list');
  const continueFlag = edit.continue_flag;
  execution(Number.isSafeInteger(continueFlag), 'WeChat collection detail returned an invalid continue flag');
  const prefix = 'WeChat collection detail returned invalid metadata';
  const responseBegin = requiredNumber(edit.begin, prefix, { integer: true, nonnegative: true });
  execution(responseBegin === expected.begin, 'WeChat collection detail returned a mismatched begin offset');
  const detail = {
    collectionId: actualId,
    title: requiredString(edit.title, prefix),
    description: optionalString(edit.desc, prefix),
    collectionType: collectionTypeName(rawType),
    coverUrl: optionalString(edit.cover_url, prefix),
    itemCount: requiredNumber(edit.total, prefix, { integer: true, nonnegative: true }),
    createdAt: isoFromUnix(edit.create_time, prefix),
    updatedAt: isoFromUnix(edit.update_time, prefix),
    settings: {
      continuousRead: flag(edit.continous_read_on, prefix),
      isUpdating: flag(edit.is_updating, prefix),
      isReverse: flag(edit.is_reverse, prefix),
      isNumbered: flag(edit.is_numbered, prefix),
      isPaid: flag(edit.need_pay, prefix),
      fee: optionalNumber(edit.fee, prefix),
      isBanned: flag(edit.is_ban, prefix),
      canModifyTitle: flag(edit.can_modify_title, prefix),
      sendQuota: optionalNumber(edit.send_quota, prefix, { integer: true, nonnegative: true }),
      subtype: optionalNumber(edit.subtype, prefix, { integer: true, nonnegative: true }),
      themeColor: optionalString(edit.theme_color, prefix),
      updateFrequency: updateFrequency(edit.update_frequence, prefix),
    },
    items: edit.appmsg_infos.map((item, index) => mapDetailItem(item, index, expected.positionOffset)),
  };
  return {
    detail,
    continueFlag: continueFlag === 0 ? 0 : 1,
    rawItemCount: edit.appmsg_infos.length,
  };
}

export function mapCollectionDetailPayload(payload, context) {
  return parseCollectionDetailPayload(payload, context).detail;
}

function requestOptions(safeReferer) {
  argument(typeof safeReferer === 'string' && safeReferer.length > 0, 'safeReferer is required');
  let parsed;
  try {
    parsed = new URL(safeReferer);
  } catch {
    throw new ArgumentError('safeReferer must be a safe mp.weixin.qq.com HTTPS URL without a token');
  }
  const hasToken = [...parsed.searchParams.keys()].some(key => key.toLowerCase() === 'token');
  argument(
    parsed.origin === `https://${DOMAIN}` && parsed.username === '' && parsed.password === '' && !hasToken,
    'safeReferer must be a safe mp.weixin.qq.com HTTPS URL without a token',
  );
  return { referrer: safeReferer, headers: { 'X-Requested-With': 'XMLHttpRequest' } };
}

function transportError(error, token) {
  const redactableToken = typeof token === 'string' && isWellFormedString(token) ? token : '';
  const secrets = buildSecretSet({ token: redactableToken, cookie: '' });
  const message = error instanceof Error ? error.message : String(error);
  const hint = object(error) && typeof error.hint === 'string' ? error.hint : undefined;
  const tokenRepresentations = [];
  if (typeof token === 'string' && token.length > 0) {
    tokenRepresentations.push(token);
    try {
      tokenRepresentations.push(encodeURIComponent(token));
    } catch {
      // Invalid UTF-16 is rejected by requiredToken; redaction must not mask that error.
    }
  }
  const sanitize = value => {
    let sanitized = redactText(value, secrets);
    for (const representation of tokenRepresentations) {
      sanitized = sanitized.replaceAll(representation, '[REDACTED]');
    }
    return sanitized.replace(/https?:\/\/mp\.weixin\.qq\.com\/cgi-bin\/appmsgalbummgr\S*/giu, '[REDACTED]');
  };
  const safeMessage = sanitize(message);
  const safeHint = hint === undefined ? undefined : sanitize(hint);
  if (error instanceof CliError && safeMessage === message && safeHint === hint) return error;
  return new CommandExecutionError(`WeChat collections request failed: ${safeMessage}`, safeHint);
}

function pagination({ limit, pageSize, maxPages }) {
  return {
    limit: positiveInteger(limit, undefined, 'limit'),
    pageSize: positiveInteger(pageSize, DEFAULT_PAGE_SIZE, 'pageSize'),
    maxPages: positiveInteger(maxPages, undefined, 'maxPages'),
  };
}

export async function collectCollections({ page, token, safeReferer, limit, pageSize, maxPages }) {
  const options = pagination({ limit, pageSize, maxPages });
  const requestInit = requestOptions(safeReferer);
  const rows = [];
  const seenCollectionIds = new Set();
  let begin = 0;
  try {
    for (let pageNumber = 0; pageNumber < options.maxPages && rows.length < options.limit; pageNumber += 1) {
      const url = buildCollectionsUrl({ token, begin, count: options.pageSize });
      const payload = await page.fetchJson(url, requestInit);
      const mapped = mapCollectionsPayload(payload);
      const rawCount = payload.list_resp.items.length;
      for (const row of mapped.rows) {
        execution(!seenCollectionIds.has(row.collectionId), 'WeChat collections returned a duplicate collection ID');
        seenCollectionIds.add(row.collectionId);
      }
      rows.push(...mapped.rows.slice(0, options.limit - rows.length));
      begin += rawCount;
      if (rawCount === 0 || begin >= mapped.total) break;
    }
    return rows;
  } catch (error) {
    throw transportError(error, token);
  }
}

export async function fetchCollectionDetail({
  page, token, safeReferer, collectionId, collectionType, limit, pageSize, maxPages,
}) {
  const options = pagination({ limit, pageSize, maxPages });
  const requestInit = requestOptions(safeReferer);
  const validId = nonemptyString(collectionId, 'collectionId');
  const validType = numericType(collectionType);
  let begin = 0;
  let result = null;
  const seenItemIdentities = new Set();
  try {
    for (let pageNumber = 0; pageNumber < options.maxPages && begin < options.limit; pageNumber += 1) {
      const url = buildCollectionDetailUrl({
        token, collectionId: validId, collectionType: validType, begin, count: options.pageSize,
      });
      const payload = await page.fetchJson(url, requestInit);
      const parsed = parseCollectionDetailPayload(payload, {
        collectionId: validId, collectionType: validType, begin, positionOffset: begin,
      });
      const { detail: mapped, continueFlag, rawItemCount: rawCount } = parsed;
      if (continueFlag !== 0 && rawCount === 0) {
        throw new CommandExecutionError('WeChat collection detail returned an empty continuing page');
      }
      for (const item of mapped.items) {
        const identity = JSON.stringify([item.appmsgId, item.itemIndex]);
        execution(!seenItemIdentities.has(identity), 'WeChat collection detail returned a duplicate item identity');
        seenItemIdentities.add(identity);
      }
      if (result === null) result = { ...mapped, items: [] };
      result.items.push(...mapped.items.slice(0, options.limit - result.items.length));
      begin += rawCount;
      if (continueFlag === 0 || rawCount === 0 || result.items.length >= options.limit) break;
    }
    execution(result !== null, 'WeChat collection detail returned no pages');
    return result;
  } catch (error) {
    throw transportError(error, token);
  }
}

export async function findCollectionById({ page, token, safeReferer, collectionId, pageSize, maxPages }) {
  const validId = nonemptyString(collectionId, 'collectionId');
  const size = positiveInteger(pageSize, DEFAULT_PAGE_SIZE, 'pageSize');
  const pages = positiveInteger(maxPages, undefined, 'maxPages');
  const requestInit = requestOptions(safeReferer);
  let begin = 0;
  const seenCollectionIds = new Set();
  try {
    for (let pageNumber = 0; pageNumber < pages; pageNumber += 1) {
      const url = buildCollectionsUrl({ token, begin, count: size });
      const payload = await page.fetchJson(url, requestInit);
      const mapped = mapCollectionsPayload(payload);
      const rawItems = payload.list_resp.items;
      for (let index = 0; index < mapped.rows.length; index += 1) {
        execution(!seenCollectionIds.has(mapped.rows[index].collectionId), 'WeChat collections returned a duplicate collection ID');
        seenCollectionIds.add(mapped.rows[index].collectionId);
        if (mapped.rows[index].collectionId === validId) {
          const collectionTypeRaw = requiredNumber(
            rawItems[index].type,
            'WeChat collections returned an invalid collection type',
            { integer: true, nonnegative: true },
          );
          return { row: mapped.rows[index], collectionTypeRaw };
        }
      }
      begin += rawItems.length;
      if (rawItems.length === 0 || begin >= mapped.total) break;
    }
    return null;
  } catch (error) {
    throw transportError(error, token);
  }
}
