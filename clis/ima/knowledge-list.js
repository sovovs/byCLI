import { cli, Strategy } from '@sovovs/bycli/registry';
import { CommandExecutionError, ConfigError } from '@sovovs/bycli/errors';

import { readKnowledgeBasesFromChrome } from './native-client.js';

const COMMAND = 'ima knowledge-list';

function throwDriverError(error) {
    if (error?.code === 'IMA_CHROME_AUTH_REQUIRED') {
        throw new ConfigError(
            error.message || 'ima reader authentication is required',
            'Open https://ima.qq.com/wikis in Chrome, sign in, then retry with the latest bycli Browser Bridge extension.',
        );
    }
    throw new CommandExecutionError(
        error?.message || `${COMMAND} failed to read knowledge bases`,
    );
}

export async function runKnowledgeListCommand(read) {
    try {
        const items = await read();
        if (!Array.isArray(items)) {
            throw new CommandExecutionError(`${COMMAND} returned malformed knowledge-base rows`);
        }
        return items;
    } catch (error) {
        if (error instanceof ConfigError || error instanceof CommandExecutionError) throw error;
        throwDriverError(error);
    }
}

export const knowledgeListCommand = cli({
    site: 'ima',
    name: 'knowledge-list',
    access: 'read',
    description: '获取全部 ima 知识库的常用字段与原始元数据',
    domain: 'ima.qq.com',
    defaultFormat: 'json',
    args: [],
    columns: ['id', 'name', 'type', 'typeName', 'raw'],
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    func: async (page) => runKnowledgeListCommand(
        () => readKnowledgeBasesFromChrome(page),
    ),
});
