import { cli, Strategy } from '@sovovs/bycli/registry';
import { listRecipes } from './_recipes.js';

export const sitesCommand = cli({
    site: 'auth', name: 'sites', access: 'read',
    description: 'List authentication recipes and their live verification status',
    strategy: Strategy.PUBLIC, browser: false, args: [],
    columns: ['platform', 'label', 'surface', 'detection', 'verification', 'login_url'],
    // Detection and surface come from the recipe: they are per-site facts, not
    // constants to restate here.
    func: async () => listRecipes().map(r => ({
        platform: r.platform, label: r.label, surface: r.surface, detection: r.detection,
        verification: r.verification, login_url: r.loginUrl,
    })),
});
