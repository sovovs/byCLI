import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { getRegistry } from '@sovovs/bycli/registry';
import './search.js';

function makePage(payload) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(payload),
  };
}

describe('weixin sougousearch adapter', () => {
  it('is included in the compiled manifest as a public Sogou article search command', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../cli-manifest.json', import.meta.url), 'utf8'));
    const command = manifest.find(entry => entry.site === 'weixin' && entry.name === 'sougousearch');

    expect(command).toMatchObject({
      site: 'weixin',
      name: 'sougousearch',
      domain: 'weixin.sogou.com',
      strategy: 'public',
      browser: true,
      columns: ['rank', 'page', 'title', 'account', 'url', 'summary', 'publish_time'],
    });
  });

  it('builds the Sogou article search URL and returns ranked rows', async () => {
    const command = getRegistry().get('weixin/sougousearch');
    const page = makePage({
      blocked: false,
      empty: false,
      invalidCount: 0,
      rows: [
        { title: 'First result', account: 'Test Account', url: 'https://mp.weixin.qq.com/s/first', summary: 'Summary', publish_time: '1小时前' },
        { title: 'Second result', url: 'https://mp.weixin.qq.com/s/second', summary: '', publish_time: '昨天' },
      ],
    });

    const rows = await command.func(page, { query: 'AI 搜索', page: 2, limit: 1 });

    expect(page.goto).toHaveBeenCalledWith('https://weixin.sogou.com/weixin?query=AI+%E6%90%9C%E7%B4%A2&type=2&page=2&ie=utf8');
    expect(page.wait).toHaveBeenCalledWith(2);
    expect(rows).toEqual([
      { rank: 11, page: 2, title: 'First result', account: 'Test Account', url: 'https://mp.weixin.qq.com/s/first', summary: 'Summary', publish_time: '1小时前' },
    ]);
  });

  it('rejects empty queries before browser navigation', async () => {
    const command = getRegistry().get('weixin/sougousearch');
    const page = makePage({});

    await expect(command.func(page, { query: '  ' })).rejects.toMatchObject({ name: 'ArgumentError', code: 'ARGUMENT' });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('reports Sogou verification and an explicit empty result', async () => {
    const command = getRegistry().get('weixin/sougousearch');
    const blockedPage = makePage({ blocked: true, empty: false, invalidCount: 0, rows: [] });
    const emptyPage = makePage({ blocked: false, empty: true, invalidCount: 0, rows: [] });

    await expect(command.func(blockedPage, { query: 'AI' })).rejects.toMatchObject({ name: 'CommandExecutionError' });
    await expect(command.func(emptyPage, { query: 'AI' })).rejects.toMatchObject({ name: 'EmptyResultError' });
  });
});
