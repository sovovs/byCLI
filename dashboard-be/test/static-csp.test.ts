// CSP frame-src B+A 混合(embedded_iframe 录制模式)三态 + 安全边界单测。
// resolveFrameSrc 是纯函数,直接断言三态;只放 https:、绝不放裸 *。
import { describe, it, expect } from 'vitest';
import { resolveFrameSrc } from '../src/static.js';

describe('resolveFrameSrc · embedded_iframe CSP frame-src 三态', () => {
  it('flag off → undefined(无 frame-src,现状零变化)', () => {
    expect(resolveFrameSrc(false)).toBeUndefined();
    expect(resolveFrameSrc(false, ['https://juejin.cn'])).toBeUndefined(); // flag 主导,override 不生效
  });

  it('flag on + 无 override → https:(填 URL 即录,无需预配置)', () => {
    expect(resolveFrameSrc(true)).toBe('https:');
    expect(resolveFrameSrc(true, [])).toBe('https:'); // 空 override 等价未配置
  });

  it('flag on + override → 只放配置的 https origin(空格分隔,CI/企业 hardened)', () => {
    expect(resolveFrameSrc(true, ['https://juejin.cn'])).toBe('https://juejin.cn');
    expect(resolveFrameSrc(true, ['https://juejin.cn', 'https://example.com']))
      .toBe('https://juejin.cn https://example.com');
  });

  it('override 值从不引入裸通配/非 https 协议(由 config zod 守门,这里固化行为契约)', () => {
    const out = resolveFrameSrc(true, ['https://a.com']);
    expect(out).not.toContain('*');
    expect(out).not.toContain('http://');
    expect(out).not.toContain('data:');
    expect(out).not.toContain('blob:');
  });
});
