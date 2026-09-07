import { describe, expect, it, vi } from 'vitest';
import { __test__ } from './download.js';

describe('ima download command', () => {
  it('downloads a matched file from a signed viewer URL', async () => {
    const output = `/tmp/ima-download-${Date.now()}.pdf`;
    const read = vi.fn(async () => ({ items: [{ title: 'a.pdf', contentType: 'PDF', mediaId: 'm1' }] }));
    const http = vi.fn(async (_url, dest) => { await import('node:fs/promises').then(({ writeFile }) => writeFile(dest, '%PDF-1.4\n/Type /Page\n')); return { success: true }; });
    const result = await __test__.runDownloadCommand({ getCurrentUrl: vi.fn(async () => 'chrome-extension://x?originUrl=https%3A%2F%2Fres-skb.ima.qq.com%2Fa.pdf%3Fx%3D1') }, { knowledgeBase: 'kb', file: 'a.pdf', output }, { read, httpDownload: http });
    expect(result[0]).toMatchObject({ title: 'a.pdf', contentType: 'PDF', pages: 1 });
  });
});
