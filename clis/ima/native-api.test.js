import { describe, expect, it, vi } from 'vitest';

import {
    collectKnowledgeTree,
    findKnowledgeBase,
    listKnowledgeBases,
    readKnowledgeBaseFromApi,
} from './native-api.js';

describe('collectKnowledgeTree', () => {
    it('uses ima list page size and omits folder_id for the root', async () => {
        const request = vi.fn(async () => ({ code: 0, knowledge_list: [], is_end: true }));
        await collectKnowledgeTree({
            knowledgeBaseId: 'kb-1',
            knowledgeBaseName: '工程',
            request,
        });
        expect(request.mock.calls[0][1]).toEqual({
            cursor: '',
            limit: 20,
            knowledge_base_id: 'kb-1',
            need_default_cover: true,
            ext_info: { share_id: '' },
        });
    });

    it('uses source_path when ima omits jump_url from a web list item', async () => {
        const request = async () => ({
            code: 0,
            knowledge_list: [{
                media_type: 2,
                title: '网页文章',
                jump_url: '',
                source_path: 'https://example.com/from-source-path',
            }],
            is_end: true,
        });
        const [article] = await collectKnowledgeTree({
            knowledgeBaseId: 'kb-1',
            knowledgeBaseName: '工程',
            request,
        });
        expect(article.url).toBe('https://example.com/from-source-path');
    });

    it('does not expose a local source_path as a web URL', async () => {
        const request = async () => ({
            code: 0,
            knowledge_list: [{ media_type: 1, title: '本地 PDF', source_path: '/tmp/private.pdf' }],
            is_end: true,
        });
        const [article] = await collectKnowledgeTree({
            knowledgeBaseId: 'kb-1',
            knowledgeBaseName: '工程',
            request,
        });
        expect(article.url).toBeNull();
    });


    it('paginates every folder and returns articles with their folder paths', async () => {
        const request = vi.fn(async (_path, body) => {
            const folderId = body.folder_id ?? '';
            const cursor = body.cursor ?? '';
            if (!folderId && !cursor) {
                return {
                    code: 0,
                    knowledge_base_info: { id: 'kb-1', basic_info: { name: '工程' } },
                    knowledge_list: [
                        { media_type: 2, media_id: 'a', title: '根文章', jump_url: 'https://example.com/a' },
                        { media_type: 99, media_id: 'folder-row', folder_info: { folder_id: 'f-1', name: '模板' } },
                    ],
                    next_cursor: 'page-2',
                    is_end: false,
                };
            }
            if (!folderId && cursor === 'page-2') {
                return {
                    code: 0,
                    knowledge_list: [
                        { media_type: 6, media_id: 'b', title: '根文章二', jump_url: 'https://example.com/b' },
                    ],
                    next_cursor: '',
                    is_end: true,
                };
            }
            expect(folderId).toBe('f-1');
            return {
                code: 0,
                knowledge_list: [
                    { media_type: 2, media_id: 'c', title: '文件夹文章', jump_url: 'https://example.com/c' },
                ],
                next_cursor: '',
                is_end: true,
            };
        });

        await expect(collectKnowledgeTree({
            knowledgeBaseId: 'kb-1',
            knowledgeBaseName: '工程',
            request,
        })).resolves.toEqual([
            expect.objectContaining({ title: '根文章', folderPath: [] }),
            expect.objectContaining({ title: '根文章二', folderPath: [] }),
            expect.objectContaining({ title: '文件夹文章', folderPath: ['模板'] }),
        ]);
        expect(request).toHaveBeenCalledTimes(3);
    });

    it('rejects an ima API error instead of returning a partial result', async () => {
        await expect(collectKnowledgeTree({
            knowledgeBaseId: 'kb-1',
            knowledgeBaseName: '工程',
            request: async () => ({ code: 41, msg: '登录已失效' }),
        })).rejects.toThrow('登录已失效');
    });

    it('rejects a repeated article-list cursor instead of looping forever', async () => {
        await expect(collectKnowledgeTree({
            knowledgeBaseId: 'kb-1',
            knowledgeBaseName: '工程',
            request: async () => ({
                code: 0,
                knowledge_list: [],
                next_cursor: 'same-page',
                is_end: false,
            }),
        })).rejects.toThrow('repeated cursor');
    });

    it('rejects a missing article-list cursor instead of returning partial data', async () => {
        await expect(collectKnowledgeTree({
            knowledgeBaseId: 'kb-1',
            knowledgeBaseName: '工程',
            request: async () => ({ code: 0, knowledge_list: [], is_end: false }),
        })).rejects.toThrow('missing cursor');
    });
});

