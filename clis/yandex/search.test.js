import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const { __test__ } = await import('./search.js');
const command = __test__.command;

function pageFromHtml(html) {
  const dom = new JSDOM(html);
  return { goto: vi.fn().mockResolvedValue(undefined), wait: vi.fn().mockResolvedValue(undefined), evaluate: vi.fn(async (source) => Function('document', `return ${source};`)(dom.window.document)) };
}

describe('yandex search', () => {
  it('registers region, language, sort, page, and limit options', () => {
    expect(command).toMatchObject({ site: 'yandex', name: 'search', access: 'read', strategy: 'public', browser: true });
    expect(command.args.map((arg) => arg.name)).toEqual(expect.arrayContaining(['keyword', 'limit', 'page', 'lr', 'lang', 'sort']));
  });

  it('builds a Yandex URL with encoded options', () => {
    const url = new URL(__test__.buildSearchUrl({ keyword: 'open cli', limit: 10, page: 2, lr: '213', lang: 'en', sort: 'date' }));
    expect(url.hostname).toBe('yandex.com');
    expect(url.searchParams.get('text')).toBe('open cli');
    expect(url.searchParams.get('p')).toBe('1');
    expect(url.searchParams.get('lr')).toBe('213');
    expect(url.searchParams.get('how')).toBe('tm');
  });

  it('extracts organic Yandex results', async () => {
    const page = pageFromHtml(`<li class="serp-item"><h2><a href="https://example.com/a"><span class="OrganicTitleContentSpan">OpenCLI</span></a></h2><div class="OrganicText">CLI tooling</div><div class="Path">example.com/a</div></li>`);
    await expect(command.func(page, { keyword: 'opencli', limit: 5 })).resolves.toEqual([expect.objectContaining({ rank: 1, title: 'OpenCLI', url: 'https://example.com/a' })]);
  });
});
