import { describe, it, expect } from 'vitest';
import { createMetrics } from './metrics.js';

describe('metrics registry (09 Metrics) — shared core implementation', () => {
  it('counters key by name + sorted non-empty labels (undefined/empty dropped)', () => {
    const m = createMetrics();
    m.inc('requests_total', { operation: 'verify', status: 'ok' });
    m.inc('requests_total', { operation: 'verify', status: 'ok' });
    m.inc('requests_total', { status: 'failed', operation: 'verify', errorCode: undefined });
    m.inc('requests_total', { operation: 'verify', status: 'ok', empty: '' }); // empty label dropped → merges with first key
    m.inc('idempotency_conflict_total');
    const s = m.snapshot();
    expect(s.counters['requests_total{operation=verify,status=ok}']).toBe(3);
    expect(s.counters['requests_total{operation=verify,status=failed}']).toBe(1);
    expect(s.counters['idempotency_conflict_total']).toBe(1);
  });

  it('histograms track count/sum/min/max', () => {
    const m = createMetrics();
    m.observe('duration_ms', 10);
    m.observe('duration_ms', 30);
    m.observe('duration_ms', 20);
    expect(m.snapshot().histograms['duration_ms']).toEqual({ count: 3, sum: 60, min: 10, max: 30 });
  });

  it('inc by N', () => {
    const m = createMetrics();
    m.inc('c', undefined, 5);
    m.inc('c', undefined, 3);
    expect(m.snapshot().counters['c']).toBe(8);
  });

  it('snapshot is a detached copy (mutating after snapshot does not affect it)', () => {
    const m = createMetrics();
    m.inc('c');
    m.observe('h', 5);
    const s1 = m.snapshot();
    m.inc('c');
    m.observe('h', 15);
    expect(s1.counters['c']).toBe(1);                 // frozen at snapshot time
    expect(s1.histograms['h']).toEqual({ count: 1, sum: 5, min: 5, max: 5 });
  });
});
