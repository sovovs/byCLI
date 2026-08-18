// github repo — single-repository metadata from `/repos/{owner}/{repo}`.
//
// Pairs with `github search`: the `full_name` column from a search row goes
// straight into this command's positional argument. This is also the only
// endpoint that reports a true watch count (`subscribers_count`); the search
// index does not carry it.
import { cli, Strategy } from '@sovovs/bycli/registry';
import { GITHUB_API, githubFetch, requireFullName } from './utils.js';

cli({
    site: 'github',
    name: 'repo',
    access: 'read',
    description: 'Single-repository metadata including the true watch count',
    domain: 'api.github.com',
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
        { name: 'repo', positional: true, required: true, help: 'Repository as "owner/repo" (the full_name column from search) or its github.com URL' },
    ],
    columns: ['full_name', 'stars', 'forks', 'watchers', 'open_issues', 'language', 'description', 'license', 'topics', 'homepage', 'default_branch', 'archived', 'is_fork', 'size_kb', 'created', 'pushed', 'url'],
    func: async (args) => {
        const fullName = requireFullName(args.repo);
        const r = await githubFetch(`${GITHUB_API}/repos/${fullName}`, `github repo ${fullName}`);
        return [{
            full_name: String(r?.full_name ?? fullName),
            stars: r?.stargazers_count != null ? Number(r.stargazers_count) : null,
            forks: r?.forks_count != null ? Number(r.forks_count) : null,
            // `subscribers_count` is the watch count. `watchers_count` on this
            // payload is a legacy alias for the star count — do not use it.
            watchers: r?.subscribers_count != null ? Number(r.subscribers_count) : null,
            open_issues: r?.open_issues_count != null ? Number(r.open_issues_count) : null,
            language: String(r?.language ?? ''),
            description: String(r?.description ?? '').trim(),
            license: String(r?.license?.spdx_id ?? ''),
            topics: Array.isArray(r?.topics) ? r.topics.join(', ') : '',
            homepage: String(r?.homepage ?? ''),
            default_branch: String(r?.default_branch ?? ''),
            archived: Boolean(r?.archived),
            is_fork: Boolean(r?.fork),
            size_kb: r?.size != null ? Number(r.size) : null,
            created: String(r?.created_at ?? '').slice(0, 10),
            pushed: String(r?.pushed_at ?? '').slice(0, 10),
            url: String(r?.html_url ?? `https://github.com/${fullName}`),
        }];
    },
});
