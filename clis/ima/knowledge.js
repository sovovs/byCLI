import { cli, Strategy } from '@sovovs/bycli/registry';
import {
    ArgumentError,
    CommandExecutionError,
    ConfigError,
    EmptyResultError,
} from '@sovovs/bycli/errors';

import { readKnowledgeBaseFromChrome } from './native-client.js';
import { toKnowledgeRow } from './utils.js';

const COMMAND = 'ima knowledge';

function throwDriverError(envelope) {
    const message = envelope?.message || 'ima reader failed';
    switch (envelope?.code) {
        case 'EMPTY_QUERY':
        case 'AMBIGUOUS_KNOWLEDGE':
            throw new ArgumentError(message);
        case 'KNOWLEDGE_NOT_FOUND':
            throw new EmptyResultError(COMMAND, message);
        case 'IMA_CHROME_AUTH_REQUIRED':
            throw new ConfigError(
                message,
                'Open https://ima.qq.com/wikis in Chrome, sign in, then retry with the latest bycli Browser Bridge extension.',
            );
        default:
            throw new CommandExecutionError(message);
    }
}

export async function runKnowledgeCommand(kwargs, read) {
    const query = String(kwargs?.knowledgeBase ?? '').trim();
    if (!query) {
        throw new ArgumentError('knowledge-base name or ID is required');
    }

    let envelope;
    try {
        envelope = await read(query);
    } catch (error) {
        if (error instanceof ArgumentError || error instanceof ConfigError
            || error instanceof EmptyResultError || error instanceof CommandExecutionError) {
            throw error;
        }
        if (error && typeof error === 'object' && typeof error.code === 'string') {
            throwDriverError({ code: error.code, message: error.message });
        }
        throw new CommandExecutionError(
            `ima knowledge reader failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (!envelope?.ok) throwDriverError(envelope);
    if (!Array.isArray(envelope.items)) {
        throw new CommandExecutionError('ima knowledge reader returned malformed items');
    }
    if (envelope.items.length === 0) {
        throw new EmptyResultError(COMMAND, `Knowledge base "${query}" contains no readable articles.`);
    }
    return envelope.items.map(toKnowledgeRow);
}

export const knowledgeCommand = cli({
    site: 'ima',
    name: 'knowledge',
    access: 'read',
    description: '按名称或 ID 获取 ima 知识库中的文章标题、URL 与文件夹路径',
    domain: 'ima.qq.com',
    defaultFormat: 'json',
    args: [
        {
            name: 'knowledgeBase',
            type: 'string',
            required: true,
            positional: true,
            help: '知识库的完整名称或 ima 页面中的 knowledgeBaseId',
        },
    ],
    columns: [
        'knowledgeBaseId',
        'knowledgeBase',
        'folderPath',
        'title',
        'url',
        'contentType',
        'addedDate',
    ],
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    func: async (page, kwargs) => runKnowledgeCommand(
        kwargs,
        (query) => readKnowledgeBaseFromChrome(page, query),
    ),
});
