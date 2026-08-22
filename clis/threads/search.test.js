import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const { __test__ } = await import('./search.js');
const command = __test__.command;

function pageFromHtml(html) {
  const dom = new JSDOM(html);
  return { goto: vi.fn().mockResolvedValue(undefined), wait: vi.fn().mockResolvedValue(undefined), evaluate: vi.fn(async (source) => Function('document', `return ${source};`)(dom.window.document)) };
}

describe('threads search', () => {
  it('registers author and date filters', () => {
    expect(command).toMatchObject({ site: 'threads', name: 'search', access: 'read', strategy: 'public', browser: true });
    expect(command.args.map((arg) => arg.name)).toEqual(expect.arrayContaining(['keyword', 'limit', 'page', 'author', 'since', 'until']));
  });

  it('builds a Threads search URL', () => {
    const url = new URL(__test__.buildSearchUrl({ keyword: 'open cli', limit: 10, page: 2, author: 'alice', since: '2026-08-01', until: '2026-08-22' }));
    expect(url.hostname).toBe('www.threads.com');
    expect(url.searchParams.get('q')).toBe('open cli');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('author')).toBe('alice');
  });

  it('extracts public Threads posts with author and timestamp', async () => {
    const page = pageFromHtml(`<article data-pressable-container><a href="https://www.threads.com/@alice/post/abc">@alice</a><div class="text">OpenCLI post</div><time datetime="2026-08-20T10:00:00Z"></time></article>`);
    await expect(command.func(page, { keyword: 'opencli', author: 'alice', limit: 10 })).resolves.toEqual([expect.objectContaining({ rank: 1, author: 'alice', publishedAt: '2026-08-20T10:00:00Z', url: 'https://www.threads.com/@alice/post/abc' })]);
  });
});
