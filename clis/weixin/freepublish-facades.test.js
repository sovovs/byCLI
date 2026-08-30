import { afterAll, describe, expect, it } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';

for (const name of ['published-articles', 'article-fetch']) getRegistry().delete(`weixin/${name}`);
await import('./published-articles.js');
const articleModule = await import('./article-fetch.js');

const published = getRegistry().get('weixin/published-articles');
const article = getRegistry().get('weixin/article-fetch');

describe('freepublish facade commands', () => {
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
});
