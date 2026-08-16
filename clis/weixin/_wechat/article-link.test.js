import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import {
  isTrustedSogouRedirectUrl,
  isTrustedWechatArticleUrl,
  resolveWechatArticleUrl,
} from './article-link.js';

function makePage(payload) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(payload),
  };
}

describe('Weixin article link trust boundary', () => {
  it('accepts only strict HTTPS article and Sogou redirect URLs', () => {
    expect(isTrustedWechatArticleUrl('https://mp.weixin.qq.com/s/article')).toBe(true);
    expect(isTrustedSogouRedirectUrl('https://weixin.sogou.com/link?url=x')).toBe(true);
    for (const url of [
      'http://mp.weixin.qq.com/s/article',
      'https://mp.weixin.qq.com.evil.test/s/article',
      'https://weixin.sogou.com/weixin?query=x',
      'file:///etc/passwd',
    ]) {
      expect(isTrustedWechatArticleUrl(url)).toBe(false);
      expect(isTrustedSogouRedirectUrl(url)).toBe(false);
    }
  });

  it('returns trusted WeChat article URLs without browser navigation', async () => {
    const page = makePage({});
    await expect(resolveWechatArticleUrl(page, 'http://mp.weixin.qq.com/s/article'))
      .resolves.toEqual({
        sourceUrl: 'https://mp.weixin.qq.com/s/article',
        resolvedUrl: 'https://mp.weixin.qq.com/s/article',
        alreadyNavigated: false,
      });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('resolves a Sogou result to a trusted WeChat article', async () => {
    const page = makePage({
      finalUrl: 'https://mp.weixin.qq.com/s/final',
      pageText: '',
      html: '',
    });
    await expect(resolveWechatArticleUrl(page, 'https://weixin.sogou.com/link?url=x'))
      .resolves.toEqual({
        sourceUrl: 'https://weixin.sogou.com/link?url=x',
        resolvedUrl: 'https://mp.weixin.qq.com/s/final',
        alreadyNavigated: true,
      });
  });

  it('stops on verification and rejects non-article destinations', async () => {
    const blockedPage = makePage({
      finalUrl: 'https://weixin.sogou.com/antispider/',
      pageText: '请输入验证码',
      html: '',
    });
    await expect(resolveWechatArticleUrl(blockedPage, 'https://weixin.sogou.com/link?url=x'))
      .rejects.toBeInstanceOf(AuthRequiredError);

    const wrongDestinationPage = makePage({
      finalUrl: 'https://weixin.sogou.com/weixin?query=x',
      pageText: '',
      html: '',
    });
    await expect(resolveWechatArticleUrl(wrongDestinationPage, 'https://weixin.sogou.com/link?url=x'))
      .rejects.toBeInstanceOf(CommandExecutionError);
  });
});