describe('findKnowledgeBase', () => {
    it('lists every knowledge-base group with raw metadata and deduplicates IDs', async () => {
        const primary = {
            id: 'kb-1',
            basic_info: { name: '工程' },
            creator_info: { nick_name: '创建者' },
            access_status: 1,
        };
        const request = vi.fn(async (_path, body) => {
            if (body.params.length > 1) {
                return {
                    code: 0,
                    results: [
                        { type: 1001, knowledge_base_list: [primary], is_end: true },
                        { type: 1002, knowledge_base_list: [{ ...primary }], is_end: true },
                    ],
                };
            }
            return { code: 0, results: [{ type: body.params[0].type, knowledge_base_list: [], is_end: true }] };
        });

        await expect(listKnowledgeBases(request)).resolves.toEqual([{
            id: 'kb-1',
            name: '工程',
            type: 1001,
            typeName: '我的知识库',
            raw: primary,
        }]);
    });

    it('finds an exact knowledge-base name across paginated groups', async () => {
        const request = vi.fn(async (_path, body) => {
            const mine = body.params.find((item) => item.type === 1001);
            if (!mine?.cursor) {
                return {
                    code: 0,
                    results: [{
                        type: 1001,
                        knowledge_base_list: [{ id: 'kb-other', basic_info: { name: '其他' } }],
                        next_cursor: 'mine-2',
                        is_end: false,
                    }],
                };
            }
            return {
                code: 0,
                results: [{
                    type: 1001,
                    knowledge_base_list: [{ id: 'kb-1', basic_info: { name: '企业级AI应用落地实践' } }],
                    next_cursor: '',
                    is_end: true,
                }],
            };
        });

        await expect(findKnowledgeBase('企业级AI应用落地实践', request)).resolves.toEqual({
            id: 'kb-1',
            name: '企业级AI应用落地实践',
        });
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('accepts an exact knowledge-base ID', async () => {
        const request = async () => ({
            code: 0,
            results: [{
                type: 1002,
                knowledge_base_list: [{ id: '7473122676592270', basic_info: { name: '工程' } }],
                is_end: true,
            }],
        });
        await expect(findKnowledgeBase('7473122676592270', request)).resolves.toEqual({
            id: '7473122676592270',
            name: '工程',
        });
    });

    it('uses the page limits required by ima for each knowledge-base group', async () => {
        const request = vi.fn(async () => ({ code: 0, results: [] }));
        await expect(findKnowledgeBase('missing', request)).rejects.toThrow('was not found');
        expect(request.mock.calls[0][1]).toEqual({
            params: [
                { type: 1001, cursor: '', limit: 20 },
                { type: 1002, cursor: '', limit: 20 },
                { type: 1004, cursor: '', limit: 20 },
                { type: 1005, cursor: '', limit: 50 },
            ],
        });
    });

    it('continues every knowledge-base group that has another page', async () => {
        const request = vi.fn(async (_path, body) => {
            if (body.params.length > 1) {
                return {
                    code: 0,
                    results: [
                        { type: 1001, knowledge_base_list: [], next_cursor: 'mine-2', is_end: false },
                        { type: 1002, knowledge_base_list: [], next_cursor: 'shared-2', is_end: false },
                    ],
                };
            }
            if (body.params[0].type === 1001) {
                return { code: 0, results: [{ type: 1001, knowledge_base_list: [], is_end: true }] };
            }
            return {
                code: 0,
                results: [{
                    type: 1002,
                    knowledge_base_list: [{ id: 'kb-shared', basic_info: { name: '共享工程' } }],
                    is_end: true,
                }],
            };
        });

        await expect(findKnowledgeBase('共享工程', request)).resolves.toEqual({
            id: 'kb-shared',
            name: '共享工程',
        });
    });

    it('rejects a repeated knowledge-base cursor instead of looping forever', async () => {
        const request = async () => ({
            code: 0,
            results: [{
                type: 1001,
                knowledge_base_list: [],
                next_cursor: 'same-page',
                is_end: false,
            }],
        });
        await expect(findKnowledgeBase('missing', request)).rejects.toThrow('repeated cursor');
    });

    it('rejects a missing knowledge-base cursor instead of returning partial data', async () => {
        const request = async () => ({
            code: 0,
            results: [{ type: 1001, knowledge_base_list: [], is_end: false }],
        });
        await expect(findKnowledgeBase('missing', request)).rejects.toThrow('missing cursor');
    });
});

describe('readKnowledgeBaseFromApi', () => {
    it('resolves a knowledge base and returns a driver-compatible envelope', async () => {
        const request = vi.fn(async (path) => {
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
                    media_id: 'article-1',
                    title: '文章',
                    jump_url: 'https://example.com/article',
                    source_path: 'https://example.com/source',
                    create_time: 10,
                    update_time: 20,
                    last_modify_time: 30,
                    last_open_time: 40,
                    file_size: 50,
                    abstract: '摘要',
                    introduction: '简介',
                    tags: ['AI'],
                    is_top: true,
                    access_status: 2,
                    parse_progress: 100,
                    summary_state: 1,
                }],
                is_end: true,
            };
        });

        await expect(readKnowledgeBaseFromApi('工程', request)).resolves.toEqual({
            ok: true,
            items: [expect.objectContaining({
                knowledgeBaseId: 'kb-1',
                knowledgeBase: '工程',
                title: '文章',
                url: 'https://example.com/article',
                mediaId: 'article-1',
                mediaType: 2,
                sourcePath: 'https://example.com/source',
                createTime: 10,
                updateTime: 20,
                lastModifyTime: 30,
                lastOpenTime: 40,
                fileSize: 50,
                abstract: '摘要',
                introduction: '简介',
                tags: ['AI'],
                isTop: true,
                accessStatus: 2,
                parseProgress: 100,
                summaryState: 1,
            })],
        });
    });
});
