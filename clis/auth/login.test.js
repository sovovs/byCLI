import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginCommand } from './login.js';
import { RECIPES } from './_recipes.js';

function pageMock(check = { status: 'unknown' }) {
    let url = 'about:blank';
    return {
        goto: vi.fn(async value => { url = value; }),
        tabs: vi.fn(async () => []), setActivePage: vi.fn(), closeWindow: vi.fn(),
        evaluate: vi.fn(async expression => expression === 'location.href' ? url : check),
        wait: vi.fn(async ({ time }) => { vi.setSystemTime(Date.now() + time * 1000); }),
    };
}

describe('auth login', () => {
    afterEach(() => vi.useRealTimers());

    it('registers a retained browser command and validates before touching the page', async () => {
        expect(loginCommand).toMatchObject({ site: 'auth', name: 'login', browser: 'conditional', siteSession: 'persistent', navigateBefore: false });
        expect(() => loginCommand.requiresBrowser({ platform: 'constructor' })).toThrow(/Unknown platform/);
        expect(loginCommand.requiresBrowser({ platform: 'zhihu', timeout: 30 })).toBe(true);
        const page = pageMock();
        await expect(loginCommand.func(page, { platform: '__proto__' })).rejects.toMatchObject({ code: 'ARGUMENT' });
        await expect(loginCommand.func(page, { platform: 'zhihu', timeout: 901 })).rejects.toMatchObject({ code: 'ARGUMENT' });
        expect(page.goto).not.toHaveBeenCalled(); expect(page.tabs).not.toHaveBeenCalled();
    });

    it('waits for a successful human login and returns only the public identity', async () => {
        vi.useFakeTimers(); vi.setSystemTime(0);
        const page = pageMock({ status: 'logged-in', identity: 'Owner' });
        const rows = await loginCommand.func(page, { platform: ' ZHIHU ', timeout: 30 });
        expect(rows[0]).toMatchObject({ platform: 'zhihu', status: 'logged-in', identity: 'Owner', waited_s: 0 });
        expect(page.goto).toHaveBeenCalledOnce();
        expect(page.closeWindow).not.toHaveBeenCalled();
    });

    it('times out as waiting, retains the QR page, and never navigates during polling', async () => {
        vi.useFakeTimers(); vi.setSystemTime(0);
        const page = pageMock();
        const [row] = await loginCommand.func(page, { platform: 'weibo', timeout: 30 });
        expect(row).toMatchObject({ status: 'waiting', platform: 'weibo', waited_s: 30, identity: '', reason: 'login-in-progress' });
        expect(page.goto).toHaveBeenCalledExactlyOnceWith(RECIPES.weibo.loginUrl, { stealth: false });
        expect(page.closeWindow).not.toHaveBeenCalled();
    });

    it('retries unknown probes while preserving the page and then observes success', async () => {
        vi.useFakeTimers(); vi.setSystemTime(0);
        const page = pageMock();
        let attempts = 0;
        page.evaluate.mockImplementation(async expression => {
            if (expression === 'location.href') return RECIPES.zhihu.homeUrl;
            if (++attempts === 1) throw new Error('temporary network failure');
            return { status: 'logged-in', identity: 'Owner' };
        });
        expect((await loginCommand.func(page, { platform: 'zhihu', timeout: 30 }))[0])
            .toMatchObject({ status: 'logged-in', waited_s: 3 });
        expect(page.goto).toHaveBeenCalledOnce();
    });
});
