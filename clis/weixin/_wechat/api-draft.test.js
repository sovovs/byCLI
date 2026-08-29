import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraftViaApi } from './api-draft.js';

function jsonResponse(body) {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(body) };
}

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

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
    expect(fetchMock.mock.calls[2][0]).toContain('/media/uploadimg?access_token=token-1');
    expect(fetchMock.mock.calls[3][0]).toContain('/draft/add?access_token=token-1');
    const draftBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(draftBody.articles[0]).toMatchObject({
      title: 'Title', author: 'Author', digest: 'Digest', thumb_media_id: 'cover-media',
    });
    expect(draftBody.articles[0].content).toContain('https://mmbiz.qpic.cn/body');
    expect(draftBody.articles[0].content).toContain('Before');

    await rm(directory, { recursive: true, force: true });
  });

  it('downloads a remote HTTP body image and replaces it with the WeChat CDN URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bycli-weixin-api-'));
    const cover = join(directory, 'cover.jpg');
    await writeFile(cover, 'cover bytes');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-1', expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'cover-media' }))
      .mockResolvedValueOnce(jsonResponse({ url: 'https://mmbiz.qpic.cn/remote-body' }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'draft-media' }));
    const imageFetchMock = vi.fn().mockResolvedValue(new Response(PNG_BYTES, {
      headers: { 'content-type': 'image/png', 'content-length': String(PNG_BYTES.length) },
    }));

    const result = await createDraftViaApi({
      appid: 'wx123',
      appsecret: 'secret-value',
      title: 'Title',
      coverImage: cover,
      html: '<p>Body</p><img src="http://example.com/remote.png">',
      baseDir: directory,
      fetchImpl: fetchMock,
      imageFetchImpl: imageFetchMock,
      lookupImpl: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
    });

    expect(result).toEqual({ mediaId: 'draft-media' });
    expect(imageFetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2][0]).toContain('/media/uploadimg?access_token=token-1');
    const draftBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(draftBody.articles[0].content).toContain('https://mmbiz.qpic.cn/remote-body');
    expect(draftBody.articles[0].content).not.toContain('http://example.com/remote.png');

    await rm(directory, { recursive: true, force: true });
  });

  it('rejects private remote images before any API or image request by default', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bycli-weixin-api-'));
    const cover = join(directory, 'cover.jpg');
    await writeFile(cover, 'cover bytes');
    const fetchMock = vi.fn();
    const imageFetchMock = vi.fn();

    await expect(createDraftViaApi({
      appid: 'wx123',
      appsecret: 'secret-value',
      title: 'Title',
      coverImage: cover,
      html: '<p>Body</p><img src="http://127.0.0.1/remote.png">',
      baseDir: directory,
      fetchImpl: fetchMock,
      imageFetchImpl: imageFetchMock,
    })).rejects.toThrow('--allow-private-image-hosts true');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(imageFetchMock).not.toHaveBeenCalled();

    await rm(directory, { recursive: true, force: true });
  });

  it('accepts a private HTTP body image with the explicit opt-in', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bycli-weixin-api-'));
    const cover = join(directory, 'cover.jpg');
    await writeFile(cover, 'cover bytes');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-1', expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'cover-media' }))
      .mockResolvedValueOnce(jsonResponse({ url: 'https://mmbiz.qpic.cn/private-body' }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'draft-media' }));
    const imageFetchMock = vi.fn().mockResolvedValue(new Response(PNG_BYTES, {
      headers: { 'content-type': 'image/png' },
    }));

    await expect(createDraftViaApi({
      appid: 'wx123',
      appsecret: 'secret-value',
      title: 'Title',
      coverImage: cover,
      html: '<img src="http://localhost/remote.png">',
      baseDir: directory,
      fetchImpl: fetchMock,
      imageFetchImpl: imageFetchMock,
      allowPrivateImageHosts: true,
    })).resolves.toEqual({ mediaId: 'draft-media' });
    expect(imageFetchMock).toHaveBeenCalledOnce();

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
