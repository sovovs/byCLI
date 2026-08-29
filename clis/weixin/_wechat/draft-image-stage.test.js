import { access } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { stageDraftHtmlImages } from './draft-image-stage.js';

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

describe('Weixin draft image staging', () => {
  it('downloads remote images and resolves local paths before publishing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(PNG_BYTES, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }));
    const staged = await stageDraftHtmlImages(
      '<img src="http://images.example/remote.png"><img src="./local.png">',
      {
        baseDir: '/tmp/article',
        fetchImpl,
        lookupImpl: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
      },
    );

    const sources = [...staged.html.matchAll(/src="([^"]+)"/gu)].map(match => match[1]);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatch(/\/bycli-weixin-image-[^/]+\/image\.png$/u);
    expect(sources[1]).toBe('/tmp/article/local.png');
    await expect(access(sources[0])).resolves.toBeUndefined();
    await staged.cleanup();
    await expect(access(sources[0])).rejects.toThrow();
  });

  it('passes the private-host opt-in to the downloader', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(PNG_BYTES, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }));
    const staged = await stageDraftHtmlImages('<img src="http://127.0.0.1/remote.png">', {
      allowPrivateHosts: true,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await staged.cleanup();
  });

  it('stages images sequentially so a later failure cannot race temporary-file cleanup', async () => {
    let releaseFirst;
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const downloadImpl = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }))
      .mockResolvedValueOnce({ path: '/tmp/second.png', cleanup });

    const staging = stageDraftHtmlImages(
      '<img src="http://images.example/first.png"><img src="http://images.example/second.png">',
      { downloadImpl },
    );
    await vi.waitFor(() => expect(downloadImpl).toHaveBeenCalledTimes(1));

    releaseFirst({ path: '/tmp/first.png', cleanup });
    const staged = await staging;
    expect(downloadImpl).toHaveBeenCalledTimes(2);
    await staged.cleanup();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('cleans earlier temporary files when a later download fails', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const downloadImpl = vi.fn()
      .mockResolvedValueOnce({ path: '/tmp/first.png', cleanup })
      .mockRejectedValueOnce(new Error('second download failed'));

    await expect(stageDraftHtmlImages(
      '<img src="http://images.example/first.png"><img src="http://images.example/second.png">',
      { downloadImpl },
    )).rejects.toThrow('second download failed');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('surfaces a temporary-file cleanup failure', async () => {
    const staged = await stageDraftHtmlImages('<img src="http://images.example/first.png">', {
      downloadImpl: vi.fn().mockResolvedValue({
        path: '/tmp/first.png',
        cleanup: vi.fn().mockRejectedValue(new Error('permission denied')),
      }),
    });

    await expect(staged.cleanup()).rejects.toThrow('permission denied');
  });
});
