import { cli, Strategy } from '@sovovs/bycli/registry';
import { authOptions, checkRecipe, platformArg, statusRow } from './_shared.js';

export const statusCommand = cli({
    site: 'auth', name: 'status', access: 'read',
    description: 'Check authentication on a separate page without disturbing retained login pages',
    strategy: Strategy.COOKIE,
    browser: args => { authOptions(args); return true; }, navigateBefore: false,
    args: [platformArg],
    columns: ['status', 'platform', 'identity', 'url', 'reason', 'message'],
    validateArgs: args => { authOptions(args); },
    func: async (page, args) => {
        const { key, recipe } = authOptions(args);
        try {
            await page.goto(recipe.homeUrl, { stealth: false });
            await page.wait({ time: 2 });
        } catch {
            return [statusRow(key, recipe, { status: 'unknown', identity: '', reason: 'navigation-failed' })];
        }
        let check = await checkRecipe(page, recipe);
        // One bounded retry: the first probe can land before a slow SPA hydrates
        // its account model (Juejin needed ~22s to become confirmable in `login`).
        // `login-in-progress` is excluded: that state is waiting for the human,
        // not for hydration.
        if (check.status === 'unknown' && (check.reason === 'account-model-unavailable' || check.reason === 'probe-unavailable')) {
            await page.wait({ time: 2 });
            check = await checkRecipe(page, recipe);
        }
        return [statusRow(key, recipe, check)];
    },
});
