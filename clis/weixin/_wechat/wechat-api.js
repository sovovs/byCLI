import { AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { buildSecretSet, redactText } from './redact.js';

const DOMAIN = 'mp.weixin.qq.com';
const ENDPOINT = `https://${DOMAIN}/cgi-bin/appmsgpublish`;

function normalizedMessage(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function commandError(message) {
  return new CommandExecutionError(redactText(message, []));
}

function parseNestedJson(value, label) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw commandError(`WeChat ${label} is malformed: ${detail}`);
  }
}

/** @param {unknown} data */
export function parsePublishData(data) {
  if (!data || typeof data !== 'object') {
    throw new CommandExecutionError('WeChat article history returned an unreadable response');
  }
  const response = /** @type {Record<string, any>} */ (data);
  const ret = response.base_resp?.ret;
  const message = response.base_resp?.err_msg ?? response.base_resp?.err_msg_en ?? '';
  if (ret === 200013 && normalizedMessage(message) === 'invalid credential') {
    throw new AuthRequiredError(DOMAIN, 'WeChat article-history credentials have expired');
  }
  if (ret !== undefined && ret !== 0) {
    throw new CommandExecutionError(`WeChat article history failed (ret=${String(ret)})`);
  }
  if (response.publish_page === undefined || response.publish_page === null || response.publish_page === '') {
    return { total: 0, publishItemCount: 0, articles: [] };
  }
  const page = parseNestedJson(response.publish_page, 'publish_page');
  if (!page || typeof page !== 'object' || !Array.isArray(page.publish_list)) {
    throw new CommandExecutionError('WeChat article history returned an invalid publish page');
  }
  const total = page.total_count === undefined ? 0 : page.total_count;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new CommandExecutionError('WeChat article history returned invalid total metadata');
  }
  const articles = [];
  for (const item of page.publish_list) {
    const info = parseNestedJson(item?.publish_info ?? {}, 'publish_info');
    if (!info || typeof info !== 'object' || !Array.isArray(info.appmsg_info)) {
      throw new CommandExecutionError('WeChat article history returned invalid publish information');
    }
    const timestamp = info.sent_info?.time ?? info.publish_info?.create_time ?? 0;
    let publishedAt = null;
    if (timestamp !== 0) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
        throw new CommandExecutionError('WeChat article history returned an invalid publish timestamp');
      }
      const date = new Date(timestamp * 1000);
      if (!Number.isFinite(date.getTime())) {
        throw new CommandExecutionError('WeChat article history returned an invalid publish timestamp');
      }
      publishedAt = date.toISOString();
    }
    for (const messageItem of info.appmsg_info) {
      const article = messageItem && typeof messageItem === 'object' ? messageItem : {};
      articles.push({
        title: typeof article.title === 'string' ? article.title : '',
        url: typeof article.content_url === 'string' ? article.content_url : '',
        isDeleted: article.is_deleted === true,
        timestamp,
        publishedAt,
        digest: typeof article.digest === 'string' ? article.digest : '',
        author: typeof article.author === 'string' ? article.author : '',
      });
    }
  }
  return {
    total,
    publishItemCount: page.publish_list.length,
    articles,
  };
}

export function requestHeaders(cookie, token) {
  return {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    Cookie: cookie,
    Origin: `https://${DOMAIN}`,
    Referer: `https://${DOMAIN}/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=10&token=${encodeURIComponent(token)}&lang=zh_CN`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest',
  };
}

/**
 * @param {{token:string,cookie:string,timeoutMs?:number,fetchImpl?:typeof fetch}} options
 */
export function createWechatApi({ token, cookie, timeoutMs = 30_000, fetchImpl = fetch }) {
  const headers = requestHeaders(cookie, token);
  const secrets = buildSecretSet({ token, cookie });

  return {
    async fetchPage({ fakeid, begin = 0, count = 10 }) {
      const query = new URLSearchParams({
        sub: 'list', begin: String(begin), count: String(count), fakeid, token,
        lang: 'zh_CN', f: 'json', ajax: '1',
      });
      try {
        const response = await fetchImpl(`${ENDPOINT}?${query}`, {
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          throw new CommandExecutionError(`WeChat article history request failed: HTTP ${response.status} ${response.statusText ?? ''}`.trim());
        }
        return parsePublishData(await response.json());
      } catch (error) {
        if (error instanceof AuthRequiredError && error.domain === DOMAIN) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const hint = error && typeof error === 'object' && 'hint' in error && typeof error.hint === 'string'
          ? error.hint : undefined;
        throw new CommandExecutionError(
          `WeChat article history request failed: ${redactText(message, secrets)}`,
          hint ? redactText(hint, secrets) : undefined,
        );
      }
    },
  };
}
