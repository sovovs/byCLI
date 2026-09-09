import { describe, expect, it, vi } from 'vitest';
import { __test__ } from './download.js';

describe('ima download command', () => {
  it('can download with a cookie-only Node HTTP page on Linux', async () => {
    const output = `/tmp/ima-cookie-download-${Date.now()}.pdf`;
    const read = vi.fn(async () => ({ knowledgeBaseId: 'kb-1', items: [{ title: 'a.pdf', contentType: 'PDF', mediaId: 'm1' }] }));
    const http = vi.fn(async (url, dest) => { await import('node:fs/promises').then(({ writeFile }) => writeFile(dest, '%PDF-1.4\n/Type /Page\n')); return { success: true }; });
    const oldCookie = process.env.BYCLI_IMA_COOKIE; process.env.BYCLI_IMA_COOKIE = 'IMA-TOKEN=test';
    const oldFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => ({ status: 200, text: async () => url.includes('get_media') ? JSON.stringify({ action: 1, jump_url_info: { url: 'https://res-skb.ima.qq.com/a.pdf?sign=x' } }) : JSON.stringify({ code: 0, results: [{ type: 1001, knowledge_base_list: [{ id: 'kb-1', basic_info: { name: 'kb' } }] }], knowledge_list: [{ media_type: 1, title: 'a.pdf', media_id: 'm1' }], is_end: true }) }));
    const result = await __test__.runDownloadCommand(null, { knowledgeBase: 'kb', file: 'a.pdf', output }, { httpDownload: http });
    globalThis.fetch = oldFetch; if (oldCookie === undefined) delete process.env.BYCLI_IMA_COOKIE; else process.env.BYCLI_IMA_COOKIE = oldCookie;
    expect(result[0]).toMatchObject({ title: 'a.pdf', pages: 1 });
  });
  it('downloads a matched file from a signed viewer URL', async () => {
    const output = `/tmp/ima-download-${Date.now()}.pdf`;
    const read = vi.fn(async () => ({ items: [{ title: 'a.pdf', contentType: 'PDF', mediaId: 'm1' }] }));
    const http = vi.fn(async (_url, dest) => { await import('node:fs/promises').then(({ writeFile }) => writeFile(dest, '%PDF-1.4\n/Type /Page\n')); return { success: true }; });
    const result = await __test__.runDownloadCommand({ getCurrentUrl: vi.fn(async () => 'chrome-extension://x?originUrl=https%3A%2F%2Fres-skb.ima.qq.com%2Fa.pdf%3Fx%3D1') }, { knowledgeBase: 'kb', file: 'a.pdf', output }, { read, httpDownload: http });
    expect(result[0]).toMatchObject({ title: 'a.pdf', contentType: 'PDF', pages: 1 });
  });

  it('uses Browser Bridge media URL when no viewer URL is available', async () => {
    const output = `/tmp/ima-bridge-download-${Date.now()}.pdf`;
    const read = vi.fn(async () => ({ knowledgeBaseId: 'kb-1', items: [{ title: 'a.pdf', contentType: 'PDF', mediaId: 'm1' }] }));
    const http = vi.fn(async (_url, dest) => {
      await import('node:fs/promises').then(({ writeFile }) => writeFile(dest, '%PDF-1.4\n/Type /Page\n'));
      return { success: true };
    });
    const page = {
      startImaAuthCapture: vi.fn(async () => {}), goto: vi.fn(async () => {}),
      evaluate: vi.fn(async () => true), readImaAuth: vi.fn(async () => ({ authId: 'a1' })),
      requestImaReader: vi.fn(async () => ({})),
      requestImaMedia: vi.fn(async () => ({ action: 1, jump_url_info: { url: 'https://res-skb.ima.qq.com/a.pdf?sign=x' } })),
      releaseImaAuth: vi.fn(async () => {}),
    };
    const result = await __test__.runDownloadCommand(page, { knowledgeBase: 'kb', file: 'a.pdf', output }, { read, httpDownload: http });
    expect(result[0]).toMatchObject({ title: 'a.pdf', pages: 1 });
    expect(page.requestImaMedia).toHaveBeenCalledWith('a1', { knowledge_base_id: 'kb-1', media_id: 'm1', scene: 4 });
  });

  it('extracts originUrl from an Accessibility-discovered IMA viewer URL', async () => {
    const output = `/tmp/ima-ax-download-${Date.now()}.pdf`;
    const origin = 'https://res-skb.ima.qq.com/a.pdf?sign=live';
    const viewer = `chrome-extension://viewer/index.html?originUrl=${encodeURIComponent(origin)}`;
    const read = vi.fn(async () => ({ items: [{ title: 'a.pdf', contentType: 'PDF', mediaId: 'm1', url: viewer }] }));
    const http = vi.fn(async (url, dest) => {
      expect(url).toBe(origin);
      await import('node:fs/promises').then(({ writeFile }) => writeFile(dest, '%PDF-1.4\n/Type /Page\n'));
      return { success: true };
    });
    const result = await __test__.runDownloadCommand({}, { knowledgeBase: 'kb', file: 'a.pdf', output }, { read, httpDownload: http });
    expect(result[0]).toMatchObject({ title: 'a.pdf', pages: 1 });
  });

  it('downloads directly from the currently open IMA viewer', async () => {
    const output = `/tmp/ima-current-viewer-${Date.now()}.pdf`;
    const origin = 'https://res-skb.ima.qq.com/a.pdf?media_id=m1&media_title=a.pdf&sign=live';
    const viewer = `chrome-extension://viewer/index.html?originUrl=${encodeURIComponent(origin)}`;
    const http = vi.fn(async (url, dest) => {
      expect(url).toBe(origin);
      await import('node:fs/promises').then(({ writeFile }) => writeFile(dest, '%PDF-1.4\n/Type /Page\n'));
      return { success: true };
    });
    const result = await __test__.runDownloadCommand({}, { knowledgeBase: 'kb', file: 'a.pdf', output }, {
      read: vi.fn(async () => { throw new Error('Chrome auth unavailable'); }),
      readCurrentViewerUrl: vi.fn(() => viewer), httpDownload: http,
    });
    expect(result[0]).toMatchObject({ title: 'a.pdf', pages: 1 });
  });
});
