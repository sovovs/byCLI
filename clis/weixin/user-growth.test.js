import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentError, EmptyResultError } from '@sovovs/bycli/errors';
import { getRegistry } from '@sovovs/bycli/registry';

const mocks = vi.hoisted(() => ({
  resolveBrowserCredentials: vi.fn(),
  resolveGrowthRange: vi.fn(),
  parseGrowthSources: vi.fn(),
  collectGrowth: vi.fn(),
  downloadUserGrowthXls: vi.fn(),
}));

vi.mock('./_wechat/auth-session.js', () => ({
  resolveBrowserCredentials: mocks.resolveBrowserCredentials,
}));
vi.mock('./_wechat/user-analysis.js', () => ({
  resolveGrowthRange: mocks.resolveGrowthRange,
  parseGrowthSources: mocks.parseGrowthSources,
  collectGrowth: mocks.collectGrowth,
}));
vi.mock('./_wechat/user-growth-download.js', () => ({
  downloadUserGrowthXls: mocks.downloadUserGrowthXls,
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
    mocks.downloadUserGrowthXls.mockResolvedValue({
      status: 'downloaded', path: '/exports/growth.xls', size: 123,
    });
  });

  it('registers the optional-write contract and stable artifact columns', () => {
    const command = getRegistry().get('weixin/user-growth');
    expect(command).toMatchObject({ access: 'write', strategy: 'cookie', browser: true, navigateBefore: false });
    expect(command.args.map(arg => arg.name)).toEqual(['begin', 'end', 'source', 'output']);
    expect(command.columns).toEqual([
      'date', 'source', 'source_code', 'new_followers', 'unfollows',
      'net_new_followers', 'cumulative_followers', 'official_xls_path', 'official_xls_size',
    ]);
  });

  it('reuses browser credentials, validates options, and projects snake_case rows', async () => {
    const command = getRegistry().get('weixin/user-growth');
    const page = {};
    await expect(command.func(page, { begin: '2026-08-01', end: '2026-08-28', source: 'search' }))
      .resolves.toEqual([{
        date: '2026-08-28', source: 'search', source_code: 1, new_followers: 3,
        unfollows: 1, net_new_followers: 2, cumulative_followers: 10,
        official_xls_path: null, official_xls_size: null,
      }]);
    expect(mocks.resolveBrowserCredentials).toHaveBeenCalledWith(page);
    expect(mocks.collectGrowth).toHaveBeenCalledWith({
      page, token: '42', begin: '2026-08-01', end: '2026-08-28',
      sources: [{ code: 1, name: 'search' }],
    });
    expect(mocks.downloadUserGrowthXls).not.toHaveBeenCalled();
  });

  it('downloads one aggregate workbook only when output is provided', async () => {
    mocks.collectGrowth.mockResolvedValue([
      { date: '2026-08-27', source: 'all', sourceCode: 99999999, newFollowers: 1, unfollows: 0, netNewFollowers: 1, cumulativeFollowers: 9 },
      { date: '2026-08-28', source: 'search', sourceCode: 1, newFollowers: 3, unfollows: 1, netNewFollowers: 2, cumulativeFollowers: 10 },
    ]);
    const command = getRegistry().get('weixin/user-growth');
    const rows = await command.func({}, { source: 'all-sources', output: './exports' });
    expect(mocks.downloadUserGrowthXls).toHaveBeenCalledWith({}, {
      token: '42', begin: '2026-08-01', end: '2026-08-28', outputDir: './exports',
    });
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.official_xls_path === '/exports/growth.xls'
      && row.official_xls_size === 123)).toBe(true);
  });

  it('rejects a blank output directory', async () => {
    const command = getRegistry().get('weixin/user-growth');
    await expect(command.func({}, { output: '  ' })).rejects.toBeInstanceOf(ArgumentError);
    await expect(command.func({}, { output: 42 })).rejects.toBeInstanceOf(ArgumentError);
    expect(mocks.collectGrowth).not.toHaveBeenCalled();
  });

  it('raises a typed empty result when no growth rows are returned', async () => {
    mocks.collectGrowth.mockResolvedValue([]);
    const command = getRegistry().get('weixin/user-growth');
    await expect(command.func({}, {})).rejects.toBeInstanceOf(EmptyResultError);
  });
});
