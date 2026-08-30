import { describe, expect, it } from 'vitest';
import { ArgumentError, CommandExecutionError, RateLimitedError } from '@sovovs/bycli/errors';
import { WechatOfficialApiError } from './api-freepublish.js';
import { isFreepublishFallbackEligible, requireBrowserFallbackUrl } from './freepublish-fallback.js';

describe('freepublish browser fallback policy', () => {
  it.each([48001, 50001])('allows explicit capability error %s', code => {
    expect(isFreepublishFallbackEligible(new WechatOfficialApiError('api', code, 'unauthorized'))).toBe(true);
  });

  it.each([
    new CommandExecutionError('network'), new RateLimitedError('limited'), new ArgumentError('bad'),
    new WechatOfficialApiError('api', 40001, 'bad credential'),
  ])('rejects non-capability failure %#', error => {
    expect(isFreepublishFallbackEligible(error)).toBe(false);
  });

  it('requires a trusted public URL for single-article fallback', () => {
    expect(requireBrowserFallbackUrl('https://mp.weixin.qq.com/s/abc')).toBe('https://mp.weixin.qq.com/s/abc');
    expect(() => requireBrowserFallbackUrl('')).toThrowError(expect.objectContaining({ code: 'ARGUMENT' }));
    expect(() => requireBrowserFallbackUrl('https://example.com/a')).toThrowError(expect.objectContaining({ code: 'ARGUMENT' }));
  });
});
