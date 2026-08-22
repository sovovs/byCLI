import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const { __test__ } = await import('./search.js');
const command = __test__.command;

function pageFromHtml(html) {
  const dom = new JSDOM(html);
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (source) => Function('document', `return ${source};`)(dom.window.document)),
  };
}

describe('baidu search', () => {
  it('registers a public browser search command with native filters', () => {
    expect(command).toMatchObject({ site: 'baidu', name: 'search', access: 'read', strategy: 'public', browser: true });
    expect(command.args.find((arg) => arg.name === 'keyword')).toMatchObject({ positional: true, required: true });
    expect(command.args.map((arg) => arg.name)).toEqual(expect.arrayContaining(['limit', 'page', 'site', 'filetype', 'platform', 'time']));
    expect(command.columns).toEqual(expect.arrayContaining(['rank', 'title', 'url', 'snippet', 'displayUrl', 'resultType', 'extra']));
  });

  it('builds an encoded Baidu URL', () => {
    const url = new URL(__test__.buildSearchUrl({ keyword: 'open cli', limit: 10, page: 2, site: 'example.com', filetype: 'pdf', platform: 'pc', time: 'week' }));
    expect(url.hostname).toBe('www.baidu.com');
    expect(url.searchParams.get('wd')).toBe('open cli');
    expect(url.searchParams.get('pn')).toBe('10');
    expect(url.searchParams.get('si')).toBe('example.com');
    expect(url.searchParams.get('ft')).toBe('pdf');
  });

  it('extracts organic results and rejects blank queries before navigation', async () => {
    const page = pageFromHtml(`<div class="result c-container">
      <h3><a href="https://example.com/a">OpenCLI</a></h3>
      <div class="c-abstract">A browser CLI</div><div class="c-showurl">example.com/a</div>
    </div>`);
    await expect(command.func(page, { keyword: 'opencli', limit: 5 })).resolves.toEqual([expect.objectContaining({ rank: 1, title: 'OpenCLI', url: 'https://example.com/a', resultType: 'web' })]);
    await expect(command.func(page, { keyword: ' ' })).rejects.toMatchObject({ code: 'ARGUMENT' });
    expect(page.goto).toHaveBeenCalledTimes(1);
  });
});
