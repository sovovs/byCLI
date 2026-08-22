import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const { __test__ } = await import('./search.js');
const command = __test__.command;

function pageFromHtml(html) {
  const dom = new JSDOM(html);
  return { goto: vi.fn().mockResolvedValue(undefined), wait: vi.fn().mockResolvedValue(undefined), evaluate: vi.fn(async (source) => Function('document', `return ${source};`)(dom.window.document)) };
}

describe('360 search', () => {
  it('registers the so site and validates type and safe options', () => {
    expect(command).toMatchObject({ site: 'so', name: 'search', access: 'read', strategy: 'public', browser: true });
    expect(command.args.map((arg) => arg.name)).toEqual(expect.arrayContaining(['keyword', 'limit', 'page', 'type', 'safe']));
  });

  it('builds a 360 search URL', () => {
    const url = new URL(__test__.buildSearchUrl({ keyword: 'open cli', limit: 10, page: 2, type: 'news', safe: 'on' }));
    expect(url.hostname).toBe('so.com');
    expect(url.searchParams.get('q')).toBe('open cli');
    expect(url.searchParams.get('pn')).toBe('2');
    expect(url.searchParams.get('type')).toBe('news');
  });

  it('extracts organic results and skips sponsored cards', async () => {
    const page = pageFromHtml(`<div class="result result-ad"><h3><a href="https://ads.example/">Ad</a></h3></div><div class="result"><h3><a href="https://example.com/a">OpenCLI</a></h3><p class="res-desc">CLI tooling</p><cite>example.com/a</cite></div>`);
    await expect(command.func(page, { keyword: 'opencli', limit: 5 })).resolves.toEqual([expect.objectContaining({ rank: 1, title: 'OpenCLI', url: 'https://example.com/a' })]);
  });
});
