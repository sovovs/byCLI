import { describe, expect, it, vi } from 'vitest';

import { ArgumentError, CommandExecutionError, ConfigError, EmptyResultError } from '@sovovs/bycli/errors';
import { knowledgeCommand, runKnowledgeCommand } from './knowledge.js';

describe('ima knowledge command contract', () => {
    it('is a read-only JSON command with stable columns', () => {
        expect(knowledgeCommand.site).toBe('ima');
        expect(knowledgeCommand.name).toBe('knowledge');
        expect(knowledgeCommand.access).toBe('read');
        expect(knowledgeCommand.browser).toBe(true);
        expect(knowledgeCommand.navigateBefore).toBe(false);
        expect(knowledgeCommand.domain).toBe('ima.qq.com');
        expect(knowledgeCommand.defaultFormat).toBe('json');
        expect(knowledgeCommand.columns).toEqual([
            'knowledgeBaseId', 'knowledgeBase', 'folderPath', 'title',
            'url', 'contentType', 'addedDate', 'mediaId', 'mediaType',
            'mediaState', 'mediaAuditStatus', 'mediaTypeInfo', 'sourcePath',
            'jumpUrl', 'createTime', 'updateTime', 'lastModifyTime', 'lastOpenTime',
            'fileSize', 'abstract', 'introduction', 'tags', 'isTop', 'accessStatus',
            'accessStatusUpdateTs', 'parseProgress', 'parseErrInfo', 'summaryState',
            'coverUrls', 'logo',
        ]);
    });
});

describe('runKnowledgeCommand', () => {
    it('accepts an asynchronous native reader', async () => {
        const read = async () => ({
            ok: true,
            items: [{ knowledgeBaseId: 'kb-1', knowledgeBase: '工程', title: '文章' }],
        });
        await expect(runKnowledgeCommand({ knowledgeBase: '工程' }, read)).resolves.toEqual([
            expect.objectContaining({ knowledgeBaseId: 'kb-1', title: '文章' }),
        ]);
    });

    it('preserves typed native-reader errors', async () => {
        const error = Object.assign(new Error('not found'), { code: 'KNOWLEDGE_NOT_FOUND' });
        await expect(runKnowledgeCommand(
            { knowledgeBase: 'missing' },
            async () => { throw error; },
        )).rejects.toThrow(EmptyResultError);
    });

    it('returns normalized deterministic rows from the driver', async () => {
        const read = vi.fn(() => ({
            ok: true,
            items: [{
                knowledgeBaseId: 'kb-1', knowledgeBase: '工程', folderPath: ['AI'],
                title: '文章', url: 'https://example.com/a', contentType: '网页', addedDate: '8/24',
                mediaId: 'article-1', sourcePath: 'https://example.com/source', fileSize: 42, tags: ['AI'],
            }],
        }));
        await expect(runKnowledgeCommand({ knowledgeBase: ' 工程 ' }, read)).resolves.toEqual([{
            knowledgeBaseId: 'kb-1', knowledgeBase: '工程', folderPath: ['AI'], title: '文章',
            url: 'https://example.com/a', contentType: '网页', addedDate: '8/24',
            mediaId: 'article-1', sourcePath: 'https://example.com/source', fileSize: 42, tags: ['AI'],
        }]);
        expect(read).toHaveBeenCalledWith('工程');
    });

    it('preserves distinct native items even when their display fields match', async () => {
        const base = {
            knowledgeBaseId: 'kb-1', knowledgeBase: '工程', folderPath: ['AI'],
            title: '文章', contentType: '网页', addedDate: '8/24',
        };
        const read = () => ({
            ok: true,
            items: [
                { ...base, url: 'https://example.com/a' },
                { ...base, url: 'https://example.com/a' },
                { ...base, url: 'https://example.com/b' },
            ],
        });
        await expect(runKnowledgeCommand({ knowledgeBase: '工程' }, read)).resolves.toHaveLength(3);
    });

    it('rejects an empty knowledge-base query', async () => {
        await expect(runKnowledgeCommand({ knowledgeBase: ' ' }, vi.fn())).rejects.toThrow(ArgumentError);
    });

    it.each([
        ['IMA_CHROME_AUTH_REQUIRED', ConfigError],
        ['KNOWLEDGE_NOT_FOUND', EmptyResultError],
        ['AX_DRIVER_FAILED', CommandExecutionError],
    ])('maps %s to a typed error', async (code, ErrorType) => {
        await expect(runKnowledgeCommand(
            { knowledgeBase: '工程' },
            () => ({ ok: false, code, message: 'driver message' }),
        )).rejects.toThrow(ErrorType);
    });

    it('suggests Chrome authentication when the private reader auth is missing', async () => {
        const error = await runKnowledgeCommand(
            { knowledgeBase: '工程' },
            () => ({ ok: false, code: 'IMA_CHROME_AUTH_REQUIRED', message: 'sign in required' }),
        ).catch((caught) => caught);
        expect(error).toBeInstanceOf(ConfigError);
        expect(error.hint).toContain('Chrome');
        expect(error.hint).not.toContain('Keychain');
    });

    it('treats a matched but empty knowledge base as an empty result', async () => {
        await expect(runKnowledgeCommand(
            { knowledgeBase: '工程' },
            () => ({ ok: true, items: [] }),
        )).rejects.toThrow(EmptyResultError);
    });
});
