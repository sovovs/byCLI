import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmptyResultError } from '@sovovs/bycli/errors';
import { getRegistry } from '@sovovs/bycli/registry';

const mocks = vi.hoisted(() => ({
  resolveBrowserCredentials: vi.fn(),
  resolveAttributeDate: vi.fn(),
  parseAttributeDimension: vi.fn(),
  collectAttributes: vi.fn(),
}));

vi.mock('./_wechat/auth-session.js', () => ({
  resolveBrowserCredentials: mocks.resolveBrowserCredentials,
}));
vi.mock('./_wechat/user-analysis.js', () => ({
  resolveAttributeDate: mocks.resolveAttributeDate,
  parseAttributeDimension: mocks.parseAttributeDimension,
  collectAttributes: mocks.collectAttributes,
}));

await import('./user-attributes.js');

describe('weixin user-attributes command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveBrowserCredentials.mockResolvedValue({ token: '42', cookie: 'sid=x' });
    mocks.resolveAttributeDate.mockReturnValue('2026-08-28');
    mocks.parseAttributeDimension.mockReturnValue('region');
    mocks.collectAttributes.mockResolvedValue([{
      date: '2026-08-28', dimension: 'region', name: '南京', code: '2201',
      parentCode: '22', count: 2, percent: null,
    }]);
  });

  it('registers the stable read-only contract', () => {
    const command = getRegistry().get('weixin/user-attributes');
    expect(command).toMatchObject({ access: 'read', strategy: 'cookie', browser: true, navigateBefore: false });
    expect(command.args.map(arg => arg.name)).toEqual(['date', 'dimension']);
    expect(command.columns).toEqual([
      'date', 'dimension', 'name', 'code', 'parent_code', 'count', 'percent',
    ]);
  });

  it('reuses browser credentials and preserves raw region hierarchy', async () => {
    const command = getRegistry().get('weixin/user-attributes');
    const page = {};
    await expect(command.func(page, { date: '2026-08-28', dimension: 'region' }))
      .resolves.toEqual([{
        date: '2026-08-28', dimension: 'region', name: '南京', code: '2201',
        parent_code: '22', count: 2, percent: null,
      }]);
    expect(mocks.collectAttributes).toHaveBeenCalledWith({
      page, token: '42', date: '2026-08-28', dimension: 'region',
    });
  });

  it('raises a typed empty result when a selected dimension has no rows', async () => {
    mocks.collectAttributes.mockResolvedValue([]);
    const command = getRegistry().get('weixin/user-attributes');
    await expect(command.func({}, {})).rejects.toBeInstanceOf(EmptyResultError);
  });
});
