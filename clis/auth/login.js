import { cli, Strategy } from '@sovovs/bycli/registry';
import { authOptions, checkRecipe, openLoginPage, platformArg, statusRow } from './_shared.js';

export const loginCommand = cli({
    site: 'auth', name: 'login', access: 'read',
    description: 'Open a retained official login page and wait for human authentication',
    strategy: Strategy.COOKIE,
    // Hydrate and validate arguments before acquiring a browser, including
    // when startup uses the precompiled command manifest.
    browser: args => { authOptions(args, true); return true; }, navigateBefore: false,
    siteSession: 'persistent',
    args: [platformArg, { name: 'timeout', type: 'int', default: 180, help: 'Human login wait in seconds (30–900)' }],
    columns: ['status', 'platform', 'identity', 'waited_s', 'url', 'reason', 'message'],
    validateArgs: args => { authOptions(args, true); },
    func: async (page, args) => {
        const { key, recipe, timeout } = authOptions(args, true);
        const started = Date.now();
        const deadline = started + timeout * 1000;
        await openLoginPage(page, recipe);
        let last = { status: 'unknown', identity: '', reason: 'login-in-progress' };
        while (Date.now() < deadline) {
            last = await checkRecipe(page, recipe);
            if (last.status === 'logged-in') {
                return [{ ...statusRow(key, recipe, last), waited_s: Math.round((Date.now() - started) / 1000) }];
            }
            await page.wait({ time: Math.min(3, Math.max(0, (deadline - Date.now()) / 1000)) });
        }
        return [{
            ...statusRow(key, recipe, last), status: 'waiting', identity: '',
            waited_s: Math.round((Date.now() - started) / 1000),
            url: recipe.loginUrl,
            reason: last.reason || 'login-not-complete',
            message: `Login not confirmed before timeout. The default persistent login page remains open. Finish authentication, then run "bycli auth status ${key}".`,
        }];
    },
});
