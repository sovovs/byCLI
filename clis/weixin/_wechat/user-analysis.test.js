import { describe, expect, it, vi } from 'vitest';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import {
  buildAttributesUrl,
  buildGrowthUrl,
  collectAttributes,
  collectGrowth,
  normalizeAttributeSnapshot,
  normalizeGrowthPayload,
  parseAttributeDimension,
  parseGrowthSources,
  resolveAttributeDate,
  resolveGrowthRange,
} from './user-analysis.js';

const NOW = new Date('2026-08-29T12:00:00+08:00').getTime();

describe('user analysis arguments', () => {
  it('defaults growth to the 30 inclusive days ending yesterday', () => {
    expect(resolveGrowthRange({}, { now: () => NOW })).toEqual({
      begin: '2026-07-30',
      end: '2026-08-28',
    });
  });

  it('anchors the default begin date to an explicitly requested end date', () => {
    expect(resolveGrowthRange({ end: '2026-06-30' }, { now: () => NOW })).toEqual({
      begin: '2026-06-01',
      end: '2026-06-30',
    });
  });

  it('validates real calendar dates and range order', () => {
    expect(resolveGrowthRange({ begin: '2024-02-29', end: '2024-03-01' })).toEqual({
      begin: '2024-02-29', end: '2024-03-01',
    });
    expect(() => resolveGrowthRange({ begin: '2026-02-29', end: '2026-03-01' }))
      .toThrow(ArgumentError);
    expect(() => resolveGrowthRange({ begin: '2026-08-29', end: '2026-08-28' }))
      .toThrow(ArgumentError);
  });

  it('parses named, numeric, and comma-separated growth sources in order', () => {
    expect(parseGrowthSources('search,30,channels-live')).toEqual([
      { code: 1, name: 'search' },
      { code: 30, name: 'qr' },
      { code: 201, name: 'channels-live' },
    ]);
    expect(parseGrowthSources()).toEqual([{ code: 99999999, name: 'all' }]);
    expect(() => parseGrowthSources('search,nope')).toThrow(ArgumentError);
  });

  it('expands all-sources to the aggregate followed by every channel', () => {
    expect(parseGrowthSources('all')).toEqual([{ code: 99999999, name: 'all' }]);
    expect(parseGrowthSources('all-sources')).toEqual([
      { code: 99999999, name: 'all' },
      { code: 1, name: 'search' },
      { code: 30, name: 'qr' },
      { code: 57, name: 'article' },
      { code: 17, name: 'card' },
      { code: 149, name: 'mini-program' },
      { code: 161, name: 'reprint' },
      { code: 100, name: 'ad' },
      { code: 201, name: 'channels-live' },
      { code: 200, name: 'channels' },
      { code: 0, name: 'other' },
    ]);
  });

  it('validates the attribute date and dimension', () => {
    expect(resolveAttributeDate(undefined, { now: () => NOW })).toBe('2026-08-28');
    expect(parseAttributeDimension()).toBe('all');
    expect(parseAttributeDimension('brand')).toBe('brand');
    expect(() => parseAttributeDimension('city')).toThrow(ArgumentError);
  });
});

describe('user analysis URLs', () => {
  it('builds token-scoped growth and attribute URLs', () => {
    expect(buildGrowthUrl({
      token: 'a b', begin: '2026-08-01', end: '2026-08-28', sourceCodes: [99999999, 1],
    })).toBe('https://mp.weixin.qq.com/misc/useranalysis?begin_date=2026-08-01&end_date=2026-08-28&source=99999999%2C1&token=a+b&lang=zh_CN&f=json&ajax=1');
    expect(buildAttributesUrl({ token: 'a b', date: '2026-08-28' }))
      .toBe('https://mp.weixin.qq.com/misc/useranalysis?action=attr&begin_date=2026-08-28&end_date=2026-08-28&token=a+b&lang=zh_CN');
  });
});

