import {
  AuthRequiredError,
  CommandExecutionError,
} from '@sovovs/bycli/errors';
import { buildSecretSet, redactText } from './redact.js';

const DOMAIN = 'mp.weixin.qq.com';
const ENDPOINT = `https://${DOMAIN}/cgi-bin/searchbiz`;
const REFERER = `https://${DOMAIN}/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=10`;

/** @param {unknown} payload */
export function mapSearchBizPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new CommandExecutionError('WeChat search_biz returned an unreadable response');
  }
  const response = /** @type {Record<string, any>} */ (payload);
  const ret = response.base_resp?.ret;
  const message = String(response.base_resp?.err_msg ?? response.base_resp?.err_msg_en ?? '');
  const normalizedMessage = message.trim().toLowerCase().replace(/\s+/g, ' ');
  if (ret === 200013 && normalizedMessage === 'invalid credential') {
    throw new AuthRequiredError(DOMAIN, 'WeChat search credentials have expired');
  }
  if (ret !== 0) {
    throw new CommandExecutionError(`WeChat search_biz failed (ret=${String(ret ?? 'unknown')})`);
  }
  if (!Array.isArray(response.list)) {
    throw new CommandExecutionError('WeChat search_biz returned an invalid account list');
  }
  return response.list.map((item, index) => {
    if (!item || typeof item !== 'object'
      || typeof item.nickname !== 'string' || !item.nickname.trim()
      || typeof item.fakeid !== 'string' || !item.fakeid.trim()) {
      throw new CommandExecutionError(`WeChat search_biz returned an invalid account at index ${index}`);
    }
    return {
      nickname: item.nickname,
      fakeid: item.fakeid,
      alias: typeof item.alias === 'string' && item.alias.length > 0 ? item.alias : null,
    };
  });
}

/** @param {unknown} error @param {{token:string,cookie:string,fingerprint?:string}} credentials */
function transportError(error, credentials) {
  const secrets = buildSecretSet(credentials);
  const message = error instanceof Error ? error.message : String(error);
  const hint = error && typeof error === 'object' && 'hint' in error && typeof error.hint === 'string'
    ? error.hint : undefined;
  const redactedMessage = redactText(message, secrets);
  const redactedHint = hint ? redactText(hint, secrets) : undefined;
  if (error instanceof AuthRequiredError
    && error.domain === DOMAIN
    && redactedMessage === message
    && redactedHint === hint) return error;
  return new CommandExecutionError(
    `WeChat search_biz request failed: ${redactedMessage}`,
    redactedHint,
  );
}

/**
 * @param {{page:any,source:'browser'|'env',credentials:{token:string,cookie:string,fingerprint?:string},query:string,limit:number,fetchImpl?:typeof fetch,timeoutMs?:number}} input
 */
export async function executeSearchBiz({ page, source, credentials, query, limit, fetchImpl = fetch, timeoutMs = 30_000 }) {
  const params = new URLSearchParams({
    action: 'search_biz', scene: '1', begin: '0', count: String(limit), query,
    fingerprint: credentials.fingerprint ?? '', token: credentials.token,
    lang: 'zh_CN', f: 'json', ajax: '1',
  });
  const url = `${ENDPOINT}?${params}`;
  const headers = { Referer: REFERER, 'X-Requested-With': 'XMLHttpRequest' };

  try {
    let payload;
    if (source === 'browser') {
      payload = await page.fetchJson(url, { headers });
    } else {
      const response = await fetchImpl(url, {
        headers: { ...headers, Cookie: credentials.cookie },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new CommandExecutionError(`WeChat search_biz request failed: HTTP ${response.status}`);
      }
      payload = await response.json();
    }
    return mapSearchBizPayload(payload);
  } catch (error) {
    throw transportError(error, credentials);
  }
}
