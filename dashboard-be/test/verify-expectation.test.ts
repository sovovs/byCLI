// N3 verifyExpectation 比对单测。
import { describe, it, expect } from 'vitest';
import { meetsExpectation } from '../src/llm/verify-expectation.js';
import type { VerifyExpectation } from '../src/llm/generate.js';

const exp = (o: Partial<VerifyExpectation>): VerifyExpectation =>
  ({ commandName: 'x/y', verifyArgs: {}, minRows: 1, expectedFieldCount: 0, allowedOrigins: [], expectedStage: 'execute', ...o });

describe('meetsExpectation', () => {
  it('达标:ok + 满足 minRows/fieldCount/stage', () => {
    expect(meetsExpectation({ ok: true, stage: 'execute', rows: 3, fieldCount: 2 }, exp({ minRows: 2, expectedFieldCount: 2 })))
      .toMatchObject({ ok: true, rows: 3, fieldCount: 2, reasons: [] });
  });
  it('verify ok=false → 不达标', () => {
    expect(meetsExpectation({ ok: false, stage: 'execute', rows: 5 }, exp({})).ok).toBe(false);
  });
  it('rows 不足 → 不达标', () => {
    expect(meetsExpectation({ ok: true, rows: 0 }, exp({ minRows: 1 })).reasons.join()).toContain('rows');
  });
  it('fieldCount 不符(期望>0)→ 不达标', () => {
    expect(meetsExpectation({ ok: true, rows: 1, fieldCount: 5 }, exp({ expectedFieldCount: 3 })).reasons.join()).toContain('fieldCount');
  });
  it('stage 不符 → 不达标', () => {
    expect(meetsExpectation({ ok: true, rows: 1, stage: 'load' }, exp({ expectedStage: 'execute' })).reasons.join()).toContain('stage');
  });
  it('无 expectation → 退回最低门槛(ok 且 rows≥1)', () => {
    expect(meetsExpectation({ ok: true, rows: 1 }).ok).toBe(true);
    expect(meetsExpectation({ ok: true, rows: 0 }).ok).toBe(false);
    expect(meetsExpectation(null).ok).toBe(false);
  });
});
