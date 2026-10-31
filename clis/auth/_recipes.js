// Probes return only public account labels and status, never session secrets.
// These page models need live validation when a platform changes its frontend.
//
// Live evidence recorded 2026-10-31 against the desktop Chrome profile:
//   weibo        logged-out -> QR scan -> logged-in; identity matched `bycli weibo me`
//   zhihu        already authenticated; login confirmed through /api/v4/me in 3s
//   xiaohongshu  logged-out (user.loggedIn=false, guest=true) -> scan -> logged-in
//   juejin       already authenticated; login confirmed in 22s (slow SPA hydration)
//   xiaohongshu-creator  the creator centre keeps its own session: it was
//                logged in while www was not. Probe validated on the logged-in
//                path only, so this recipe stays needs-live-validation.
export const RECIPES = Object.freeze({
    weibo: Object.freeze({
        label: '微博',
        surface: 'www',
        detection: 'account-probe',
        loginUrl: 'https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog&disp=popup&url=https%3A%2F%2Fweibo.com%2F',
        homeUrl: 'https://weibo.com/',
        verification: 'live-validated',
        probe: `(() => {
            // Anonymous visitors land on /newlogin (same origin), where the
            // account model does not exist at all — check the path first.
            const p = location.pathname;
            if (p.startsWith('/newlogin') || p.startsWith('/signup') || p.startsWith('/login')) {
                return { status: 'logged-out' };
            }
            const cfg = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$store?.state?.config?.config;
            if (cfg?.uid) return { status: 'logged-in', identity: String(cfg.user?.screen_name || cfg.uid) };
            if (cfg?.islogin === false || cfg?.islogin === 0) return { status: 'logged-out' };
            return { status: 'unknown', reason: 'account-model-unavailable' };
        })()`,
    }),
    zhihu: Object.freeze({
        label: '知乎',
        surface: 'www',
        detection: 'account-probe',
        loginUrl: 'https://www.zhihu.com/signin',
        homeUrl: 'https://www.zhihu.com/',
        verification: 'live-validated',
        probe: `(async () => {
            const r = await fetch('/api/v4/me', { credentials: 'include', signal: AbortSignal.timeout(5000) });
            if (r.status === 401) return { status: 'logged-out' };
            if (!r.ok) return { status: 'unknown', reason: 'account-request-failed' };
            const u = await r.json();
            if (!u.id || !u.url_token) return { status: 'unknown', reason: 'account-response-unrecognized' };
            return { status: 'logged-in', identity: String(u.name || u.url_token) };
        })()`,
    }),
    xiaohongshu: Object.freeze({
        label: '小红书',
        surface: 'www',
        detection: 'account-probe',
        loginUrl: 'https://www.xiaohongshu.com/login',
        homeUrl: 'https://www.xiaohongshu.com/',
        verification: 'live-validated',
        probe: `(() => {
            const s = window.__INITIAL_STATE__?.user;
            const unwrap = v => v && (v._value !== undefined ? v._value : (v.value !== undefined ? v.value : v));
            const loggedIn = unwrap(s?.loggedIn);
            const u = unwrap(s?.userInfo) || {};
            if (loggedIn === true) return { status: 'logged-in', identity: String(u.nickname || u.userId || '') };
            if (loggedIn === false) return { status: 'logged-out' };
            return { status: 'unknown', reason: 'account-model-unavailable' };
        })()`,
    }),
    'xiaohongshu-creator': Object.freeze({
        label: '小红书创作中心',
        surface: 'creator',
        detection: 'account-probe',
        loginUrl: 'https://creator.xiaohongshu.com/login',
        homeUrl: 'https://creator.xiaohongshu.com/new/home',
        verification: 'needs-live-validation',
        probe: `(() => {
            // Creator services authenticate separately from www; an authenticated
            // creator session redirects /login to /new/home, so the path is the
            // cheapest signal that nobody is signed in here.
            if (location.pathname.startsWith('/login')) return { status: 'logged-out' };
            const u = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$store?.state?.Auth?.userInfo;
            if (u?.userId) return { status: 'logged-in', identity: String(u.userName || u.redId || u.userId) };
            return { status: 'unknown', reason: 'account-model-unavailable' };
        })()`,
    }),
    juejin: Object.freeze({
        label: '掘金',
        surface: 'www',
        detection: 'account-probe',
        loginUrl: 'https://juejin.cn/login',
        homeUrl: 'https://juejin.cn/',
        verification: 'live-validated',
        probe: `(() => {
            const auth = document.querySelector('#__nuxt')?.__vue__?.$store?.state?.auth;
            const u = auth?.user;
            if (u?.user_id) return { status: 'logged-in', identity: String(u.user_name || u.user_id) };
            if (auth?.isLogin === false) return { status: 'logged-out' };
            return { status: 'unknown', reason: 'account-model-unavailable' };
        })()`,
    }),
});

export function getRecipe(name) {
    const key = typeof name === 'string' ? name.trim().toLowerCase() : '';
    return Object.hasOwn(RECIPES, key) ? { key, recipe: RECIPES[key] } : null;
}

export function listRecipes() {
    return Object.entries(RECIPES).map(([platform, recipe]) => ({ platform, ...recipe }));
}
