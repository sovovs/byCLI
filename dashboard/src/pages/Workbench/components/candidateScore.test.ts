// 候选卡双维评分推导回归测试 —— 覆盖「有 llmUtilityScore → 两维、无 → 仅 rank」及效用档位阈值。
import { describe, it, expect } from 'vitest';
import { candidateScoreDimensions, utilityBand } from './candidateScore';

describe('candidateScoreDimensions', () => {
  it('有 llmUtilityScore → 返回 rank + utility 两维', () => {
    // 演示两数不一致:权威 65/medium,LLM 效用 84/high。
    const dims = candidateScoreDimensions({ score: 65, confidence: 'medium', llmUtilityScore: 84 });
    expect(dims.rank).toEqual({ score: 65, band: 'medium' });
    expect(dims.utility).toEqual({ score: 84, band: 'high' });
  });

  it('无 llmUtilityScore(LLM-off/规则路径)→ 仅 rank,无 utility 维度', () => {
    const dims = candidateScoreDimensions({ score: 92, confidence: 'high' });
    expect(dims.rank).toEqual({ score: 92, band: 'high' });
    expect(dims.utility).toBeUndefined();
  });

  it('llmUtilityScore=0 是有效值(非缺省)→ 仍产出 utility 维度', () => {
    const dims = candidateScoreDimensions({ score: 10, confidence: 'rejected', llmUtilityScore: 0 });
    expect(dims.utility).toEqual({ score: 0, band: 'low' });
  });
});

describe('utilityBand', () => {
  it('按阈值归档:>=75 高 / >=50 中 / 其余 低(不产出 rejected)', () => {
    expect(utilityBand(75)).toBe('high');
    expect(utilityBand(84)).toBe('high');
    expect(utilityBand(50)).toBe('medium');
    expect(utilityBand(74)).toBe('medium');
    expect(utilityBand(49)).toBe('low');
    expect(utilityBand(0)).toBe('low');
  });
});
