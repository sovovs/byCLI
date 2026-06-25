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
    // 7 步,索引 0..6,done 时 current=7
    for (let i = 0; i < 7; i++) expect(stepStatus(i, 7, false)).toBe('done');
  });

  it('verify 失败:高亮 verify 步(索引6),不落到 step0、不越界丢失', () => {
    // 修复点:verifying 映射到索引6;失败时 current=6
    expect(stepStatus(6, 6, true)).toBe('failed');
    expect(stepStatus(5, 6, true)).toBe('done');
    expect(stepStatus(0, 6, true)).toBe('done');
  });

  it('早期失败定位到失败前所在步骤', () => {
    expect(stepStatus(1, 1, true)).toBe('failed'); // 在 bind 步失败
    expect(stepStatus(0, 1, true)).toBe('done');
    expect(stepStatus(2, 1, true)).toBe('pending');
  });
});
