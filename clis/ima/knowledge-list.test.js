import { describe, expect, it } from 'vitest';

import { ConfigError } from '@sovovs/bycli/errors';

import { knowledgeListCommand, runKnowledgeListCommand } from './knowledge-list.js';

describe('ima knowledge-list command contract', () => {
    it('is a read-only JSON browser command without required arguments', () => {
        expect(knowledgeListCommand.site).toBe('ima');
        expect(knowledgeListCommand.name).toBe('knowledge-list');
        expect(knowledgeListCommand.access).toBe('read');
        expect(knowledgeListCommand.browser).toBe(true);
        expect(knowledgeListCommand.navigateBefore).toBe(false);
        expect(knowledgeListCommand.defaultFormat).toBe('json');
        expect(knowledgeListCommand.args).toEqual([]);
        expect(knowledgeListCommand.columns).toEqual(['id', 'name', 'type', 'typeName', 'raw']);
    });
});

describe('runKnowledgeListCommand', () => {
    it('returns normalized knowledge-base rows with complete raw metadata', async () => {
        const row = {
            id: 'kb-1', name: '工程', type: 1001, typeName: '我的知识库',
            raw: { id: 'kb-1', basic_info: { name: '工程' }, creator_info: { nick_name: '创建者' } },
        };
        await expect(runKnowledgeListCommand(async () => [row])).resolves.toEqual([row]);
    });

    it('suggests Chrome authentication when private reader auth is missing', async () => {
        const error = Object.assign(new Error('sign in required'), { code: 'IMA_CHROME_AUTH_REQUIRED' });
        await expect(runKnowledgeListCommand(async () => { throw error; }))
            .rejects.toThrow(ConfigError);
    });
});
