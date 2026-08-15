import { AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { buildSecretSet, redactText } from './redact.js';

const DOMAIN = 'mp.weixin.qq.com';
const ENDPOINT = `https://${DOMAIN}/cgi-bin/appmsgpublish`;

function commandError(message, hint) {
  return new CommandExecutionError(`WeChat appmsgpublish ${message}`, hint);
}

function parseNestedJson(value, field) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw commandError(`returned invalid ${field} JSON`);
  }
}

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw commandError(`returned invalid ${field}`);
  }
  return value;
}

export function mapArticleIndexPayload(payload) {
  const response = requireRecord(payload, 'response');
  const baseResponse = requireRecord(response.base_resp, 'base_resp');
  const ret = baseResponse.ret;
  const normalizedMessage = typeof baseResponse.err_msg === 'string'
    ? baseResponse.err_msg.trim().toLowerCase().replace(/\s+/g, ' ') : '';
  if (ret === 200013 && normalizedMessage === 'invalid credential') {
    throw new AuthRequiredError(DOMAIN, 'WeChat article-index credentials have expired');
  }
  if (ret === 200013 && normalizedMessage === 'freq control') {
    throw commandError(
      'was rate limited (ret=200013)',
      'Wait before retrying the WeChat article-index request; repeated retries may extend frequency control.',
    );
  }
  if (!Number.isInteger(ret) || ret !== 0) {
    throw commandError(`failed (ret=${String(ret ?? 'unknown')})`);
  }
  if (response.publish_page === undefined || response.publish_page === null
    || response.publish_page === '') {
    return { total: 0, publishItemCount: 0, articles: [] };
  }

  const page = requireRecord(parseNestedJson(response.publish_page, 'publish_page'), 'publish_page');
  if (!Number.isInteger(page.total_count) || page.total_count < 0) {
    throw commandError('returned invalid total_count');
  }
  if (!Array.isArray(page.publish_list)) {
    throw commandError('returned invalid publish_list');
  }

  const articles = [];
  for (const [publishIndex, rawItem] of page.publish_list.entries()) {
    const item = requireRecord(rawItem, `publish_list[${publishIndex}]`);
    if (!Object.prototype.hasOwnProperty.call(item, 'publish_info')) {
      throw commandError(`returned missing publish_info at index ${publishIndex}`);
    }
    const info = requireRecord(
      parseNestedJson(item.publish_info, `publish_info at index ${publishIndex}`),
      `publish_info at index ${publishIndex}`,
    );
    if (!Array.isArray(info.appmsg_info)) {
      throw commandError(`returned invalid appmsg_info at index ${publishIndex}`);
    }
    if (info.sent_info !== undefined) requireRecord(info.sent_info, `sent_info at index ${publishIndex}`);
    if (info.publish_info !== undefined) requireRecord(info.publish_info, `publish metadata at index ${publishIndex}`);
    const timestamp = info.sent_info?.time ?? info.publish_info?.create_time ?? 0;
    if (!Number.isInteger(timestamp) || timestamp < 0) {
      throw commandError(`returned invalid timestamp at index ${publishIndex}`);
    }

    for (const [articleIndex, rawArticle] of info.appmsg_info.entries()) {
      const article = requireRecord(rawArticle, `appmsg_info[${articleIndex}]`);
      for (const field of ['title', 'content_url', 'digest', 'author']) {
        if (article[field] !== undefined && typeof article[field] !== 'string') {
          throw commandError(`returned invalid ${field} at article index ${articleIndex}`);
        }
      }
      articles.push({
        title: article.title || '',
        url: article.content_url || '',
        isDeleted: article.is_deleted === true,
        timestamp,
        publishedAt: timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null,
        digest: article.digest || '',
        author: article.author || '',
      });
    }
  }

  return { total: page.total_count, publishItemCount: page.publish_list.length, articles };
}

function buildReferer(token) {
  const params = new URLSearchParams({
    t: 'media/appmsg_edit_v2', action: 'edit', isNew: '1', type: '10',
    token, lang: 'zh_CN',
  });
  return `https://${DOMAIN}/cgi-bin/appmsg?${params}`;
}

function transportError(error, credentials) {
  const secrets = buildSecretSet(credentials);
  const message = error instanceof Error ? error.message : String(error);
  const hint = error && typeof error === 'object' && 'hint' in error
    && typeof error.hint === 'string' ? error.hint : undefined;
  const redactedMessage = redactText(message, secrets);
  const redactedHint = hint ? redactText(hint, secrets) : undefined;
  if (error instanceof AuthRequiredError && error.domain === DOMAIN
    && redactedMessage === message && redactedHint === hint) return error;
  return new CommandExecutionError(
    `WeChat appmsgpublish request failed: ${redactedMessage}`,
    redactedHint,
  );
}

export function createArticleIndexFetcher({
  page,
  source,
  credentials,
  fetchImpl = fetch,
  timeoutMs = 30_000,
}) {
  return async function fetchPage({ fakeid, begin = 0, count = 10 }) {
    const params = new URLSearchParams({
      sub: 'list', begin: String(begin), count: String(count), fakeid,
      token: credentials.token, lang: 'zh_CN', f: 'json', ajax: '1',
    });
    const url = `${ENDPOINT}?${params}`;
    const headers = {
      Referer: buildReferer(credentials.token),
      'X-Requested-With': 'XMLHttpRequest',
    };

    try {
      let payload;
      if (source === 'browser') {
        if (!page || typeof page.fetchJson !== 'function') {
          throw new CommandExecutionError('Browser page.fetchJson is unavailable');
        }
        payload = await page.fetchJson(url, { headers });
      } else {
        const response = await fetchImpl(url, {
          headers: { ...headers, Cookie: credentials.cookie },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          throw new CommandExecutionError(`HTTP ${String(response.status ?? 'unknown')}`);
        }
        payload = await response.json();
      }
      return mapArticleIndexPayload(payload);
    } catch (error) {
      throw transportError(error, credentials);
    }
  };
}
