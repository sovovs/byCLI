import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  batchGetFreepublish,
  getFreepublishArticle,
  normalizeFreepublishPayload,
  materializeFreepublishRows,
  readOfficialApiCredentials,
} from './api-freepublish.js';

const jsonResponse = payload => ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) });

describe('Weixin official freepublish API', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('resolves explicit credentials before environment credentials', () => {
    vi.stubEnv('WECHAT_APPID', 'env-app');
    vi.stubEnv('WECHAT_APPSECRET', 'env-secret');
    expect(readOfficialApiCredentials({ appid: 'arg-app', appsecret: 'arg-secret' })).toEqual({
      accessToken: null, appid: 'arg-app', appsecret: 'arg-secret', configured: true,
    });
  });

  it('accepts an access token without an app secret', () => {
    vi.stubEnv('WECHAT_ACCESS_TOKEN', 'token-1');
    expect(readOfficialApiCredentials({})).toEqual({
      accessToken: 'token-1', appid: null, appsecret: null, configured: true,
    });
  });

  it('rejects partial API credentials', () => {
    expect(() => readOfficialApiCredentials({ appid: 'only-app' })).toThrowError(expect.objectContaining({ code: 'ARGUMENT' }));
  });

  it('does not mix an explicit appid with an environment appsecret', () => {
    vi.stubEnv('WECHAT_APPSECRET', 'env-secret');
    expect(() => readOfficialApiCredentials({ appid: 'arg-app' })).toThrowError(expect.objectContaining({ code: 'ARGUMENT' }));
  });

  it('redacts token acquisition transport errors', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('request failed for https://api.weixin.qq.com/cgi-bin/token?appid=wx123&secret=do-not-echo'));
    const credentials = readOfficialApiCredentials({ appid: 'wx123', appsecret: 'do-not-echo' }, {});
    const { resolveOfficialApiAccessToken } = await import('./api-freepublish.js');
    const error = await resolveOfficialApiAccessToken(credentials, fetchMock).catch(value => value);
    expect(error.message).not.toContain('do-not-echo');
    expect(error.message).toContain('[REDACTED]');
  });

  it('posts batchget with the official request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ total_count: 0, item_count: 0, item: [] }));
    await batchGetFreepublish({ accessToken: 'token-1', offset: 2, count: 20, noContent: 1, fetchImpl: fetchMock });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.weixin.qq.com/cgi-bin/freepublish/batchget?access_token=token-1',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ offset: 2, count: 20, no_content: 1 }) }),
    );
  });

  it('posts getarticle with an article id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ article_id: 'article-1', news_item: [] }));
    await getFreepublishArticle({ accessToken: 'token-1', articleId: 'article-1', fetchImpl: fetchMock });
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ article_id: 'article-1' }));
  });

  it('flattens ordinary and newspic articles while preserving nested image data', () => {
    const rows = normalizeFreepublishPayload({
      item: [{
        article_id: 'article-1', update_time: 1_788_000_000,
        content: { news_item: [
          { title: 'News', author: 'A', digest: 'D', content: '<p>Body</p>', url: 'https://mp.weixin.qq.com/s/a', thumb_media_id: 'thumb-1' },
          { article_type: 'newspic', title: 'Pictures', content: 'caption', image_info: { image_list: [{ image_media_id: 'image-1' }] } },
        ] },
      }],
    });
    expect(rows).toEqual([
      expect.objectContaining({ article_id: 'article-1', article_index: 0, article_type: 'news', title: 'News', content_html: '<p>Body</p>', image_info_json: null }),
      expect.objectContaining({ article_id: 'article-1', article_index: 1, article_type: 'newspic', title: 'Pictures', image_info_json: '{"image_list":[{"image_media_id":"image-1"}]}' }),
    ]);
  });

  it('writes safe non-overwriting HTML and JSON artifacts', async () => {
    const output = await mkdtemp(join(tmpdir(), 'bycli-freepublish-'));
    const rows = [{
      article_id: 'article/../1', article_index: 0, title: '../Unsafe', content_html: '<p>Body</p>',
      artifact_paths_json: null,
    }];
    try {
      const first = await materializeFreepublishRows(rows, { contentMode: 'file', output });
      const second = await materializeFreepublishRows(rows, { contentMode: 'file', output });
      const firstPaths = JSON.parse(first[0].artifact_paths_json);
      const secondPaths = JSON.parse(second[0].artifact_paths_json);
      expect(firstPaths.html).not.toBe(secondPaths.html);
      expect(await readFile(firstPaths.html, 'utf8')).toBe('<p>Body</p>');
      expect(first[0].content_html).toBeNull();
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});
