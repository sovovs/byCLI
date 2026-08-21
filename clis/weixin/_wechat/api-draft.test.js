import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraftViaApi } from './api-draft.js';

function jsonResponse(body) {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(body) };
}

describe('weixin official API draft creation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gets a token, uploads cover/body images, and creates a draft without publishing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bycli-weixin-api-'));
    const cover = join(directory, 'cover.jpg');
    const bodyImage = join(directory, 'body.png');
    await writeFile(cover, 'cover bytes');
    await writeFile(bodyImage, 'body bytes');

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-1', expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'cover-media' }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'body-media', url: 'https://mmbiz.qpic.cn/body' }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'draft-media' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createDraftViaApi({
      appid: 'wx123',
      appsecret: 'secret-value',
      title: 'Title',
      author: 'Author',
      digest: 'Digest',
      coverImage: cover,
      html: '<p>Before</p><img src="./body.png"><p>After</p>',
      baseDir: directory,
    });

    expect(result).toEqual({ mediaId: 'draft-media' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toContain('/token?grant_type=client_credential&appid=wx123&secret=secret-value');
    expect(fetchMock.mock.calls[1][0]).toContain('/material/add_material?access_token=token-1&type=image');
    expect(fetchMock.mock.calls[2][0]).toContain('/material/add_material?access_token=token-1&type=image');
    expect(fetchMock.mock.calls[3][0]).toContain('/draft/add?access_token=token-1');
    const draftBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(draftBody.articles[0]).toMatchObject({
      title: 'Title', author: 'Author', digest: 'Digest', thumb_media_id: 'cover-media',
    });
    expect(draftBody.articles[0].content).toContain('https://mmbiz.qpic.cn/body');
    expect(draftBody.articles[0].content).toContain('Before');

    await rm(directory, { recursive: true, force: true });
  });

  it('reports API errors without echoing the appsecret', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ errcode: 40164, errmsg: 'invalid ip' })));

    await expect(createDraftViaApi({
      appid: 'wx123', appsecret: 'do-not-echo', title: 'Title', html: '<p>Body</p>', coverImage: '/tmp/cover.jpg',
    })).rejects.toThrow(/40164/);
    await expect(createDraftViaApi({
      appid: 'wx123', appsecret: 'do-not-echo', title: 'Title', html: '<p>Body</p>', coverImage: '/tmp/cover.jpg',
    })).rejects.not.toThrow('do-not-echo');
  });
});
