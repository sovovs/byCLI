import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { readKnowledgeBaseFromChrome, readKnowledgeBasesFromChrome, readImaMediaUrl } from './native-client.js';

function readerResponse(path) {
    if (path === '/get_knowledge_base_list') {
        return {
            code: 0,
            results: [{
                type: 1001,
                knowledge_base_list: [{ id: 'kb-1', basic_info: { name: '工程' } }],
                is_end: true,
            }],
        };
    }
    return {
        code: 0,
        knowledge_list: [{
            media_type: 2,
            title: '文章',
            source_path: 'https://example.com/article',
        }],
        is_end: true,
    };
}

describe('readKnowledgeBaseFromChrome', () => {
    it('reads the signed media URL from get_media', async () => {
        const page = { fetchJson: vi.fn(async () => ({ code: 0, action: 1, jump_url_info: { url: 'https://res-skb.ima.qq.com/a.pdf?sign=x' } })) };
        await expect(readImaMediaUrl(page, { knowledgeBaseId: 'kb-1', mediaId: 'm-1' }))
            .resolves.toBe('https://res-skb.ima.qq.com/a.pdf?sign=x');
        expect(page.fetchJson).toHaveBeenCalledWith(
            'https://ima.qq.com/cgi-bin/file_manager/get_media',
            expect.objectContaining({ method: 'POST', body: { knowledgeBaseId: 'kb-1', mediaId: 'm-1', scene: 4 } }),
        );
    });

    it('reports when get_media has no exportable URL', async () => {
        const page = { fetchJson: vi.fn(async () => ({ code: 0, action: 2, jump_url_info: null, toast_text: '请前往客户端查看内容' })) };
        await expect(readImaMediaUrl(page, { knowledgeBaseId: 'kb-1', mediaId: 'm-1' }))
            .rejects.toMatchObject({ code: 'IMA_ORIGINAL_URL_UNAVAILABLE' });
    });

    it('lists knowledge bases with an opaque Chrome auth ID and releases it', async () => {
        const page = {
            startImaAuthCapture: vi.fn(async () => {}),
            goto: vi.fn(async () => {}),
            evaluate: vi.fn(async () => true),
            readImaAuth: vi.fn(async () => ({ authId: 'opaque-id' })),
            requestImaReader: vi.fn(async (_authId, path) => readerResponse(path)),
            releaseImaAuth: vi.fn(async () => {}),
        };

        await expect(readKnowledgeBasesFromChrome(page)).resolves.toEqual([
            expect.objectContaining({ id: 'kb-1', name: '工程' }),
        ]);
        expect(page.goto).toHaveBeenCalledWith('https://ima.qq.com/wikis');
        expect(page.evaluate).toHaveBeenCalledOnce();
        expect(page.requestImaReader).toHaveBeenCalledWith(
            'opaque-id', '/get_knowledge_base_list', expect.any(Object),
        );
        expect(page.releaseImaAuth).toHaveBeenCalledWith('opaque-id');
    });

    it('uses an opaque Chrome auth ID for reader requests and releases it', async () => {
        const page = {
            startImaAuthCapture: vi.fn(async () => {}),
            goto: vi.fn(async () => {}),
            evaluate: vi.fn(async () => true),
            readImaAuth: vi.fn(async () => ({ authId: 'opaque-id' })),
            requestImaReader: vi.fn(async (_authId, path) => readerResponse(path)),
            releaseImaAuth: vi.fn(async () => {}),
        };

        await expect(readKnowledgeBaseFromChrome(page, '工程')).resolves.toMatchObject({
            ok: true,
            items: [expect.objectContaining({ title: '文章', url: 'https://example.com/article' })],
        });
        expect(page.startImaAuthCapture).toHaveBeenCalledOnce();
        expect(page.goto).toHaveBeenCalledWith('https://ima.qq.com/wikis');
        expect(page.evaluate).toHaveBeenCalledOnce();
        expect(page.requestImaReader).toHaveBeenCalledWith(
            'opaque-id', '/get_knowledge_base_list', expect.any(Object),
        );
        expect(page.releaseImaAuth).toHaveBeenCalledWith('opaque-id');
    });

    it('fails with a Chrome-auth error when no reader request is captured', async () => {
        const page = {
            startImaAuthCapture: vi.fn(async () => {}), goto: vi.fn(async () => {}),
            evaluate: vi.fn(async () => true),
            readImaAuth: vi.fn(async () => null),
        };
        await expect(readKnowledgeBaseFromChrome(page, '工程', { timeoutMs: 0 }))
            .rejects.toMatchObject({ code: 'IMA_CHROME_AUTH_REQUIRED' });
    });

    it('turns an older Browser Bridge into an actionable Chrome-auth error', async () => {
        const page = {
            startImaAuthCapture: vi.fn(async () => { throw new Error('Unknown action: ima-auth-start'); }),
            goto: vi.fn(), evaluate: vi.fn(), readImaAuth: vi.fn(), requestImaReader: vi.fn(),
        };
        await expect(readKnowledgeBaseFromChrome(page, '工程'))
            .rejects.toMatchObject({ code: 'IMA_CHROME_AUTH_REQUIRED' });
    });

    it('does not import Keychain, SQLite, or Chromium cookie decryption code', async () => {
        const source = await readFile(new URL('./native-client.js', import.meta.url), 'utf8');
        expect(source).not.toMatch(/security|sqlite3|decryptChromiumCookieValue/);
    });
});
