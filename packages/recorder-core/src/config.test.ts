import { describe, it, expect } from 'vitest';
import {
  resolveScoringProfile, resolveFeatureFlags,
  DEFAULT_SCORING_PROFILE, DEFAULT_FEATURE_FLAGS,
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
