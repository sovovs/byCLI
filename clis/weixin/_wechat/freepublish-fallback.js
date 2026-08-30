import { ArgumentError } from '@sovovs/bycli/errors';
import { isTrustedWechatArticleUrl } from './article-link.js';
import { WechatOfficialApiError } from './api-freepublish.js';

const FALLBACK_CODES = new Set([48001, 50001]);

export function isFreepublishFallbackEligible(error) {
  return error instanceof WechatOfficialApiError && FALLBACK_CODES.has(error.wechatErrcode);
}

export function requireBrowserFallbackUrl(value) {
  const url = String(value ?? '').trim();
  if (!url || !isTrustedWechatArticleUrl(url)) {
    throw new ArgumentError('Browser article fallback requires a trusted mp.weixin.qq.com article URL');
  }
  return url;
}
