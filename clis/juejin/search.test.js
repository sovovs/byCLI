import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import './search.js';

describe('juejin search command', () => {
    const command = getRegistry().get('juejin/search');

    it('registers as a public browser command', () => {
        expect(command).toBeDefined();
        expect(command.site).toBe('juejin');
        expect(command.strategy).toBe('public');
        expect(command.browser).toBe(true);
        expect(command.columns).toEqual(['rank', 'title', 'author', 'summary', 'url']);
    });

    it('rejects empty queries before browser navigation', async () => {
        const page = { goto: vi.fn() };
        await expect(command.func(page, { query: '   ' })).rejects.toMatchObject({
            name: 'ArgumentError',
            code: 'ARGUMENT',
        });
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('navigates to Juejin comprehensive search by default and returns browser results', async () => {
        const rows = [{ rank: 1, title: 'byCLI', author: 'Juejin', summary: 'article', url: 'https://juejin.cn/post/1' }];
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValue(rows),
        };

        await expect(command.func(page, { query: ' bycli ', limit: 3 })).resolves.toEqual(rows);
        expect(page.goto).toHaveBeenCalledWith('https://juejin.cn/search?query=bycli&sort=0&type=0');
        expect(page.wait).toHaveBeenCalledWith(3);
        expect(page.evaluate).toHaveBeenCalledWith(expect.stringContaining('document.querySelectorAll'));
    });

    it('supports explicit Juejin search type values', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValue([]),
        };

        await command.func(page, { query: ' bycli ', type: 12 });
        expect(page.goto).toHaveBeenCalledWith('https://juejin.cn/search?query=bycli&sort=0&type=12');
    });

    it('rejects unsupported search type values before browser navigation', async () => {
        const page = { goto: vi.fn() };
        await expect(command.func(page, { query: 'bycli', type: 3 })).rejects.toMatchObject({
            name: 'ArgumentError',
            code: 'ARGUMENT',
        });
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('passes the sort type through to the search URL', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValue([]),
        };

        await command.func(page, { query: 'bycli', sort: 2 });
        expect(page.goto).toHaveBeenCalledWith('https://juejin.cn/search?query=bycli&sort=2&type=0');
    });

    it('rejects unsupported sort values before browser navigation', async () => {
        const page = { goto: vi.fn() };
        await expect(command.func(page, { query: 'bycli', sort: 3 })).rejects.toMatchObject({
            name: 'ArgumentError',
            code: 'ARGUMENT',
        });
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('passes the sort type through to the search URL', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValue([]),
        };

        await command.func(page, { query: 'opencli', sort: 2 });
        expect(page.goto).toHaveBeenCalledWith('https://juejin.cn/search?query=opencli&sort=2&type=0');
    });

    it('rejects unsupported sort values before browser navigation', async () => {
        const page = { goto: vi.fn() };
        await expect(command.func(page, { query: 'opencli', sort: 3 })).rejects.toMatchObject({
            name: 'ArgumentError',
            code: 'ARGUMENT',
        });
        expect(page.goto).not.toHaveBeenCalled();
    });
});
