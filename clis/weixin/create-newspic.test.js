import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRegistry } from '@sovovs/bycli/registry';

getRegistry().delete('weixin/create-newspic');
await import('./create-newspic.js');

const command = getRegistry().get('weixin/create-newspic');

describe('weixin create-newspic command', () => {
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => getRegistry().delete('weixin/create-newspic'));

  it('registers an API-only write command with explicit newspic arguments', () => {
    const args = Object.fromEntries(command.args.map(arg => [arg.name, arg]));
    expect(command).toMatchObject({ site: 'weixin', name: 'create-newspic', access: 'write', browser: false });
    expect(command.description).toContain('贴图草稿');
    expect(command.example).toContain('--images');
    expect(args.title.required).toBe(true);
    expect(args.images.required).toBe(true);
    expect(args.appid.required).toBe(true);
    expect(args.appsecret.required).toBe(true);
    expect(args['allow-private-image-hosts']).toMatchObject({ type: 'boolean', default: false });
    expect(args.timeout).toBeUndefined();
  });

  it('parses comma-separated images and returns the draft media id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bycli-create-newspic-'));
    const first = join(directory, 'one.jpg');
    const second = join(directory, 'two.png');
    await writeFile(first, 'one');
    await writeFile(second, 'two');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ access_token: 'token' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ media_id: 'image-1' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ media_id: 'image-2' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ media_id: 'draft-1' }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await command.func({
      title: '标题',
      images: ` ${first}, ${second} `,
      content: '说明',
      appid: 'wx123',
      appsecret: 'secret',
    });

    expect(result).toEqual([{ status: 'newspic draft created', detail: '"标题" (media_id: draft-1, images: 2)' }]);
    await rm(directory, { recursive: true, force: true });
  });

});
