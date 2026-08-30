import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';

for (const name of ['freepublish-list', 'freepublish-get']) getRegistry().delete(`weixin/${name}`);
await import('./freepublish-list.js');
await import('./freepublish-get.js');

const list = getRegistry().get('weixin/freepublish-list');
const get = getRegistry().get('weixin/freepublish-get');

describe('weixin freepublish commands', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(() => {
    getRegistry().delete('weixin/freepublish-list');
    getRegistry().delete('weixin/freepublish-get');
  });

  it('registers browserless read commands with stable contracts', () => {
    expect(list).toMatchObject({ site: 'weixin', name: 'freepublish-list', access: 'read', browser: false, strategy: 'local' });
    expect(get).toMatchObject({ site: 'weixin', name: 'freepublish-get', access: 'read', browser: false, strategy: 'local' });
    expect(list.args.find(arg => arg.name === 'count')).toMatchObject({ type: 'int', default: 20 });
    expect(get.args.find(arg => arg.name === 'articleId')).toMatchObject({ positional: true, required: true });
  });

  it('lists and normalizes official API articles', async () => {
    vi.stubEnv('WECHAT_ACCESS_TOKEN', 'token-1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: vi.fn().mockResolvedValue({ item: [{ article_id: 'a1', update_time: 1, content: { news_item: [{ title: 'Title', content: '<p>x</p>' }] } }] }),
    }));
    await expect(list.func({ offset: 0, count: 20, content: 'none' })).resolves.toEqual([
      expect.objectContaining({ article_id: 'a1', title: 'Title', content_html: null }),
    ]);
  });

  it('gets one official API article', async () => {
    vi.stubEnv('WECHAT_ACCESS_TOKEN', 'token-1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: vi.fn().mockResolvedValue({ article_id: 'a1', news_item: [{ title: 'Title', content: '<p>x</p>' }] }),
    }));
    await expect(get.func({ articleId: 'a1', content: 'inline' })).resolves.toEqual([
      expect.objectContaining({ article_id: 'a1', content_html: '<p>x</p>' }),
    ]);
  });
});
