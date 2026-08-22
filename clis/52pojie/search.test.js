import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const { __test__ } = await import('./search.js');
const command = __test__.command;

function pageFromHtml(html) {
  const dom = new JSDOM(html);
  return { goto: vi.fn().mockResolvedValue(undefined), wait: vi.fn().mockResolvedValue(undefined), evaluate: vi.fn(async (source) => Function('document', `return ${source};`)(dom.window.document)) };
}

describe('52pojie search', () => {
  it('registers forum section and sort options', () => {
    expect(command).toMatchObject({ site: '52pojie', name: 'search', access: 'read', strategy: 'public', browser: true });
    expect(command.args.map((arg) => arg.name)).toEqual(expect.arrayContaining(['keyword', 'limit', 'page', 'section', 'sort']));
  });

  it('builds a forum search URL', () => {
    const url = new URL(__test__.buildSearchUrl({ keyword: 'open cli', limit: 10, page: 2, section: 'software', sort: 'latest' }));
    expect(url.hostname).toBe('www.52pojie.cn');
    expect(url.searchParams.get('srchtxt')).toBe('open cli');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('section')).toBe('software');
  });

  it('extracts forum threads and preserves counts in extra', async () => {
    const page = pageFromHtml(`<div class="forum-item"><a class="thread-title" href="https://www.52pojie.cn/thread-1-1-1.html">OpenCLI 教程</a><div class="summary">CLI discussion</div><span class="author">alice</span><time datetime="2026-08-20T10:00:00Z"></time><span class="replies">12</span><span class="views">345</span></div>`);
    await expect(command.func(page, { keyword: 'opencli', limit: 10 })).resolves.toEqual([expect.objectContaining({ rank: 1, title: 'OpenCLI 教程', author: 'alice', resultType: 'thread', extra: expect.objectContaining({ replies: 12, views: 345 }) })]);
  });
});
