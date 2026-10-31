import { describe, expect, it, vi } from 'vitest';
import { RECIPES } from './_recipes.js';
import { JSDOM } from 'jsdom';
import { authOptions, checkRecipe, openLoginPage, statusRow, unwrap } from './_shared.js';

describe('auth shared behavior', () => {
    it('strictly validates timeout bounds without silently changing the runtime deadline', () => {
        expect(authOptions({ platform: ' Zhihu ' }, true)).toMatchObject({ key: 'zhihu', timeout: 180 });
        for (const timeout of [30, 900]) expect(authOptions({ platform: 'zhihu', timeout }, true).timeout).toBe(timeout);
        for (const timeout of [0, 29, 901, -1, 30.5, '30', NaN, Infinity]) {
            expect(() => authOptions({ platform: 'zhihu', timeout }, true)).toThrow(/30 and 900/);
        }
        expect(() => authOptions({ platform: 'constructor' })).toThrow(/Unknown platform/);
    });

    it('unwraps only evaluate envelopes', () => {
        expect(unwrap({ session: 'test', data: 42 })).toBe(42);
        expect(unwrap({ data: 42 })).toEqual({ data: 42 });
    });

    it('accepts a successful account probe with no cookie API or cookie read', async () => {
        const page = { evaluate: vi.fn().mockResolvedValueOnce('https://www.zhihu.com/').mockResolvedValueOnce({ session: 'a', data: { status: 'logged-in', identity: 'owner' } }) };
        expect(await checkRecipe(page, RECIPES.zhihu)).toEqual({ status: 'logged-in', identity: 'owner', reason: '' });
        expect(page.evaluate).toHaveBeenCalledTimes(2);
    });

    it('retains explicit signed-out results and converts failed/malformed probes into unknown', async () => {
        for (const result of [{ status: 'logged-out' }, true, null, { status: 'unknown', reason: 'secret-value' }]) {
            const page = { evaluate: vi.fn().mockResolvedValueOnce(RECIPES.zhihu.homeUrl).mockResolvedValueOnce(result) };
            const state = await checkRecipe(page, RECIPES.zhihu);
            expect(state.status).toBe(result?.status === 'logged-out' ? 'logged-out' : 'unknown');
            expect(JSON.stringify(state)).not.toContain('secret-value');
        }
        const page = { evaluate: vi.fn().mockRejectedValue(new Error('network-error secret-token')) };
        expect(await checkRecipe(page, RECIPES.zhihu)).toEqual({ status: 'unknown', identity: '', reason: 'probe-unavailable' });
    });

    it.each([
        ['https://passport.weibo.com/sso/signin?ticket=secret', 'login-in-progress'],
        ['https://passport.weibo.com/verify', 'login-in-progress'],
        ['https://weibo.com.evil.example/', 'unexpected-origin'],
        ['https://verification.example/?token=secret', 'unexpected-origin'],
    ])('never navigates or probes away from an SSO/verification page: %s', async (url, reason) => {
        const page = { evaluate: vi.fn().mockResolvedValue(url), goto: vi.fn() };
        expect(await checkRecipe(page, RECIPES.weibo)).toMatchObject({ status: 'unknown', reason });
        expect(page.evaluate).toHaveBeenCalledTimes(1);
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('reuses the single retained QR page without navigating or reading credentials', async () => {
        const page = { tabs: vi.fn(async () => [{ page: 'owned' }]), setActivePage: vi.fn(), evaluate: vi.fn(async () => RECIPES.zhihu.loginUrl), goto: vi.fn() };
        await openLoginPage(page, RECIPES.zhihu);
        expect(page.setActivePage).toHaveBeenCalledWith('owned');
        expect(page.goto).not.toHaveBeenCalled();
        page.evaluate.mockResolvedValue('https://verification.example/');
        await expect(openLoginPage(page, RECIPES.zhihu)).rejects.toMatchObject({ code: 'PAGE_IN_USE' });
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('opens a fresh login page and refuses ambiguous retained pages', async () => {
        const page = { tabs: vi.fn(async () => []), goto: vi.fn() };
        await openLoginPage(page, RECIPES.weibo);
        expect(page.goto).toHaveBeenCalledWith(RECIPES.weibo.loginUrl, { stealth: false });
        page.tabs.mockResolvedValue([{}, {}]);
        await expect(openLoginPage(page, RECIPES.weibo)).rejects.toMatchObject({ code: 'PAGE_IN_USE' });
    });

    it('reopens login for an explicitly expired homepage but preserves unknown or verification pages', async () => {
        const page = {
            tabs: vi.fn(async () => [{ page: 'owned' }]), setActivePage: vi.fn(), goto: vi.fn(),
            evaluate: vi.fn(async expression => expression === 'location.href' ? RECIPES.zhihu.homeUrl : { status: 'logged-out' }),
        };
        await openLoginPage(page, RECIPES.zhihu);
        expect(page.goto).toHaveBeenCalledExactlyOnceWith(RECIPES.zhihu.loginUrl, { stealth: false });
        page.goto.mockClear();
        page.evaluate.mockImplementation(async expression => expression === 'location.href' ? RECIPES.zhihu.homeUrl : { status: 'unknown' });
        await openLoginPage(page, RECIPES.zhihu);
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('rechecks the origin atomically before running an account probe after a redirect', async () => {
        const dom = new JSDOM('', { url: 'https://outside.example/', runScripts: 'outside-only' });
        const fetch = vi.fn(); dom.window.fetch = fetch;
        const page = { evaluate: vi.fn(async expression => expression === 'location.href' ? RECIPES.zhihu.homeUrl : dom.window.eval(expression)) };
        try {
            expect(await checkRecipe(page, RECIPES.zhihu)).toMatchObject({ status: 'unknown', reason: 'login-in-progress' });
            expect(fetch).not.toHaveBeenCalled();
        } finally { dom.window.close(); }
    });

    it('does not expose SSO query strings or probe errors in output', () => {
        const result = statusRow('weibo', RECIPES.weibo, { status: 'unknown', identity: '', reason: 'probe-unavailable' });
        expect(result.url).toBe(RECIPES.weibo.homeUrl);
        expect(result.identity).toBe('');
    });
});
