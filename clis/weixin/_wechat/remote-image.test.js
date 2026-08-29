import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { downloadRemoteImage } from './remote-image.js';

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF_BYTES = new TextEncoder().encode('GIF89a');
const WEBP_BYTES = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50,
]);

function imageResponse(bytes = PNG_BYTES, headers = {}) {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'image/png', ...headers },
  });
}

describe('Weixin remote draft images', () => {
  it('downloads and cleans up a public HTTP image', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(imageResponse());
    const lookupImpl = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    const downloaded = await downloadRemoteImage('http://images.example/photo.png', {
      fetchImpl,
      lookupImpl,
    });

    expect(downloaded).toMatchObject({
      extension: '.png',
      size: PNG_BYTES.byteLength,
      resolvedUrl: 'http://images.example/photo.png',
    });
    expect(new Uint8Array(await readFile(downloaded.path))).toEqual(PNG_BYTES);
    await downloaded.cleanup();
    await expect(access(downloaded.path)).rejects.toThrow();
  });

  it('blocks private hosts by default before fetching', async () => {
    const fetchImpl = vi.fn();

    await expect(downloadRemoteImage('http://127.0.0.1/photo.png', {
      fetchImpl,
    })).rejects.toThrow('Private remote image hosts require --allow-private-image-hosts true');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows private hosts only with explicit opt-in', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(imageResponse());

    const downloaded = await downloadRemoteImage('http://127.0.0.1/photo.png', {
      allowPrivateHosts: true,
      fetchImpl,
    });

    expect(downloaded.resolvedUrl).toBe('http://127.0.0.1/photo.png');
    await downloaded.cleanup();
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://100.100.100.200/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://169.254.170.23/v1/credentials',
    'http://[fd00:ec2::23]/v1/credentials',
  ])('always blocks cloud metadata target %s', async (url) => {
    const fetchImpl = vi.fn();

    await expect(downloadRemoteImage(url, {
      allowPrivateHosts: true,
      fetchImpl,
    })).rejects.toThrow('Cloud metadata addresses are not allowed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks a hostname that resolves to a private address by default', async () => {
    const fetchImpl = vi.fn();
    const lookupImpl = vi.fn().mockResolvedValue([{ address: '10.0.0.8', family: 4 }]);

    await expect(downloadRemoteImage('http://images.internal/photo.png', {
      fetchImpl,
      lookupImpl,
    })).rejects.toThrow('Private remote image hosts require --allow-private-image-hosts true');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['http://[::ffff:127.0.0.1]/photo.png', false, '--allow-private-image-hosts true'],
    ['http://[::ffff:169.254.169.254]/latest/meta-data/', true, 'Cloud metadata addresses are not allowed'],
  ])('blocks canonical IPv4-mapped IPv6 target %s', async (url, allowPrivateHosts, message) => {
    const fetchImpl = vi.fn();

    await expect(downloadRemoteImage(url, {
      allowPrivateHosts,
      fetchImpl,
    })).rejects.toThrow(message);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    '192.0.1.1',
    '192.2.1.1',
    '192.88.1.1',
  ])('does not overblock adjacent public IPv4 address %s', async (address) => {
    const downloaded = await downloadRemoteImage(`http://${address}/photo.png`, {
      fetchImpl: vi.fn().mockResolvedValue(imageResponse()),
    });
    expect(downloaded.size).toBe(PNG_BYTES.length);
    await downloaded.cleanup();
  });

  it.each([
    '2001:db8::1',
    '2001:2::1',
    '2001:5::1',
    '100:0:0:1::1',
    '3fff::1',
    'fec0::1',
  ])('blocks non-global IPv6 address %s by default', async (address) => {
    const fetchImpl = vi.fn();

    await expect(downloadRemoteImage(`http://[${address}]/photo.png`, {
      fetchImpl,
    })).rejects.toThrow('--allow-private-image-hosts true');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    '2001:1::1',
    '2001:3::1',
    '2001:4:112::1',
    '2001:20::1',
    '2001:30::1',
  ])('allows the globally reachable IPv6 exception %s', async (address) => {
    const downloaded = await downloadRemoteImage(`http://[${address}]/photo.png`, {
      fetchImpl: vi.fn().mockResolvedValue(imageResponse()),
    });
    expect(downloaded.size).toBe(PNG_BYTES.length);
    await downloaded.cleanup();
  });

  it('pins the validated DNS address in the actual HTTP connection', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(PNG_BYTES);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const downloaded = await downloadRemoteImage(`http://rebinding.invalid:${port}/photo.png`, {
        allowPrivateHosts: true,
        lookupImpl: vi.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]),
      });
      expect(downloaded.size).toBe(PNG_BYTES.length);
      await downloaded.cleanup();
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('revalidates redirects before following them', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    }));
    const lookupImpl = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    await expect(downloadRemoteImage('https://images.example/redirect', {
      allowPrivateHosts: true,
      fetchImpl,
      lookupImpl,
    })).rejects.toThrow('Cloud metadata addresses are not allowed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['image/jpeg', JPEG_BYTES, '.jpg'],
    ['image/png', PNG_BYTES, '.png'],
    ['image/gif', GIF_BYTES, '.gif'],
    ['image/webp', WEBP_BYTES, '.webp'],
  ])('validates %s using its file signature', async (contentType, bytes, extension) => {
    const downloaded = await downloadRemoteImage(`https://images.example/photo${extension}`, {
      fetchImpl: vi.fn().mockResolvedValue(imageResponse(bytes, { 'content-type': contentType })),
      lookupImpl: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
    });

    expect(downloaded.extension).toBe(extension);
    await downloaded.cleanup();
  });

  it('rejects an oversized content-length before reading the body', async () => {
    const arrayBuffer = vi.fn();
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'image/png',
        'content-length': '101',
      }),
      arrayBuffer,
    };

    await expect(downloadRemoteImage('https://images.example/large.png', {
      fetchImpl: vi.fn().mockResolvedValue(response),
      lookupImpl: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
      maxBytes: 100,
    })).rejects.toThrow('Remote image exceeds 100 bytes');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('streams the response and stops when the actual body exceeds the limit', async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(PNG_BYTES);
        controller.enqueue(new Uint8Array(100));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'image/png' } });
    response.arrayBuffer = vi.fn(() => {
      throw new Error('the downloader must stream the response');
    });

    await expect(downloadRemoteImage('https://images.example/stream.png', {
      fetchImpl: vi.fn().mockResolvedValue(response),
      lookupImpl: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
      maxBytes: 50,
    })).rejects.toThrow('Remote image exceeds 50 bytes');
    expect(response.arrayBuffer).not.toHaveBeenCalled();
  });

  it('aborts a download after the configured timeout', async () => {
    const fetchImpl = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }));

    await expect(downloadRemoteImage('https://images.example/slow.png', {
      fetchImpl,
      lookupImpl: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
      timeoutMs: 5,
    })).rejects.toThrow('Remote image download timed out');
  });

  it('applies the timeout while reading a stalled response body', async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(PNG_BYTES);
      },
    }), { status: 200, headers: { 'content-type': 'image/png' } });
    const download = downloadRemoteImage('https://images.example/stalled.png', {
      fetchImpl: vi.fn().mockResolvedValue(response),
      lookupImpl: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
      timeoutMs: 5,
    });

    await expect(Promise.race([
      download,
      new Promise((_, reject) => setTimeout(() => reject(new Error('test guard expired')), 100)),
    ])).rejects.toThrow('Remote image download timed out');
  });

  it.each([
    '192.0.2.10',
    '198.18.0.1',
    '198.51.100.10',
    '203.0.113.10',
  ])('treats non-public reserved IPv4 address %s as private', async (address) => {
    const fetchImpl = vi.fn();

    await expect(downloadRemoteImage(`http://${address}/photo.png`, {
      fetchImpl,
    })).rejects.toThrow('--allow-private-image-hosts true');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('removes its temporary directory when writing the staged image fails', async () => {
    const rmImpl = vi.fn().mockResolvedValue(undefined);

    await expect(downloadRemoteImage('https://images.example/photo.png', {
      fetchImpl: vi.fn().mockResolvedValue(imageResponse()),
      lookupImpl: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
      mkdtempImpl: vi.fn().mockResolvedValue('/tmp/bycli-write-failure'),
      writeFileImpl: vi.fn().mockRejectedValue(new Error('disk full')),
      rmImpl,
    })).rejects.toThrow('disk full');
    expect(rmImpl).toHaveBeenCalledWith('/tmp/bycli-write-failure', { recursive: true, force: true });
  });
});
