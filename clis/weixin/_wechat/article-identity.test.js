import { describe, expect, it } from 'vitest';
import { canonicalWechatArticleIdentity, hashResourceValue } from './article-identity.js';

describe('canonicalWechatArticleIdentity', () => {
  it('ignores fragments and query order for parameterized article URLs', () => {
    const first = 'https://mp.weixin.qq.com/s?__biz=biz&mid=10&idx=1&sn=abc#wechat_redirect';
    const second = 'https://mp.weixin.qq.com/s?sn=abc&idx=1&mid=10&__biz=biz';
    expect(canonicalWechatArticleIdentity(first)).toBe(canonicalWechatArticleIdentity(second));
  });

  it('uses host and path for opaque article links', () => {
    expect(canonicalWechatArticleIdentity('https://mp.weixin.qq.com/s/opaque?utm_source=x'))
      .toBe(canonicalWechatArticleIdentity('https://mp.weixin.qq.com/s/opaque#fragment'));
  });

  it('returns hashes that do not expose URL tokens', () => {
    const identity = canonicalWechatArticleIdentity('https://mp.weixin.qq.com/s?token=secret&foo=bar');
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    expect(identity).not.toContain('secret');
    expect(hashResourceValue('/private/output')).toMatch(/^[a-f0-9]{64}$/);
  });
});