describe('growth payload normalization', () => {
  it('keeps sparse source rows and sorts by date then requested source', () => {
    const payload = {
      base_resp: { ret: 0 },
      category_list: [
        { user_source: 1, list: [{ date: '2026-08-28', new_user: 2, cancel_user: 1, netgain_user: 1, cumulate_user: 10 }] },
        { user_source: 99999999, list: [
          { date: '2026-08-28', new_user: 2, cancel_user: 1, netgain_user: 1, cumulate_user: 10 },
          { date: '2026-08-27', new_user: 0, cancel_user: 0, netgain_user: 0, cumulate_user: 9 },
        ] },
      ],
    };
    expect(normalizeGrowthPayload(payload, [
      { code: 99999999, name: 'all' }, { code: 1, name: 'search' },
    ])).toEqual([
      { date: '2026-08-27', source: 'all', sourceCode: 99999999, newFollowers: 0, unfollows: 0, netNewFollowers: 0, cumulativeFollowers: 9 },
      { date: '2026-08-28', source: 'all', sourceCode: 99999999, newFollowers: 2, unfollows: 1, netNewFollowers: 1, cumulativeFollowers: 10 },
      { date: '2026-08-28', source: 'search', sourceCode: 1, newFollowers: 2, unfollows: 1, netNewFollowers: 1, cumulativeFollowers: 10 },
    ]);
  });

  it('rejects failed and malformed growth responses', () => {
    expect(() => normalizeGrowthPayload({ base_resp: { ret: 1 }, category_list: [] }, []))
      .toThrow(CommandExecutionError);
    expect(() => normalizeGrowthPayload({ base_resp: { ret: 0 }, category_list: [{}] }, []))
      .toThrow(CommandExecutionError);
  });
});

const SNAPSHOT = {
  date: '2026-08-28',
  genders: [{ name: '男', count: 3 }, { name: '女', count: 1 }],
  ages: [{ name: '26岁到35岁', count: 4 }],
  langs: [{ name: '简体中文', count: 4 }],
  platforms: [{ name: 'Android', count: 3 }, { name: '', count: 1 }],
  devices: [{ name: 'Apple', count: 2 }, { name: '0', count: 2 }],
  regions: [
    { count: 3, region: { region_id: '22', parent_region_id: '-1', region_name: '江苏省' } },
    { count: 2, region: { region_id: '2201', parent_region_id: '22', region_name: '南京' } },
  ],
};

describe('attribute snapshot normalization', () => {
  it('flattens every dimension and derives non-region percentages', () => {
    const rows = normalizeAttributeSnapshot(SNAPSHOT, 'all');
    expect(rows).toContainEqual({ date: '2026-08-28', dimension: 'gender', name: '男', code: null, parentCode: null, count: 3, percent: 75 });
    expect(rows).toContainEqual({ date: '2026-08-28', dimension: 'platform', name: '未知', code: null, parentCode: null, count: 1, percent: 25 });
    expect(rows).toContainEqual({ date: '2026-08-28', dimension: 'brand', name: '未知', code: null, parentCode: null, count: 2, percent: 50 });
    expect(rows).toContainEqual({ date: '2026-08-28', dimension: 'region', name: '南京', code: '2201', parentCode: '22', count: 2, percent: null });
  });

  it('filters one dimension and rejects unreadable snapshots', () => {
    expect(normalizeAttributeSnapshot(SNAPSHOT, 'age')).toEqual([
      { date: '2026-08-28', dimension: 'age', name: '26岁到35岁', code: null, parentCode: null, count: 4, percent: 100 },
    ]);
    expect(() => normalizeAttributeSnapshot(null, 'all')).toThrow(CommandExecutionError);
  });
});

describe('browser collectors', () => {
  it('collects growth through authenticated same-origin fetch', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({
        base_resp: { ret: 0 },
        category_list: [{ user_source: 1, list: [{ date: '2026-08-28', new_user: 2, cancel_user: 0, netgain_user: 2, cumulate_user: 12 }] }],
      }),
    };
    const rows = await collectGrowth({ page, token: '42', begin: '2026-08-28', end: '2026-08-28', sources: [{ code: 1, name: 'search' }] });
    expect(page.goto).toHaveBeenCalledWith(expect.stringContaining('/misc/useranalysis?'));
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), expect.stringContaining('source=1'));
    expect(rows).toHaveLength(1);
  });

  it('wraps browser transport failures without exposing the request URL', async () => {
    const page = {
      goto: vi.fn(),
      wait: vi.fn(),
      evaluate: vi.fn().mockRejectedValue(new Error('failed token=secret')),
    };
    const error = await collectGrowth({
      page, token: 'secret', begin: '2026-08-28', end: '2026-08-28',
      sources: [{ code: 1, name: 'search' }],
    }).catch(value => value);
    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(error.message).not.toContain('secret');
  });

  it('collects attributes from window.cgiData and explains an empty snapshot', async () => {
    const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValue(SNAPSHOT) };
    await expect(collectAttributes({ page, token: '42', date: '2026-08-28', dimension: 'gender' }))
      .resolves.toEqual([
        expect.objectContaining({ dimension: 'gender', name: '男', count: 3 }),
        expect.objectContaining({ dimension: 'gender', name: '女', count: 1 }),
      ]);
    page.evaluate.mockResolvedValueOnce(null);
    await expect(collectAttributes({ page, token: '42', date: '2026-08-28', dimension: 'all' }))
      .rejects.toBeInstanceOf(EmptyResultError);
  });
});
