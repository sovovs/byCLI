import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';

export function normalizeWechatUrl(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return value;
  if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  if (value.startsWith('<') && value.endsWith('>')) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/\\+([:/&?=#%])/g, '$1');
  value = value.replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  if (value.startsWith('mp.weixin.qq.com/') || value.startsWith('//mp.weixin.qq.com/')) {
    value = `https://${value.replace(/^\/+/, '')}`;
  }
  try {
    const parsed = new URL(value);
    if (['http:', 'https:'].includes(parsed.protocol)
        && parsed.hostname.toLowerCase() === 'mp.weixin.qq.com') {
      parsed.protocol = 'https:';
      value = parsed.toString();
    }
  } catch {
    // Trust validation below reports malformed URLs.
  }
  return value;
}

function isStrictHttpsUrl(raw, hostname, pathname) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === hostname
      && url.port === '' && url.username === '' && url.password === ''
      && pathname(url.pathname);
  } catch {
    return false;
  }
}

export function isTrustedWechatArticleUrl(raw) {
  return isStrictHttpsUrl(raw, 'mp.weixin.qq.com', path => path === '/s' || path.startsWith('/s/'));
}

export function isTrustedSogouRedirectUrl(raw) {
  return isStrictHttpsUrl(raw, 'weixin.sogou.com', path => path === '/link');
}

export async function resolveWechatArticleUrl(page, rawUrl) {
  const sourceUrl = normalizeWechatUrl(rawUrl);
  if (isTrustedWechatArticleUrl(sourceUrl)) {
    return { sourceUrl, resolvedUrl: sourceUrl, alreadyNavigated: false };
  }
  if (!isTrustedSogouRedirectUrl(sourceUrl)) {
    throw new ArgumentError(
      'A trusted WeChat article or Sogou Weixin result URL is required.',
      'Pass an https://mp.weixin.qq.com/s/... or https://weixin.sogou.com/link?... URL.',
    );
  }
  try {
    await page.goto(sourceUrl);
    await page.wait(2);
    const result = await page.evaluate(`(() => ({
      finalUrl: window.location.href,
      pageText: document.body ? document.body.innerText : '',
      html: document.documentElement ? document.documentElement.innerHTML : '',
    }))()`);
    const text = `${result?.pageText || ''} ${result?.html || ''}`;
    if (/验证码|安全验证|异常访问|访问过于频繁|请输入验证码/.test(text)) {
      throw new AuthRequiredError(
        'weixin.sogou.com',
        'Sogou Weixin requires verification. Complete it in the open browser tab and run the command again.',
      );
    }
    if (!isTrustedWechatArticleUrl(result?.finalUrl)) {
      throw new CommandExecutionError(
        'Sogou Weixin did not resolve to a trusted WeChat article URL',
        'Open the search result in a browser and confirm it redirects to mp.weixin.qq.com/s/... before retrying.',
      );
    }
    return { sourceUrl, resolvedUrl: new URL(result.finalUrl).href, alreadyNavigated: true };
  } catch (error) {
    if (error instanceof AuthRequiredError || error instanceof CommandExecutionError) throw error;
    throw new CommandExecutionError('Failed to resolve the Sogou Weixin result URL');
  }
}
