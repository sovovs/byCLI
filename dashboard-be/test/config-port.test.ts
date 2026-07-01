import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createConfigPort } from '../src/config-port.js';

const TOKEN = 'start-token-1234567890';

function setup(startEnv: Record<string, string> = {}) {
  const startup = loadConfig({ RECORDER_TOKEN: TOKEN, ...startEnv });
  let appliedLevel: string | undefined;
  const port = createConfigPort(startup, (l) => { appliedLevel = l; });
  return { startup, port, appliedLevel: () => appliedLevel };
}

describe('ConfigPort hot reload (M8d · 09)', () => {
  it('valid reload bumps version, swaps hot fields, applies LOG_LEVEL immediately', () => {
    const { port, appliedLevel } = setup();
    expect(port.version()).toBe(1);
    const r = port.reload({ RECORDER_TOKEN: TOKEN, LOG_LEVEL: 'debug', RANK_SCORE_HIGH_MIN: '60', FEATURE_PREVIEW_SCORING_PROFILE: 'true' });
    expect(r).toMatchObject({ ok: true, version: 2 });
    expect(port.version()).toBe(2);
    expect(port.current().LOG_LEVEL).toBe('debug');
    expect(appliedLevel()).toBe('debug'); // 09: LOG_LEVEL is the immediate, process-global exception
    expect(port.current().scoringProfile.RANK_SCORE_HIGH_MIN).toBe(60);
    expect(port.current().featureFlags.FEATURE_PREVIEW_SCORING_PROFILE).toBe(true);
  });

  it('invalid reload keeps the old snapshot + version (config_invalid)', () => {
    const { port } = setup();
    const r = port.reload({ RECORDER_TOKEN: TOKEN, RANK_SCORE_HIGH_MIN: '9999' }); // out of range → config_invalid
    expect(r.ok).toBe(false);
    expect(port.version()).toBe(1);                                  // unchanged
    expect(port.current().scoringProfile.RANK_SCORE_HIGH_MIN).toBe(70); // default kept (14-plan 第4步: 75→70)
  });

  it('pins security + restart fields — token / origins / restart-only flags never hot-change', () => {
    const { port, startup } = setup({ RECORDER_ALLOWED_ORIGINS: 'http://127.0.0.1:9000' });
    port.reload({ RECORDER_TOKEN: 'evil-different-token-99999', RECORDER_ALLOWED_ORIGINS: 'http://evil.test', FEATURE_LOCALHOST_HTTP_UI: 'true' });
    expect(port.current().TOKEN).toBe(startup.TOKEN);                 // security: token pinned
    expect(port.current().ALLOWED_ORIGINS).toEqual(startup.ALLOWED_ORIGINS); // security: origin allowlist pinned
    expect(port.current().featureFlags.FEATURE_LOCALHOST_HTTP_UI).toBe(false); // restart-only flag pinned
  });
});
