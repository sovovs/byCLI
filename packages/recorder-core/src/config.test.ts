import { describe, it, expect } from 'vitest';
import {
  resolveScoringProfile, resolveFeatureFlags, validateTempCapacity,
  DEFAULT_SCORING_PROFILE, DEFAULT_FEATURE_FLAGS, DEFAULT_TEMP_CAPACITY,
} from './index.js';

describe('resolveScoringProfile (M8a · RANK_SCORE_* env → validated profile)', () => {
  it('missing keys → the default profile', () => {
    const r = resolveScoringProfile({});
    expect(r.ok && r.profile).toEqual(DEFAULT_SCORING_PROFILE);
  });

  it('applies valid overrides, keeps the rest default', () => {
    const r = resolveScoringProfile({ RANK_SCORE_HIGH_MIN: '60', RANK_SCORE_STABLE_JSON_SHAPE_DELTA: '40' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.profile.RANK_SCORE_HIGH_MIN).toBe(60);
      expect(r.profile.RANK_SCORE_STABLE_JSON_SHAPE_DELTA).toBe(40);
      expect(r.profile.RANK_SCORE_MEDIUM_MIN).toBe(DEFAULT_SCORING_PROFILE.RANK_SCORE_MEDIUM_MIN); // untouched
    }
  });

  it('non-integer → config_invalid', () => {
    const r = resolveScoringProfile({ RANK_SCORE_HIGH_MIN: '7.5' });
    expect(r).toMatchObject({ ok: false, errorCode: 'config_invalid' });
  });

  it('out-of-range delta → config_invalid (via validateScoringProfile)', () => {
    const r = resolveScoringProfile({ RANK_SCORE_STABLE_JSON_SHAPE_DELTA: '5000' });
    expect(r).toMatchObject({ ok: false, errorCode: 'config_invalid' });
  });

  it('band-order violation (HIGH<=MEDIUM) → config_invalid', () => {
    const r = resolveScoringProfile({ RANK_SCORE_HIGH_MIN: '40' }); // default MEDIUM_MIN=50 > 40
    expect(r).toMatchObject({ ok: false, errorCode: 'config_invalid' });
  });
});

describe('resolveFeatureFlags (M8a · FEATURE_* env → validated flags, default fail-closed)', () => {
  it('missing → all defaults (flags off, stable, experiment off)', () => {
    const r = resolveFeatureFlags({});
    expect(r.ok && r.flags).toEqual(DEFAULT_FEATURE_FLAGS);
  });

  it('parses booleans (true/1 → true, false/0 → false)', () => {
    const r = resolveFeatureFlags({ FEATURE_PREVIEW_SCORING_PROFILE: 'true', FEATURE_LOCALHOST_HTTP_UI: '0' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.flags.FEATURE_PREVIEW_SCORING_PROFILE).toBe(true);
      expect(r.flags.FEATURE_LOCALHOST_HTTP_UI).toBe(false);
    }
  });

  it('malformed boolean → config_invalid', () => {
    const r = resolveFeatureFlags({ FEATURE_DIRECT_CDP_CAPTURE: 'yes' });
    expect(r).toMatchObject({ ok: false, errorCode: 'config_invalid' });
  });

  it('valid enums applied; invalid → config_invalid', () => {
    const ok = resolveFeatureFlags({ RELEASE_CHANNEL: 'preview', LOCAL_EXPERIMENT_PROFILE: 'candidate' });
    expect(ok.ok && ok.flags.RELEASE_CHANNEL).toBe('preview');
    expect(ok.ok && ok.flags.LOCAL_EXPERIMENT_PROFILE).toBe('candidate');
    expect(resolveFeatureFlags({ RELEASE_CHANNEL: 'beta' })).toMatchObject({ ok: false, errorCode: 'config_invalid' });
    expect(resolveFeatureFlags({ LOCAL_EXPERIMENT_PROFILE: 'treatment' })).toMatchObject({ ok: false, errorCode: 'config_invalid' });
  });
});

describe('validateTempCapacity (#1d · RECORDER_TEMP_* → validated capacity, default fail-open)', () => {
  it('missing → defaults', () => {
    const r = validateTempCapacity({});
    expect(r.ok && r.capacity).toEqual(DEFAULT_TEMP_CAPACITY);
  });

  it('applies valid overrides (int maxBytes + float ratios)', () => {
    const r = validateTempCapacity({ maxBytes: '52428800', highWatermarkRatio: '0.8', lowWatermarkRatio: '0.5' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.capacity).toEqual({ maxBytes: 52428800, highWatermarkRatio: 0.8, lowWatermarkRatio: 0.5 });
  });

  it('maxBytes out of range or non-integer → config_invalid', () => {
    expect(validateTempCapacity({ maxBytes: '100' })).toMatchObject({ ok: false, errorCode: 'config_invalid' });        // below 10 MiB
    expect(validateTempCapacity({ maxBytes: '20000000000' })).toMatchObject({ ok: false, errorCode: 'config_invalid' }); // above 10 GiB
    expect(validateTempCapacity({ maxBytes: '10485760.5' })).toMatchObject({ ok: false, errorCode: 'config_invalid' });  // non-integer
  });

  it('ratio out of range → config_invalid', () => {
    expect(validateTempCapacity({ highWatermarkRatio: '0.99' })).toMatchObject({ ok: false, errorCode: 'config_invalid' }); // > 0.95
    expect(validateTempCapacity({ lowWatermarkRatio: '0.05' })).toMatchObject({ ok: false, errorCode: 'config_invalid' });  // < 0.1
  });

  it('band-order: low >= high → config_invalid', () => {
    expect(validateTempCapacity({ highWatermarkRatio: '0.6', lowWatermarkRatio: '0.7' })).toMatchObject({ ok: false, errorCode: 'config_invalid' });
    expect(validateTempCapacity({ highWatermarkRatio: '0.6', lowWatermarkRatio: '0.6' })).toMatchObject({ ok: false, errorCode: 'config_invalid' });
  });
});
