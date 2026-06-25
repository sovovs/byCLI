import { describe, it, expect } from 'vitest';
import { resolveTempPolicy } from './config.js';
import { ConfigError } from '../../errors.js';

describe('resolveTempPolicy (M7b · 09:27-29)', () => {
  it('returns documented defaults when env is empty', () => {
    const p = resolveTempPolicy({});
    expect(p).toEqual({ tempTtlMs: 3_600_000, startupReapMaxAgeMs: 86_400_000, orphanKillGraceMs: 1_500 });
  });

  it('treats empty string as unset → default', () => {
    const p = resolveTempPolicy({ RECORDER_TEMP_TTL_MS: '', RECORDER_ORPHAN_KILL_GRACE_MS: '' });
    expect(p.tempTtlMs).toBe(3_600_000);
    expect(p.orphanKillGraceMs).toBe(1_500);
  });

  it('reads valid in-range integer overrides', () => {
    const p = resolveTempPolicy({
      RECORDER_TEMP_TTL_MS: '120000',
      RECORDER_STARTUP_REAP_MAX_AGE_MS: '7200000',
      RECORDER_ORPHAN_KILL_GRACE_MS: '5000',
    });
    expect(p).toEqual({ tempTtlMs: 120000, startupReapMaxAgeMs: 7200000, orphanKillGraceMs: 5000 });
  });

  it('throws ConfigError below the min (fail closed)', () => {
    expect(() => resolveTempPolicy({ RECORDER_TEMP_TTL_MS: '59999' })).toThrow(ConfigError); // < 60000
    expect(() => resolveTempPolicy({ RECORDER_ORPHAN_KILL_GRACE_MS: '99' })).toThrow(ConfigError); // < 100
  });

  it('throws ConfigError above the max', () => {
    expect(() => resolveTempPolicy({ RECORDER_TEMP_TTL_MS: '86400001' })).toThrow(ConfigError); // > 24h
    expect(() => resolveTempPolicy({ RECORDER_ORPHAN_KILL_GRACE_MS: '30001' })).toThrow(ConfigError); // > 30000
  });

  it('throws ConfigError on non-integer', () => {
    expect(() => resolveTempPolicy({ RECORDER_TEMP_TTL_MS: 'abc' })).toThrow(ConfigError);
    expect(() => resolveTempPolicy({ RECORDER_TEMP_TTL_MS: '60000.5' })).toThrow(ConfigError);
  });
});
