import { describe, it, expect } from 'vitest';
import { createMetrics } from '../src/metrics.js';

describe('metrics registry (M8c · 09)', () => {
  it('counters key by name + sorted non-empty labels', () => {
    const m = createMetrics();
    m.inc('recorder_requests_total', { operation: 'recorder.verify', status: 'ok' });
    m.inc('recorder_requests_total', { operation: 'recorder.verify', status: 'ok' });
    m.inc('recorder_requests_total', { status: 'failed', operation: 'recorder.verify', errorCode: undefined }); // undefined dropped
    m.inc('recorder_idempotency_conflict_total');
    const s = m.snapshot();
    expect(s.counters['recorder_requests_total{operation=recorder.verify,status=ok}']).toBe(2);
    expect(s.counters['recorder_requests_total{operation=recorder.verify,status=failed}']).toBe(1);
    expect(s.counters['recorder_idempotency_conflict_total']).toBe(1);
  });

  it('histograms track count/sum/min/max', () => {
    const m = createMetrics();
    m.observe('recorder_request_duration_ms', 10);
    m.observe('recorder_request_duration_ms', 30);
    m.observe('recorder_request_duration_ms', 20);
    expect(m.snapshot().histograms['recorder_request_duration_ms']).toEqual({ count: 3, sum: 60, min: 10, max: 30 });
  });

  it('inc by N', () => {
    const m = createMetrics();
    m.inc('c', undefined, 5);
    m.inc('c', undefined, 3);
    expect(m.snapshot().counters['c']).toBe(8);
  });
});
