import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigInvalidError } from '../src/config.js';
import { DEFAULT_SCORING_PROFILE, DEFAULT_FEATURE_FLAGS } from '@sovovs/bycli-recorder-core';

describe('loadConfig — M8a ScoringProfile + FeatureFlags wiring', () => {
  it('exposes the default profile + fail-closed flags when nothing is set', () => {
    const cfg = loadConfig({});
    expect(cfg.scoringProfile).toEqual(DEFAULT_SCORING_PROFILE);
    expect(cfg.featureFlags).toEqual(DEFAULT_FEATURE_FLAGS);
  });

  it('applies valid RANK_SCORE_* overrides + FEATURE_* flags', () => {
    const cfg = loadConfig({ RANK_SCORE_HIGH_MIN: '60', FEATURE_PREVIEW_SCORING_PROFILE: 'true', RELEASE_CHANNEL: 'preview' });
    expect(cfg.scoringProfile.RANK_SCORE_HIGH_MIN).toBe(60);
    expect(cfg.featureFlags.FEATURE_PREVIEW_SCORING_PROFILE).toBe(true);
    expect(cfg.featureFlags.RELEASE_CHANNEL).toBe('preview');
  });

  it('fails fast (config_invalid) on an out-of-range RANK_SCORE_* value', () => {
    expect(() => loadConfig({ RANK_SCORE_STABLE_JSON_SHAPE_DELTA: '9999' })).toThrow(ConfigInvalidError);
  });

  it('fails fast (config_invalid) on a malformed feature flag', () => {
    expect(() => loadConfig({ FEATURE_DIRECT_CDP_CAPTURE: 'maybe' })).toThrow(ConfigInvalidError);
  });

  it('parses RECORDER_IFRAME_FRAME_SRC into an https origin list', () => {
    const cfg = loadConfig({ RECORDER_IFRAME_FRAME_SRC: 'https://juejin.cn, https://example.com' });
    expect(cfg.IFRAME_FRAME_SRC).toEqual(['https://juejin.cn', 'https://example.com']);
  });

  it('leaves IFRAME_FRAME_SRC undefined when unset', () => {
    expect(loadConfig({}).IFRAME_FRAME_SRC).toBeUndefined();
  });

  it('fails fast (config_invalid) on a non-https iframe frame-src origin', () => {
    expect(() => loadConfig({ RECORDER_IFRAME_FRAME_SRC: 'http://insecure.example' })).toThrow(ConfigInvalidError);
  });
});
