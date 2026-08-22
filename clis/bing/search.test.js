import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const { __test__ } = await import('./search.js');
const command = __test__.command;

function pageFromHtml(html) {
  const dom = new JSDOM(html);
  return { goto: vi.fn().mockResolvedValue(undefined), wait: vi.fn().mockResolvedValue(undefined), evaluate: vi.fn(async (source) => Function('document', `return ${source};`)(dom.window.document)) };
}

describe('bing search', () => {
  it('registers native market, freshness, answer, and safe options', () => {
    expect(command).toMatchObject({ site: 'bing', name: 'search', access: 'read', strategy: 'public', browser: true });
    expect(command.args.map((arg) => arg.name)).toEqual(expect.arrayContaining(['keyword', 'limit', 'page', 'freshness', 'market', 'answer', 'safe']));
    expect(command.columns).toEqual(expect.arrayContaining(['rank', 'title', 'url', 'snippet', 'displayUrl', 'resultType', 'extra']));
  });

  it('builds a Bing URL with filters', () => {
    const url = new URL(__test__.buildSearchUrl({ keyword: 'open cli', limit: 20, page: 3, freshness: 'week', market: 'zh-CN', answer: 'news', safe: 'strict' }));
    expect(url.hostname).toBe('www.bing.com');
    expect(url.searchParams.get('q')).toBe('open cli');
    expect(url.searchParams.get('first')).toBe('41');
    expect(url.searchParams.get('freshness')).toBe('week');
    expect(url.searchParams.get('cc')).toBe('CN');
  });

  it('extracts Bing result cards', async () => {
    const page = pageFromHtml(`<li class="b_algo"><h2><a href="https://example.com/a">OpenCLI</a></h2><div class="b_caption"><p>CLI tooling</p></div><cite>example.com/a</cite></li>`);
    await expect(command.func(page, { keyword: 'opencli', limit: 5 })).resolves.toEqual([expect.objectContaining({ rank: 1, title: 'OpenCLI', url: 'https://example.com/a', snippet: 'CLI tooling' })]);
  });
});
