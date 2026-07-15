import { describe, expect, it, vi } from 'vitest';
import { verifyAdapter, type RunnerPort } from './verify.js';

function runner(startVerify = vi.fn(async () => ({ requestId: 'req_1' }))): RunnerPort {
  return {
    startVerify,
    getVerifyStatus: async () => null,
    cancelVerify: async () => ({ cancelled: false }),
  };
}

describe('verifyAdapter expected source hash', () => {
  it('forwards a valid lowercase SHA-256 to the runner', async () => {
    const startVerify = vi.fn(async () => ({ requestId: 'req_1' }));
    const expectedSourceSha256 = 'a'.repeat(64);

    const result = await verifyAdapter(
      { name: 'site/cmd', expectedSourceSha256 },
      'session-key',
      runner(startVerify),
    );

    expect(result).toEqual({ ok: true, requestId: 'req_1' });
    expect(startVerify).toHaveBeenCalledWith(expect.objectContaining({ expectedSourceSha256 }));
  });

  it.each(['A'.repeat(64), 'a'.repeat(63), 'not-a-hash'])(
    'rejects malformed expected hash %s without starting the runner',
    async (expectedSourceSha256) => {
      const startVerify = vi.fn(async () => ({ requestId: 'req_1' }));
      const result = await verifyAdapter(
        { name: 'site/cmd', expectedSourceSha256 },
        'session-key',
        runner(startVerify),
      );
      expect(result).toMatchObject({ ok: false, errorCode: 'validation_failed' });
      expect(startVerify).not.toHaveBeenCalled();
    },
  );
});
