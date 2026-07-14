import { describe, expect, it, vi } from 'vitest';
import { CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';
import { captureSearchBizFingerprint } from './fingerprint.js';

function makePage({ submitted = true, fingerprint = 'fp-value', failPoll = false } = {}) {
  let reads = 0;
  return {
    evaluate: vi.fn(async (_callback, argument) => {
      if (argument?.operation === 'install') return { submitted };
      if (argument?.operation === 'read') {
        reads += 1;
        if (failPoll) throw new Error('poll failed');
        return reads > 1 ? fingerprint : null;
      }
      if (argument?.operation === 'cleanup') return undefined;
      throw new Error('unexpected operation');
    }),
    wait: vi.fn(async () => undefined),
  };
}

describe('captureSearchBizFingerprint', () => {
  it('polls with page.wait seconds and always cleans up after success', async () => {
    const page = makePage();
    await expect(captureSearchBizFingerprint(page, '微信派', 1_000)).resolves.toBe('fp-value');
    expect(page.wait).toHaveBeenCalledWith(0.1);
    expect(page.evaluate.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ operation: 'cleanup' }));
  });

  it('reports a page-change hint when no visible search control was submitted', async () => {
    const page = makePage({ submitted: false });
    const error = await captureSearchBizFingerprint(page, '微信派').catch(value => value);
    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(error.hint).toMatch(/page|layout|control/i);
    expect(page.evaluate.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ operation: 'cleanup' }));
  });

  it('maps polling failure to CommandExecutionError and cleans up', async () => {
    const page = makePage({ failPoll: true });
    await expect(captureSearchBizFingerprint(page, '微信派')).rejects.toBeInstanceOf(CommandExecutionError);
    expect(page.evaluate.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ operation: 'cleanup' }));
  });

  it('times out with TimeoutError and cleans up', async () => {
    let now = 0;
    const page = makePage({ fingerprint: null });
    page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await expect(captureSearchBizFingerprint(page, '微信派', 200)).rejects.toBeInstanceOf(TimeoutError);
    expect(page.evaluate.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ operation: 'cleanup' }));
    vi.restoreAllMocks();
  });

  it('installs wrappers that retain only the fingerprint and restore temporary state', async () => {
    const page = makePage();
    await captureSearchBizFingerprint(page, '微信派', 1_000);
    const source = page.evaluate.mock.calls[0][0].toString();
    expect(source).toContain('XMLHttpRequest');
    expect(source).toContain('fetch');
    expect(source).toContain('fingerprint');
    expect(source).not.toMatch(/cookie/i);
    expect(source).not.toMatch(/token\s*[:=]/i);
  });
});
