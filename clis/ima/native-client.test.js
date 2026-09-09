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
    it('reads knowledge metadata directly on Linux with the configured IMA cookie', async () => {
        const page = {
            fetchJson: vi.fn(async (url) => url.endsWith('/get_knowledge_base_list')
                ? readerResponse('/get_knowledge_base_list') : readerResponse('/get_knowledge_list')),
        };
        await expect(readKnowledgeBaseFromChrome(page, '工程', {
            imaCookie: 'IMA-UID=u1; IMA-TOKEN=token-1; IMA-GUID=g1', extensionVersion: '2.1.23',
        })).resolves.toMatchObject({ ok: true, items: [expect.objectContaining({ title: '文章' })] });
        expect(page.fetchJson).toHaveBeenCalledWith(
            expect.stringContaining('/cgi-bin/knowledge_tab_reader/get_knowledge_base_list'),
            expect.objectContaining({ headers: expect.objectContaining({ 'x-ima-cookie': expect.any(String), from_browser_ima: '1' }) }),
        );
    });

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

    it('uses the client snake_case media request through Browser Bridge', async () => {
        const page = {
            startImaAuthCapture: vi.fn(async () => {}),
            goto: vi.fn(async () => {}),
            evaluate: vi.fn(async () => true),
            readImaAuth: vi.fn(async () => ({ authId: 'opaque-id' })),
            requestImaReader: vi.fn(async () => ({})),
            requestImaMedia: vi.fn(async () => ({ action: 1, jump_url_info: { url: 'https://res-skb.ima.qq.com/a.pdf?sign=x' } })),
            releaseImaAuth: vi.fn(async () => {}),
        };
        await expect(readImaMediaUrl(page, { knowledgeBaseId: 'kb-1', mediaId: 'm-1' }))
            .resolves.toBe('https://res-skb.ima.qq.com/a.pdf?sign=x');
        expect(page.requestImaMedia).toHaveBeenCalledWith('opaque-id', {
            knowledge_base_id: 'kb-1', media_id: 'm-1', scene: 4,
        });
    });

    it('sends client headers for a Linux direct request when an IMA cookie is configured', async () => {
        const page = { fetchJson: vi.fn(async () => ({ action: 1, jump_url_info: { url: 'https://res-skb.ima.qq.com/a.pdf?sign=x' } })) };
        await expect(readImaMediaUrl(page, { knowledgeBaseId: 'kb-1', mediaId: 'm-1' }, {
            imaCookie: 'IMA-UID=u1; IMA-TOKEN=token-1; IMA-GUID=g1',
            extensionVersion: '2.1.23',
        })).resolves.toContain('res-skb.ima.qq.com');
        expect(page.fetchJson).toHaveBeenCalledWith(
            'https://ima.qq.com/cgi-bin/file_manager/get_media',
            expect.objectContaining({
                headers: expect.objectContaining({
                    'x-ima-cookie': 'IMA-UID=u1; IMA-TOKEN=token-1; IMA-GUID=g1',
                    'from_browser_ima': '1', extension_version: '2.1.23',
                }),
            }),
        );
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
