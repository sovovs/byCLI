import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNewspicDraftViaApi, stageNewspicImages } from './api-newspic.js';

function jsonResponse(body) {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(body) };
}

describe('weixin official API newspic draft creation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uploads images in order and creates a newspic draft without publishing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bycli-weixin-newspic-'));
    const first = join(directory, 'first.jpg');
    const second = join(directory, 'second.png');
    await writeFile(first, 'first image');
    await writeFile(second, 'second image');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-1' }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'image-1' }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'image-2' }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'draft-1' }));

    const result = await createNewspicDraftViaApi({
      appid: 'wx123',
      appsecret: 'secret-value',
      title: '相册标题',
      content: '相册说明',
      images: [first, second],
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ mediaId: 'draft-1', imageMediaIds: ['image-1', 'image-2'] });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toContain('/token?grant_type=client_credential&appid=wx123&secret=secret-value');
    expect(fetchMock.mock.calls[1][0]).toContain('/material/add_material?access_token=token-1&type=image');
    expect(fetchMock.mock.calls[2][0]).toContain('/material/add_material?access_token=token-1&type=image');
    expect(fetchMock.mock.calls[3][0]).toContain('/draft/add?access_token=token-1');
    const body = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(body).toEqual({
      articles: [{
        article_type: 'newspic',
        title: '相册标题',
        content: '相册说明',
        need_open_comment: 0,
        only_fans_can_comment: 0,
        image_info: {
          image_list: [
            { image_media_id: 'image-1' },
            { image_media_id: 'image-2' },
          ],
        },
      }],
    });
    expect(fetchMock.mock.calls.flatMap((call) => [String(call[0])]).join('\n')).not.toContain('freepublish');

    await rm(directory, { recursive: true, force: true });
  });

  it('downloads a remote HTTP image before uploading it as permanent material', async () => {
    const imageFetchMock = vi.fn().mockResolvedValue(new Response(Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]), { headers: { 'content-type': 'image/png' } }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-1' }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'image-1' }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'draft-1' }));

    await expect(createNewspicDraftViaApi({
      appid: 'wx123',
      appsecret: 'secret-value',
      title: '远程图片',
      images: ['http://images.example/photo.png'],
      fetchImpl: fetchMock,
      imageFetchImpl: imageFetchMock,
      lookupImpl: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
    })).resolves.toMatchObject({ mediaId: 'draft-1' });
    expect(imageFetchMock).toHaveBeenCalledOnce();
  });

  it('requires explicit opt-in for private remote images and forwards the opt-in', async () => {
    const fetchMock = vi.fn();
    const imageFetchMock = vi.fn();
    await expect(createNewspicDraftViaApi({
      appid: 'wx123',
      appsecret: 'secret-value',
      title: '内网图片',
      images: ['http://127.0.0.1/photo.png'],
      fetchImpl: fetchMock,
      imageFetchImpl: imageFetchMock,
    })).rejects.toThrow('--allow-private-image-hosts true');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(imageFetchMock).not.toHaveBeenCalled();

    const downloadImpl = vi.fn().mockResolvedValue({ path: '/tmp/download.png', cleanup: vi.fn() });
    const staged = await stageNewspicImages(['http://localhost/photo.png'], {
      allowPrivateHosts: true,
      downloadImpl,
    });
    expect(downloadImpl).toHaveBeenCalledWith('http://localhost/photo.png', expect.objectContaining({ allowPrivateHosts: true }));
    await staged.cleanup();
  });

  it('rejects image counts outside 1-20 before making requests', async () => {
    const fetchMock = vi.fn();
    await expect(createNewspicDraftViaApi({
      appid: 'wx123', appsecret: 'secret-value', title: 'empty', images: [], fetchImpl: fetchMock,
    })).rejects.toThrow('1–20');
    await expect(createNewspicDraftViaApi({
      appid: 'wx123', appsecret: 'secret-value', title: 'many', images: Array(21).fill('/tmp/a.jpg'), fetchImpl: fetchMock,
    })).rejects.toThrow('1–20');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty local image before contacting Weixin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bycli-weixin-newspic-'));
    const image = join(directory, 'empty.png');
    await writeFile(image, '');
    const fetchMock = vi.fn();

    await expect(createNewspicDraftViaApi({
      appid: 'wx123', appsecret: 'secret-value', title: 'empty', images: [image], fetchImpl: fetchMock,
    })).rejects.toThrow('readable non-empty file');
    expect(fetchMock).not.toHaveBeenCalled();

    await rm(directory, { recursive: true, force: true });
  });

  it('removes uploaded permanent materials when draft creation fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bycli-weixin-newspic-'));
    const image = join(directory, 'image.jpg');
    await writeFile(image, 'image');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-1' }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'image-1' }))
      .mockResolvedValueOnce(jsonResponse({ errcode: 40007, errmsg: 'invalid media_id' }))
      .mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: 'ok' }));

    await expect(createNewspicDraftViaApi({
      appid: 'wx123', appsecret: 'secret-value', title: '失败测试', images: [image], fetchImpl: fetchMock,
    })).rejects.toThrow('invalid media_id');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][0]).toContain('/material/del_material?access_token=token-1');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ media_id: 'image-1' });

    await rm(directory, { recursive: true, force: true });
  });

  it('removes earlier materials when a later image upload fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bycli-weixin-newspic-'));
    const first = join(directory, 'first.jpg');
    const second = join(directory, 'second.jpg');
    await writeFile(first, 'first');
    await writeFile(second, 'second');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-1' }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'image-1' }))
      .mockResolvedValueOnce(jsonResponse({ errcode: 40005, errmsg: 'invalid file type' }))
      .mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: 'ok' }));

    await expect(createNewspicDraftViaApi({
      appid: 'wx123', appsecret: 'secret-value', title: '失败测试', images: [first, second], fetchImpl: fetchMock,
    })).rejects.toThrow('invalid file type');
    expect(fetchMock.mock.calls[3][0]).toContain('/material/del_material');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ media_id: 'image-1' });

    await rm(directory, { recursive: true, force: true });
  });

  it('reports permanent material ids when failure cleanup is incomplete', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bycli-weixin-newspic-'));
    const image = join(directory, 'image.jpg');
    await writeFile(image, 'image');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-1' }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'image-1' }))
      .mockResolvedValueOnce(jsonResponse({ errcode: 40007, errmsg: 'invalid media_id' }))
      .mockResolvedValueOnce(jsonResponse({ errcode: 45009, errmsg: 'rate limit' }));

    await expect(createNewspicDraftViaApi({
      appid: 'wx123', appsecret: 'secret-value', title: '失败测试', images: [image], fetchImpl: fetchMock,
    })).rejects.toThrow('cleanup incomplete: failed to delete permanent materials: image-1');

    await rm(directory, { recursive: true, force: true });
  });

  it('returns a created draft with a warning when temporary cleanup fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bycli-weixin-newspic-'));
    const image = join(directory, 'image.png');
    await writeFile(image, 'image');
    const cleanup = vi.fn().mockRejectedValue(new Error('temporary cleanup denied'));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-1' }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'image-1' }))
      .mockResolvedValueOnce(jsonResponse({ media_id: 'draft-1' }));

    const result = await createNewspicDraftViaApi({
      appid: 'wx123',
      appsecret: 'secret-value',
      title: '成功草稿',
      images: ['https://images.example/image.png'],
      fetchImpl: fetchMock,
      downloadImpl: vi.fn().mockResolvedValue({ path: image, cleanup }),
    });

    expect(result).toEqual({
      mediaId: 'draft-1',
      imageMediaIds: ['image-1'],
      cleanupWarning: 'Failed to clean up a temporary Weixin image: temporary cleanup denied',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await rm(directory, { recursive: true, force: true });
  });
});
