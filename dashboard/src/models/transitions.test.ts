// model 状态门禁单测:合法/非法转移判定(model run() 据此决定就地 invalid_state 还是发请求)。
import { describe, it, expect } from 'vitest';
import { isActionAllowed } from './transitions';

describe('isActionAllowed(model 状态门禁)', () => {
  it('合法来源态 → true', () => {
    expect(isActionAllowed('health', 'idle')).toBe(true);
    expect(isActionAllowed('bind', 'health_checked')).toBe(true);
    expect(isActionAllowed('navigate', 'page_ready')).toBe(true);
    expect(isActionAllowed('captureA', 'page_ready')).toBe(true);
    expect(isActionAllowed('captureB', 'capture_a')).toBe(true);
    expect(isActionAllowed('rank', 'capture_b')).toBe(true);
    expect(isActionAllowed('previewInit', 'ranked')).toBe(true);
    expect(isActionAllowed('writeInit', 'ranked')).toBe(true);
    expect(isActionAllowed('verify', 'draft_created')).toBe(true);
  });
  it('非法来源态 → false(就地 invalid_state,不发请求)', () => {
    expect(isActionAllowed('rank', 'page_ready')).toBe(false); // rank 必须从 capture_b
    expect(isActionAllowed('verify', 'ranked')).toBe(false); // verify 必须从 draft_created
    expect(isActionAllowed('navigate', 'idle')).toBe(false);
    expect(isActionAllowed('captureA', 'capture_a')).toBe(false); // A 只能从 page_ready
    expect(isActionAllowed('writeInit', 'draft_created')).toBe(false); // 已写过
  });
  it('captureStart 可从 page_ready 和 capture_a(A/B 两样本),不可从 capture_b', () => {
    expect(isActionAllowed('captureStart', 'page_ready')).toBe(true);
    expect(isActionAllowed('captureStart', 'capture_a')).toBe(true);
    expect(isActionAllowed('captureStart', 'capture_b')).toBe(false);
  });
});
