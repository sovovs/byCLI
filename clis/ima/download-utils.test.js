import { describe, expect, it } from 'vitest';
import { extractOriginUrl, resolveOutputPath, validateImaOriginUrl } from './download-utils.js';

describe('ima download utils', () => {
  it('extracts and validates the signed originUrl from the viewer URL', () => {
    const origin = 'https://res-skb.ima.qq.com/5/file.pdf?sign=abc';
    const viewer = `chrome-extension://viewer/index.html?originUrl=${encodeURIComponent(origin)}`;
    expect(extractOriginUrl(viewer)).toBe(origin);
    expect(validateImaOriginUrl(origin)).toBe(origin);
  });

  it('rejects missing or foreign origin URLs', () => {
    expect(() => extractOriginUrl('chrome-extension://viewer/index.html')).toThrow(/originUrl/);
    expect(() => validateImaOriginUrl('https://example.com/file.pdf')).toThrow(/IMA resource/);
  });

  it('resolves a safe filename for directory and file outputs', () => {
    expect(resolveOutputPath('/tmp/out', 'trustgraph analyze.pdf')).toBe('/tmp/out/trustgraph analyze.pdf');
    expect(resolveOutputPath('/tmp/out/result.bin', 'trustgraph analyze.pdf')).toBe('/tmp/out/result.bin');
  });
});
