import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const { __test__ } = await import('./search.js');
const command = __test__.command;

function pageFromHtml(html) {
  const dom = new JSDOM(html);
  return { goto: vi.fn().mockResolvedValue(undefined), wait: vi.fn().mockResolvedValue(undefined), evaluate: vi.fn(async (source) => Function('document', `return ${source};`)(dom.window.document)) };
}

describe('gitlab search', () => {
  it('registers scope and ordering options', () => {
    expect(command).toMatchObject({ site: 'gitlab', name: 'search', access: 'read', strategy: 'public', browser: true });
    expect(command.args.map((arg) => arg.name)).toEqual(expect.arrayContaining(['keyword', 'limit', 'page', 'scope', 'order-by', 'sort']));
  });

  it('builds a GitLab search URL with native filters', () => {
    const url = new URL(__test__.buildSearchUrl({ keyword: 'runner', limit: 10, page: 2, scope: 'issues', orderBy: 'updated_at', sort: 'desc' }));
    expect(url.hostname).toBe('gitlab.com');
    expect(url.searchParams.get('search')).toBe('runner');
    expect(url.searchParams.get('scope')).toBe('issues');
    expect(url.searchParams.get('page')).toBe('2');
  });

  it('normalizes public issue results', async () => {
    const page = pageFromHtml(`<div class="search-result-row"><a class="gl-link" href="https://gitlab.com/acme/app/-/issues/1">Fix runner</a><div class="description">Fixes CI</div><span class="author">alice</span><time datetime="2026-08-20T10:00:00Z"></time></div>`);
    await expect(command.func(page, { keyword: 'runner', scope: 'issues', limit: 10 })).resolves.toEqual([expect.objectContaining({ rank: 1, title: 'Fix runner', resultType: 'issue', author: 'alice', url: 'https://gitlab.com/acme/app/-/issues/1' })]);
  });
});
