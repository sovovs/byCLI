import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const { __test__ } = await import('./search.js');
const command = __test__.command;

function pageFromHtml(html) {
  const dom = new JSDOM(html);
  return { goto: vi.fn().mockResolvedValue(undefined), wait: vi.fn().mockResolvedValue(undefined), evaluate: vi.fn(async (source) => Function('document', `return ${source};`)(dom.window.document)) };
}

describe('csdn search', () => {
  it('registers content type and sort filters', () => {
    expect(command).toMatchObject({ site: 'csdn', name: 'search', access: 'read', strategy: 'public', browser: true });
    expect(command.args.map((arg) => arg.name)).toEqual(expect.arrayContaining(['keyword', 'limit', 'page', 'content-type', 'sort', 'time']));
  });

  it('builds a CSDN search URL', () => {
    const url = new URL(__test__.buildSearchUrl({ keyword: 'node cli', limit: 10, page: 2, contentType: 'blog', sort: 'latest', time: 'week' }));
    expect(url.hostname).toBe('so.csdn.net');
    expect(url.searchParams.get('q')).toBe('node cli');
    expect(url.searchParams.get('p')).toBe('2');
    expect(url.searchParams.get('t')).toBe('blog');
  });

  it('normalizes public article results', async () => {
    const page = pageFromHtml(`<div class="search-result-info"><h3><a href="https://blog.csdn.net/alice/article/details/1">Node CLI</a></h3><p class="search-result-desc">A CLI article</p><span class="author">alice</span><time datetime="2026-08-20T10:00:00Z"></time></div>`);
    await expect(command.func(page, { keyword: 'node cli', limit: 10 })).resolves.toEqual([expect.objectContaining({ rank: 1, title: 'Node CLI', author: 'alice', url: 'https://blog.csdn.net/alice/article/details/1', resultType: 'article' })]);
  });
});
