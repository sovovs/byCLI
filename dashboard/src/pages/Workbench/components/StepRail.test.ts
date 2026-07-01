// StepRail 状态推导回归测试 —— 覆盖 done/active/pending/failed 及 verify 失败定位。
import { describe, it, expect } from 'vitest';
import { stepStatus } from './StepRail';

describe('stepStatus', () => {
  it('current 之前=done、current=active、之后=pending', () => {
    expect(stepStatus(0, 2, false)).toBe('done');
    expect(stepStatus(1, 2, false)).toBe('done');
    expect(stepStatus(2, 2, false)).toBe('active');
    expect(stepStatus(3, 2, false)).toBe('pending');
  });

  it('done 态(current=步数)→ 所有步骤都 done', () => {
    // stepStatus 是纯索引逻辑(与具体步数无关):current=N 时索引 0..N-1 全 done。
    for (let i = 0; i < 5; i++) expect(stepStatus(i, 5, false)).toBe('done');
  });

  it('末步失败定位:高亮该步、不落 step0、不越界', () => {
    expect(stepStatus(4, 4, true)).toBe('failed');
    expect(stepStatus(3, 4, true)).toBe('done');
    expect(stepStatus(0, 4, true)).toBe('done');
  });

  it('早期失败定位到失败前所在步骤', () => {
    expect(stepStatus(1, 1, true)).toBe('failed'); // 在 bind 步失败
    expect(stepStatus(0, 1, true)).toBe('done');
    expect(stepStatus(2, 1, true)).toBe('pending');
  });
});
