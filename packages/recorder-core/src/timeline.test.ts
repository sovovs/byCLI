// M-UI-3 因果对齐单测:时间邻近 × initiator 权重 × frame 约束 × 优雅降级。
import { describe, it, expect } from 'vitest';
import { correlateTimeline } from './timeline';

describe('correlateTimeline', () => {
  it('script-initiated 请求紧跟 click → 关联到该 click,高置信', () => {
    const r = correlateTimeline(
      [{ ts: 1000, type: 'click', selector: '#search' }],
      [{ timestamp: 1100, method: 'GET', pathname: '/api/search', initiatorType: 'script' }],
    );
    expect(r.entries[0].triggeredBy).toBe('act_0');
    expect(r.entries[0].confidence).toBeGreaterThan(0.9); // 近 + script
  });

  it('parser/preload 旁路即便在窗口内也大幅降权', () => {
    const r = correlateTimeline(
      [{ ts: 1000, type: 'click' }],
      [
        { timestamp: 1100, pathname: '/api/search', initiatorType: 'script' },
        { timestamp: 1100, pathname: '/analytics', initiatorType: 'parser' },
        { timestamp: 1100, pathname: '/preload.js', initiatorType: 'preload' },
      ],
    );
    expect(r.entries[0].confidence).toBeGreaterThan(r.entries[1].confidence); // script > parser
    expect(r.entries[1].confidence).toBeGreaterThan(r.entries[2].confidence); // parser > preload
  });

  it('窗口外 / 早于所有 action → 不关联', () => {
    const r = correlateTimeline(
      [{ ts: 1000, type: 'click' }],
      [
        { timestamp: 9000, initiatorType: 'script' }, // 8s 后,超 5s 窗口
        { timestamp: 500, initiatorType: 'script' },  // 早于 action
      ],
    );
    expect(r.entries[0].triggeredBy).toBeNull();
    expect(r.entries[1].triggeredBy).toBeNull();
  });

  it('多个 action → 取最近的前置', () => {
    const r = correlateTimeline(
      [{ ts: 1000, type: 'click', selector: '#a' }, { ts: 2000, type: 'click', selector: '#b' }],
      [{ timestamp: 2100, initiatorType: 'script' }],
    );
    expect(r.entries[0].triggeredBy).toBe('act_1'); // #b 更近
  });

  it('initiatorType 缺失 → 中性权重仍可关联(优雅降级)', () => {
    const r = correlateTimeline(
      [{ ts: 1000, type: 'click' }],
      [{ timestamp: 1050 }],
    );
    expect(r.entries[0].triggeredBy).toBe('act_0');
    expect(r.entries[0].confidence).toBeGreaterThan(0);
  });

  it('两侧都有 frameId 且不同 → 不关联(同 frame 约束)', () => {
    const r = correlateTimeline(
      [{ ts: 1000, type: 'click', frameId: 'F1' }],
      [{ timestamp: 1100, initiatorType: 'script', frameId: 'F2' }],
    );
    expect(r.entries[0].triggeredBy).toBeNull();
  });

  it('OOPIF:iframe 内 action 不关联到顶层请求(frameSessionId 强约束,顶层归一 top)', () => {
    const r = correlateTimeline(
      [{ ts: 1000, type: 'click', frameSessionId: 'S1' }], // iframe 子 session 的点击
      [{ timestamp: 1100, initiatorType: 'script' }],       // 顶层请求(无 frameSessionId → 'top')
    );
    expect(r.entries[0].triggeredBy).toBeNull(); // 'S1' !== 'top' → 不关联
  });

  it('OOPIF:同一 iframe 子 session 内 action↔请求正常关联', () => {
    const r = correlateTimeline(
      [{ ts: 1000, type: 'click', frameSessionId: 'S1' }],
      [{ timestamp: 1100, initiatorType: 'script', frameSessionId: 'S1' }],
    );
    expect(r.entries[0].triggeredBy).toBe('act_0');
  });

  it('OOPIF:顶层 action↔顶层请求关联(两侧都归一 top)', () => {
    const r = correlateTimeline(
      [{ ts: 1000, type: 'click' }],
      [{ timestamp: 1100, initiatorType: 'script' }],
    );
    expect(r.entries[0].triggeredBy).toBe('act_0');
  });

  it('OOPIF:顶层请求不关联到 iframe 内 action(反向也挡)', () => {
    const r = correlateTimeline(
      [{ ts: 1000, type: 'click' }],                                  // 顶层点击 → 'top'
      [{ timestamp: 1100, initiatorType: 'script', frameSessionId: 'S1' }], // iframe 请求
    );
    expect(r.entries[0].triggeredBy).toBeNull();
  });

  it('action 无 ts / entry 无 timestamp → 安全跳过,不抛', () => {
    const r = correlateTimeline(
      [{ type: 'click' }],
      [{ method: 'GET' }, { timestamp: 1000, initiatorType: 'script' }],
    );
    expect(r.entries[0].triggeredBy).toBeNull(); // entry 无 ts
    expect(r.entries[1].triggeredBy).toBeNull(); // 无可用 action ts
    expect(r.actions[0].id).toBe('act_0');
  });
});
