import { describe, expect, it } from 'vitest';
import { maskUrlAuthTokens } from './url-redact.js';

describe('extension url redaction', () => {
  it('masks encoded fingerprint query values while preserving unrelated params', () => {
    const url = 'https://mp.weixin.qq.com/cgi-bin/searchbiz?query=test&fingerprint=fp%2B%2F%3Dsecret';

    const masked = maskUrlAuthTokens(url);

    expect(masked).toBe('https://mp.weixin.qq.com/cgi-bin/searchbiz?query=test&fingerprint=***');
    expect(masked).not.toContain('fp%2B%2F%3Dsecret');
    expect(masked).not.toContain('fp+/=secret');
  });

  it('leaves unrelated query keys containing fingerprint unchanged', () => {
    const url = 'https://example.com/?browserfingerprintlabel=visible';

    expect(maskUrlAuthTokens(url)).toBe(url);
  });
});
