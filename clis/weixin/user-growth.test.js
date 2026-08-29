import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmptyResultError } from '@sovovs/bycli/errors';
import { getRegistry } from '@sovovs/bycli/registry';

const mocks = vi.hoisted(() => ({
  resolveBrowserCredentials: vi.fn(),
  resolveGrowthRange: vi.fn(),
  parseGrowthSources: vi.fn(),
  collectGrowth: vi.fn(),
}));

vi.mock('./_wechat/auth-session.js', () => ({
  resolveBrowserCredentials: mocks.resolveBrowserCredentials,
}));
vi.mock('./_wechat/user-analysis.js', () => ({
  resolveGrowthRange: mocks.resolveGrowthRange,
  parseGrowthSources: mocks.parseGrowthSources,
  collectGrowth: mocks.collectGrowth,
}));

await import('./user-growth.js');

describe('weixin user-growth command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveBrowserCredentials.mockResolvedValue({ token: '42', cookie: 'sid=x' });
    mocks.resolveGrowthRange.mockReturnValue({ begin: '2026-08-01', end: '2026-08-28' });
    mocks.parseGrowthSources.mockReturnValue([{ code: 1, name: 'search' }]);
    mocks.collectGrowth.mockResolvedValue([{
      date: '2026-08-28', source: 'search', sourceCode: 1, newFollowers: 3,
      unfollows: 1, netNewFollowers: 2, cumulativeFollowers: 10,
    }]);
  });

  it('registers the stable read-only contract', () => {
    const command = getRegistry().get('weixin/user-growth');
    expect(command).toMatchObject({ access: 'read', strategy: 'cookie', browser: true, navigateBefore: false });
    expect(command.args.map(arg => arg.name)).toEqual(['begin', 'end', 'source']);
    expect(command.columns).toEqual([
      'date', 'source', 'source_code', 'new_followers', 'unfollows',
      'net_new_followers', 'cumulative_followers',
    ]);
  });

  it('reuses browser credentials, validates options, and projects snake_case rows', async () => {
    const command = getRegistry().get('weixin/user-growth');
    const page = {};
    await expect(command.func(page, { begin: '2026-08-01', end: '2026-08-28', source: 'search' }))
      .resolves.toEqual([{
        date: '2026-08-28', source: 'search', source_code: 1, new_followers: 3,
        unfollows: 1, net_new_followers: 2, cumulative_followers: 10,
      }]);
    expect(mocks.resolveBrowserCredentials).toHaveBeenCalledWith(page);
    expect(mocks.collectGrowth).toHaveBeenCalledWith({
      page, token: '42', begin: '2026-08-01', end: '2026-08-28',
      sources: [{ code: 1, name: 'search' }],
    });
  });

  it('raises a typed empty result when no growth rows are returned', async () => {
    mocks.collectGrowth.mockResolvedValue([]);
    const command = getRegistry().get('weixin/user-growth');
    await expect(command.func({}, {})).rejects.toBeInstanceOf(EmptyResultError);
  });
});
