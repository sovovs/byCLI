import { describe, expect, it, vi } from 'vitest';
import { statusCommand } from './status.js';
import { sitesCommand } from './sites.js';
import { RECIPES } from './_recipes.js';

describe('auth status and sites', () => {
    it('lists supported platforms without opening a browser or overstating verification', async () => {
        expect(sitesCommand.browser).toBe(false);
        const rows = await sitesCommand.func({});
        expect(rows.map(r => r.platform)).toEqual(['weibo', 'zhihu', 'xiaohongshu', 'xiaohongshu-creator', 'juejin']);
        for (const row of rows) expect(row).toMatchObject({ detection: 'account-probe', surface: expect.stringMatching(/^(www|creator)$/) });
        expect(rows.find(r => r.platform === 'xiaohongshu-creator'))
            .toMatchObject({ surface: 'creator', verification: 'needs-live-validation' });
        for (const row of rows.filter(r => r.platform !== 'xiaohongshu-creator'))
            expect(row).toMatchObject({ verification: 'live-validated' });
    });

    it('retries one unknown probe before reporting it, and never retries a settled state', async () => {
        const page = {
            goto: vi.fn(), wait: vi.fn(),
            evaluate: vi.fn()
                .mockResolvedValueOnce(RECIPES.zhihu.homeUrl).mockResolvedValueOnce({ status: 'unknown', reason: 'account-model-unavailable' })
                .mockResolvedValueOnce(RECIPES.zhihu.homeUrl).mockResolvedValueOnce({ status: 'logged-in', identity: 'Owner' }),
        };
        const [row] = await statusCommand.func(page, { platform: 'zhihu' });
        expect(row).toMatchObject({ status: 'logged-in', identity: 'Owner' });
        expect(page.wait).toHaveBeenCalledTimes(2); // initial hydration wait + one retry

        const settled = {
            goto: vi.fn(), wait: vi.fn(),
            evaluate: vi.fn().mockResolvedValueOnce(RECIPES.zhihu.homeUrl).mockResolvedValueOnce({ status: 'logged-out' }),
        };
        expect((await statusCommand.func(settled, { platform: 'zhihu' }))[0].status).toBe('logged-out');
        expect(settled.wait).toHaveBeenCalledExactlyOnceWith({ time: 2 }); // initial hydration wait only
    });

    it.each(['logged-in', 'logged-out', 'unknown'])('reports %s from an independent homepage probe', async status => {
        const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValueOnce(RECIPES.zhihu.homeUrl).mockResolvedValueOnce({ status, identity: 'Owner' }) };
        const [row] = await statusCommand.func(page, { platform: 'zhihu' });
        expect(row.status).toBe(status);
        expect(row.identity).toBe(status === 'logged-in' ? 'Owner' : '');
        expect(page.goto).toHaveBeenCalledExactlyOnceWith(RECIPES.zhihu.homeUrl, { stealth: false });
        expect(statusCommand.siteSession).not.toBe('persistent');
    });

    it('returns unknown on navigation failure without leaking the error', async () => {
        const page = { goto: vi.fn().mockRejectedValue(new Error('sensitive-token')), evaluate: vi.fn() };
        const [row] = await statusCommand.func(page, { platform: 'zhihu' });
        expect(row).toMatchObject({ status: 'unknown', reason: 'navigation-failed', identity: '' });
        expect(JSON.stringify(row)).not.toContain('sensitive-token');
        expect(page.evaluate).not.toHaveBeenCalled();
    });

    it('rejects unsupported platforms before navigation', async () => {
        expect(() => statusCommand.requiresBrowser({ platform: 'constructor' })).toThrow(/Unknown platform/);
        const page = { goto: vi.fn() };
        await expect(statusCommand.func(page, { platform: 'constructor' })).rejects.toMatchObject({ code: 'ARGUMENT' });
        expect(page.goto).not.toHaveBeenCalled();
    });
});
