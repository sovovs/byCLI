import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';

for (const name of ['published-articles', 'article-fetch']) getRegistry().delete(`weixin/${name}`);
await import('./published-articles.js');
const articleModule = await import('./article-fetch.js');
const { freepublishListCommand } = await import('./freepublish-list.js');

const published = getRegistry().get('weixin/published-articles');
const article = getRegistry().get('weixin/article-fetch');

describe('freepublish facade commands', () => {
  afterEach(() => vi.restoreAllMocks());

  afterAll(() => {
    getRegistry().delete('weixin/published-articles');
    getRegistry().delete('weixin/article-fetch');
  });

  it('registers conditional-browser auto facades', () => {
    expect(published).toMatchObject({ name: 'published-articles', access: 'read', browser: 'conditional' });
    expect(article).toMatchObject({ name: 'article-fetch', access: 'read', browser: 'conditional' });
    expect(published.args.find(arg => arg.name === 'source')).toMatchObject({ default: 'auto', choices: ['auto', 'api', 'browser'] });
  });

  it('does not require a browser for explicit API mode', () => {
    expect(published.requiresBrowser({ source: 'api' })).toBe(false);
    expect(article.requiresBrowser({ source: 'api' })).toBe(false);
  });

  it('loads the existing download command lazily for browser fallback', async () => {
    getRegistry().set('weixin/download', { site: 'weixin', name: 'download' });
    const command = await articleModule.loadBrowserDownloadCommand();
    expect(command).toMatchObject({ site: 'weixin', name: 'download' });
    expect(command.func).toBeTypeOf('function');
  });

  it('paginates official API listings instead of silently clamping limit to 20', async () => {
    const calls = [];
    vi.spyOn(freepublishListCommand, 'func').mockImplementation(async args => {
      calls.push({ offset: args.offset, count: args.count });
      return Array.from({ length: args.count }, (_, index) => ({
        article_id: `article-${args.offset + index}`,
        title: `Title ${args.offset + index}`,
        author: null,
        digest: null,
        updated_at: 0,
        published_url: null,
        content_html: null,
        artifact_paths_json: null,
        thumb_media_id: null,
        image_info_json: null,
      }));
    });

    const rows = await published.func(null, {
      source: 'api',
      limit: 25,
      appid: 'test-appid',
      appsecret: 'test-appsecret',
    });

    expect(calls).toEqual([{ offset: 0, count: 20 }, { offset: 20, count: 5 }]);
    expect(rows).toHaveLength(25);
    expect(rows.at(-1)).toMatchObject({ article_id: 'article-24', source: 'official-api' });
  });
});
