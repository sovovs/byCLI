import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { getRecipe, listRecipes, RECIPES } from './_recipes.js';

async function probe(platform, setup = () => {}, url = RECIPES[platform].homeUrl) {
    const dom = new JSDOM('<div id="app"></div><div id="__nuxt"></div>', { url, runScripts: 'outside-only' });
    try {
        dom.window.AbortSignal = AbortSignal;
        setup(dom.window);
        return await dom.window.eval(RECIPES[platform].probe);
    } finally { dom.window.close(); }
}

describe('auth recipes', () => {
    it('normalizes supported names and rejects prototype properties and non-strings', () => {
        expect(getRecipe(' ZHIHU ').key).toBe('zhihu');
        for (const value of ['constructor', '__proto__', 'toString', 'missing', '', null, {}, 1]) expect(getRecipe(value)).toBeNull();
        expect(listRecipes()).toHaveLength(5);
        const verification = {
            weibo: 'live-validated', zhihu: 'live-validated', xiaohongshu: 'live-validated',
            'xiaohongshu-creator': 'needs-live-validation', juejin: 'live-validated',
        };
        for (const r of listRecipes()) {
            expect(new URL(r.loginUrl).protocol).toBe('https:');
            expect(r.verification).toBe(verification[r.platform]);
            expect(r.surface).toMatch(/^(www|creator)$/);
            expect(r.detection).toBe('account-probe');
            expect(r.probe).not.toContain('document.cookie');
        }
        expect(getRecipe('Xiaohongshu-Creator').key).toBe('xiaohongshu-creator');
    });

    it('uses the current Weibo account model, not visible cookies', async () => {
        const setConfig = config => w => { w.document.querySelector('#app').__vue_app__ = { config: { globalProperties: { $store: { state: { config: { config } } } } } }; };
        expect(await probe('weibo', setConfig({ uid: '123', user: { screen_name: 'test-user' } })))
            .toEqual({ status: 'logged-in', identity: 'test-user' });
        expect(await probe('weibo', setConfig({ islogin: false }))).toEqual({ status: 'logged-out' });
        expect((await probe('weibo', w => { w.document.cookie = 'SUB=stale'; })).status).toBe('unknown');
    });

    it('treats the anonymous Weibo login page as logged-out, where no account model exists', async () => {
        // Live evidence: an anonymous weibo.com visit lands on /newlogin on the
        // same origin, with no islogin/uid in $CONFIG and no store config.
        for (const path of ['/newlogin?tabtype=weibo', '/signup', '/login']) {
            expect(await probe('weibo', () => {}, `https://weibo.com${path}`)).toEqual({ status: 'logged-out' });
        }
        expect((await probe('weibo', () => {}, 'https://weibo.com/')).status).toBe('unknown');
    });

    it('uses the current Juejin owner account model', async () => {
        const auth = a => w => { w.document.querySelector('#__nuxt').__vue__ = { $store: { state: { auth: a } } }; };
        expect(await probe('juejin', auth({ user: { user_id: '123', user_name: 'owner' } })))
            .toEqual({ status: 'logged-in', identity: 'owner' });
        expect(await probe('juejin', auth({ isLogin: false }))).toEqual({ status: 'logged-out' });
        expect((await probe('juejin')).status).toBe('unknown');
    });

    it('requires an authenticated Xiaohongshu current-user flag and identity, not a public profile', async () => {
        const user = u => w => { w.__INITIAL_STATE__ = { user: u }; };
        // Live evidence: the account model exposes user.loggedIn, not user.isLogin.
        expect(await probe('xiaohongshu', user({ loggedIn: { _value: true }, userInfo: { _value: { userId: 'abc', nickname: 'owner' } } })))
            .toEqual({ status: 'logged-in', identity: 'owner' });
        expect(await probe('xiaohongshu', user({ loggedIn: true, userInfo: { _value: { userId: 'abc', guest: false } } })))
            .toEqual({ status: 'logged-in', identity: 'abc' });
        expect((await probe('xiaohongshu', user({ userPageData: { userId: 'someone-else' }, userInfo: { userId: 'guest' } }))).status).toBe('unknown');
        expect(await probe('xiaohongshu', user({ loggedIn: false, userInfo: { userId: 'guest', guest: true } }))).toEqual({ status: 'logged-out' });
        expect((await probe('xiaohongshu', user({ isLogin: true }))).status).toBe('unknown');
    });

    it('keeps the Xiaohongshu creator surface separate from www', async () => {
        // Live evidence: the creator centre was authenticated while www reported
        // logged-out, so the two sessions cannot share one recipe.
        const auth = userInfo => w => {
            w.document.querySelector('#app').__vue_app__ = { config: { globalProperties: { $store: { state: { Auth: { userInfo } } } } } };
        };
        expect(await probe('xiaohongshu-creator', auth({ userId: '6370cbc7', userName: 'owner', redId: '5401110825' })))
            .toEqual({ status: 'logged-in', identity: 'owner' });
        expect((await probe('xiaohongshu-creator', auth({}))).status).toBe('unknown');
        expect(await probe('xiaohongshu-creator', () => {}, 'https://creator.xiaohongshu.com/login?redirect=%2Fnew%2Fhome'))
            .toEqual({ status: 'logged-out' });
    });

    it('distinguishes Zhihu 401, successful identity, server errors and malformed success', async () => {
        const response = (status, json) => w => { w.fetch = vi.fn(async () => ({ status, ok: status === 200, json: async () => json })); };
        expect(await probe('zhihu', response(401))).toEqual({ status: 'logged-out' });
        expect(await probe('zhihu', response(200, { id: '1', url_token: 'owner', name: 'Owner' })))
            .toEqual({ status: 'logged-in', identity: 'Owner' });
        for (const code of [403, 429, 500]) expect((await probe('zhihu', response(code))).status).toBe('unknown');
        expect((await probe('zhihu', response(200, {}))).status).toBe('unknown');
    });
});
