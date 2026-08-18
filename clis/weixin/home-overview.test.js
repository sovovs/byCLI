import { describe, expect, it, vi } from 'vitest';
import { CommandExecutionError } from '@sovovs/bycli/errors';
import { getRegistry } from '@sovovs/bycli/registry';
import {
  buildHomeUrl,
  normalizeHomeOverview,
} from './_wechat/home-overview.js';
import './home-overview.js';

const RAW = {
  originalCount: 0,
  totalUsers: 1,
  yesterdayReads: 46,
  yesterdayReadsChangePct: 4600,
  yesterdayShares: 1,
  yesterdayNewFollowers: 0,
  statRange: ' 数据统计时间:  8月17日 00:00 - 24:00, 数据对比时间：前日 ',
};

function createPageMock(overrides = {}) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    getCookies: vi.fn().mockResolvedValue([
      { name: 'slave_sid', value: 'abc', domain: '.mp.weixin.qq.com' },
    ]),
    evaluate: vi.fn().mockResolvedValue(RAW),
    ...overrides,
  };
}

function loggedInPage(overrides = {}) {
  const page = createPageMock(overrides);
  const evaluate = page.evaluate;
  page.evaluate = vi.fn(async script => {
    if (typeof script === 'function') {
      return { href: 'https://mp.weixin.qq.com/cgi-bin/home?token=42', hasLoginUi: false };
    }
    return evaluate(script);
  });
  return page;
}

describe('buildHomeUrl', () => {
  it('builds the home dashboard URL with an encoded token', () => {
    expect(buildHomeUrl('179231482')).toBe(
      'https://mp.weixin.qq.com/cgi-bin/home?t=home%2Findex&lang=zh_CN&token=179231482',
    );
  });
});

describe('normalizeHomeOverview', () => {
  it('keeps numeric counters and collapses whitespace in the stat range', () => {
    expect(normalizeHomeOverview(RAW)).toEqual({
      originalCount: 0,
      totalUsers: 1,
      yesterdayReads: 46,
      yesterdayReadsChangePct: 4600,
      yesterdayShares: 1,
      yesterdayNewFollowers: 0,
      statRange: '数据统计时间: 8月17日 00:00 - 24:00, 数据对比时间：前日',
    });
  });

  it('maps missing or non-numeric counters to null', () => {
    const overview = normalizeHomeOverview({
      ...RAW,
      yesterdayReadsChangePct: null,
      yesterdayShares: 'many',
      statRange: '   ',
    });
    expect(overview.yesterdayReadsChangePct).toBeNull();
    expect(overview.yesterdayShares).toBeNull();
    expect(overview.statRange).toBeNull();
  });

  it('rejects an unreadable payload', () => {
    expect(() => normalizeHomeOverview(null)).toThrow(CommandExecutionError);
    expect(() => normalizeHomeOverview('46')).toThrow(CommandExecutionError);
  });

  it('rejects a payload where every counter is missing', () => {
    expect(() => normalizeHomeOverview({ statRange: '数据统计时间' })).toThrow(CommandExecutionError);
  });

  it('accepts a payload where only some counters resolved', () => {
    const overview = normalizeHomeOverview({ yesterdayReads: 46 });
    expect(overview.yesterdayReads).toBe(46);
    expect(overview.totalUsers).toBeNull();
  });
});

describe('weixin home-overview command', () => {
  it('registers with a single-row column contract', () => {
    const command = getRegistry().get('weixin/home-overview');
    expect(command).toBeDefined();
    expect(command.access).toBe('read');
    expect(command.aliases).toEqual(['overview', 'dashboard', 'fans']);
    expect(command.columns).toEqual([
      'original_count',
      'total_users',
      'yesterday_reads',
      'yesterday_reads_change_pct',
      'yesterday_shares',
      'yesterday_new_followers',
      'stat_range',
    ]);
  });

  it('is reachable through each discovery alias', () => {
    const registry = getRegistry();
    const canonical = registry.get('weixin/home-overview');
    for (const alias of ['overview', 'dashboard', 'fans']) {
      expect(registry.get(`weixin/${alias}`)).toBe(canonical);
    }
  });

  it('navigates to the token-scoped home page and returns one snake_case row', async () => {
    const command = getRegistry().get('weixin/home-overview');
    const page = loggedInPage();

    const rows = await command.func(page, { settle: 2 });

    expect(page.goto).toHaveBeenCalledWith(buildHomeUrl('42'));
    expect(page.wait).toHaveBeenCalledWith(2);
    expect(rows).toEqual([{
      original_count: 0,
      total_users: 1,
      yesterday_reads: 46,
      yesterday_reads_change_pct: 4600,
      yesterday_shares: 1,
      yesterday_new_followers: 0,
      stat_range: '数据统计时间: 8月17日 00:00 - 24:00, 数据对比时间：前日',
    }]);
  });

  it('falls back to a 3 second settle when --settle is not positive', async () => {
    const command = getRegistry().get('weixin/home-overview');
    const page = loggedInPage();

    await command.func(page, { settle: 0 });

    expect(page.wait).toHaveBeenCalledWith(3);
  });
});
