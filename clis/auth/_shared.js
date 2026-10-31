import { ArgumentError, CliError } from '@sovovs/bycli/errors';
import { getRecipe, listRecipes } from './_recipes.js';

export const platformArg = {
    name: 'platform', type: 'string', required: true, positional: true,
    help: `Platform: ${listRecipes().map(r => r.platform).join(', ')}`,
};

export function authOptions(args, login = false) {
    const found = getRecipe(args?.platform);
    if (!found) throw new ArgumentError('Unknown platform. Supported: ' + listRecipes().map(r => r.platform).join(', '));
    const timeout = args?.timeout ?? 180;
    if (login && (!Number.isInteger(timeout) || timeout < 30 || timeout > 900)) {
        throw new ArgumentError('--timeout must be an integer between 30 and 900 seconds');
    }
    return { ...found, timeout };
}

export function unwrap(payload) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)
        && Object.hasOwn(payload, 'session') && Object.hasOwn(payload, 'data')) return payload.data;
    return payload;
}

export function isHome(url, recipe) {
    try { return new URL(url).origin === new URL(recipe.homeUrl).origin; }
    catch { return false; }
}

function isAllowed(url, recipe) {
    try {
        const origin = new URL(url).origin;
        return origin === new URL(recipe.homeUrl).origin || origin === new URL(recipe.loginUrl).origin;
    } catch { return false; }
}

// No navigation during polling: SSO and verification pages belong to the human.
export async function checkRecipe(page, recipe) {
    try {
        const url = unwrap(await page.evaluate('location.href'));
        if (typeof url !== 'string' || !isAllowed(url, recipe)) {
            return { status: 'unknown', identity: '', reason: 'unexpected-origin' };
        }
        if (!isHome(url, recipe)) {
            return { status: 'unknown', identity: '', reason: 'login-in-progress' };
        }
        // Re-check the origin in the same evaluation as the probe: a human or
        // SSO redirect may have navigated since the preceding URL read.
        const result = unwrap(await page.evaluate(`(() => {
            if (location.origin !== ${JSON.stringify(new URL(recipe.homeUrl).origin)}) {
                return { status: 'unknown', reason: 'login-in-progress' };
            }
            return (${recipe.probe});
        })()`));
        if (!result || !['logged-in', 'logged-out', 'unknown'].includes(result.status)) {
            return { status: 'unknown', identity: '', reason: 'invalid-probe-result' };
        }
        const reason = ['account-model-unavailable', 'account-request-failed', 'account-response-unrecognized', 'login-in-progress'].includes(result.reason)
            ? result.reason : 'probe-unavailable';
        return {
            status: result.status,
            identity: result.status === 'logged-in' && typeof result.identity === 'string' ? result.identity.slice(0, 200) : '',
            reason: result.status === 'unknown' ? reason : '',
        };
    } catch {
        // Do not echo transport errors, URLs, cookie values or response bodies.
        return { status: 'unknown', identity: '', reason: 'probe-unavailable' };
    }
}

export async function openLoginPage(page, recipe) {
    const tabs = await page.tabs();
    if (tabs.length > 1) throw new CliError('PAGE_IN_USE', 'Multiple retained auth pages; close extra auth tabs before retrying.');
    if (tabs.length) {
        page.setActivePage(tabs[0].page);
        const url = unwrap(await page.evaluate('location.href'));
        if (url !== 'about:blank') {
            if (!isAllowed(url, recipe)) {
                throw new CliError('PAGE_IN_USE', 'Retained auth page is on a different origin; finish verification or close it before retrying.');
            }
            // A previously completed session may have expired. Only leave the
            // configured homepage after an explicit signed-out result; never
            // reset an existing login/verification path based on probe failure.
            if (new URL(url).pathname === new URL(recipe.homeUrl).pathname
                && isHome(url, recipe) && (await checkRecipe(page, recipe)).status === 'logged-out') {
                await page.goto(recipe.loginUrl, { stealth: false });
            }
            // Preserve a QR code, SSO hop, verification page or authenticated page.
            return;
        }
    }
    await page.goto(recipe.loginUrl, { stealth: false });
}

export function statusRow(key, recipe, check) {
    return {
        status: check.status, platform: key, identity: check.identity,
        // Stable configured URL only; SSO query strings can contain secrets.
        url: recipe.homeUrl,
        reason: check.reason,
        message: check.status === 'logged-in' ? 'Session is authenticated in the selected browser profile.'
            : check.status === 'logged-out' ? `Not authenticated. Run "bycli auth login ${key}".`
                : 'Authentication could not be confirmed. Inspect the browser or retry the status check.',
    };
}
