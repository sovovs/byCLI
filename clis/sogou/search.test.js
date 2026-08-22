import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const { __test__ } = await import('./search.js');
const command = __test__.command;

function pageFromHtml(html) {
  const dom = new JSDOM(html);
  return { goto: vi.fn().mockResolvedValue(undefined), wait: vi.fn().mockResolvedValue(undefined), evaluate: vi.fn(async (source) => Function('document', `return ${source};`)(dom.window.document)) };
}

describe('sogou search', () => {
  it('registers type, time, sort, page, and limit options', () => {
    expect(command).toMatchObject({ site: 'sogou', name: 'search', access: 'read', strategy: 'public', browser: true });
    expect(command.args.map((arg) => arg.name)).toEqual(expect.arrayContaining(['keyword', 'limit', 'page', 'type', 'time', 'sort']));
  });

  it('builds a Sogou URL with native filters', () => {
    const url = new URL(__test__.buildSearchUrl({ keyword: 'open cli', limit: 10, page: 2, type: 'news', time: 'week', sort: 'date' }));
    expect(url.hostname).toBe('sogou.com');
    expect(url.searchParams.get('query')).toBe('open cli');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('type')).toBe('news');
  });

  it('extracts Sogou result cards', async () => {
    const page = pageFromHtml(`<div class="vrwrap"><h3><a href="https://example.com/a">OpenCLI</a></h3><p class="str_info">CLI tooling</p><cite>example.com/a</cite></div>`);
    await expect(command.func(page, { keyword: 'opencli', limit: 5 })).resolves.toEqual([expect.objectContaining({ rank: 1, title: 'OpenCLI', url: 'https://example.com/a' })]);
  });
});
