// github search — multi-dimension repository search over the public GitHub
// REST API (`/search/repositories`).
//
// Dimensions map to GitHub search qualifiers server-side (stars, forks,
// language, topic, license, size, created, pushed, owner) so filtering happens
// before results are paged.
//
// The watch dimension is the exception. GitHub's search index has NO watcher
// qualifier — `watchers:`/`followers:` are aliases for the star count — and
// search rows report `watchers_count` as a mirror of `stargazers_count`. The
// real watch count only exists as `subscribers_count` on the repo endpoint, so
// `--watchers` / `--sort watchers` scan a candidate pool and enrich each row
// with one extra API call apiece. See `--scan`.
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, EmptyResultError } from '@sovovs/bycli/errors';
import {
    GITHUB_API,
    buildDateQualifier,
    buildRangeQualifier,
    githubFetch,
    requireBoundedInt,
} from './utils.js';

const MAX_LIMIT = 100; // GitHub caps per_page at 100 for search
const MAX_SCAN = 100;
const ENRICH_CONCURRENCY = 5;
// GitHub's search index never returns past result 1000, regardless of per_page.
const MAX_SEARCH_WINDOW = 1000;

/** Server-side sorts GitHub understands; `best-match` means "omit the param". */
const SERVER_SORTS = new Set(['stars', 'forks', 'updated', 'help-wanted-issues']);

/** Split a comma-separated arg into trimmed, non-empty terms. */
function splitTerms(value) {
    return String(value ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Quote a qualifier value when it contains whitespace, so
 * `--license "MIT License"` doesn't split into two qualifiers.
 */
function quoteIfNeeded(value) {
    return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * Turn a `--watchers` value into a local predicate.
 *
 * Reuses `buildRangeQualifier` for validation so the accepted syntax can't
 * drift from the server-side range flags.
 */
export function compileWatchersPredicate(value) {
    const qualifier = buildRangeQualifier('watchers', value);
    const expr = qualifier.slice('watchers:'.length);
    let m;
    if ((m = expr.match(/^>=(\d+)$/))) return (n) => n >= Number(m[1]);
    if ((m = expr.match(/^>(\d+)$/))) return (n) => n > Number(m[1]);
    if ((m = expr.match(/^<=(\d+)$/))) return (n) => n <= Number(m[1]);
    if ((m = expr.match(/^<(\d+)$/))) return (n) => n < Number(m[1]);
    if ((m = expr.match(/^(\d+)\.\.(\d+)$/))) return (n) => n >= Number(m[1]) && n <= Number(m[2]);
    if ((m = expr.match(/^(\d+)\.\.\*$/))) return (n) => n >= Number(m[1]);
    if ((m = expr.match(/^\*\.\.(\d+)$/))) return (n) => n <= Number(m[1]);
    // buildRangeQualifier already rejected anything else.
    throw new ArgumentError(`github --watchers value "${value}" is not a valid numeric filter`);
}

/** Assemble the `q=` search expression from free text plus every dimension. */
export function buildQuery(args = {}) {
    const parts = [];
    const freeText = String(args.query ?? '').trim();
    if (freeText) parts.push(freeText);

    for (const [flag, field] of [['stars', 'stars'], ['forks', 'forks'], ['issues', 'good-first-issues'], ['size', 'size']]) {
        if (args[flag] != null && String(args[flag]).trim()) {
            parts.push(buildRangeQualifier(field, args[flag]));
        }
    }
    for (const [flag, field] of [['pushed', 'pushed'], ['created', 'created']]) {
        if (args[flag] != null && String(args[flag]).trim()) {
            parts.push(buildDateQualifier(field, args[flag]));
        }
    }
    for (const [flag, field] of [['language', 'language'], ['topic', 'topic'], ['license', 'license']]) {
        for (const term of splitTerms(args[flag])) {
            parts.push(`${field}:${quoteIfNeeded(term)}`);
        }
    }
    for (const term of splitTerms(args.owner)) {
        parts.push(`user:${term}`);
    }
    if (args.in) {
        const fields = splitTerms(args.in);
        const allowed = new Set(['name', 'description', 'readme', 'topics']);
        for (const f of fields) {
            if (!allowed.has(f)) {
                throw new ArgumentError(
                    `github --in value "${f}" is not searchable`,
                    'GitHub restricts free-text scope to: name, description, readme, topics.',
                );
            }
        }
        if (fields.length) parts.push(`in:${fields.join(',')}`);
    }
    // GitHub excludes forks from search by default; archived repos are included.
    if (args['include-forks']) parts.push('fork:true');
    if (!args['include-archived']) parts.push('archived:false');

    // `archived:false` alone is a valid GitHub query but would silently return
    // "every non-archived repo", which is never what the caller meant.
    const meaningful = parts.filter((p) => p !== 'archived:false' && p !== 'fork:true');
    if (!meaningful.length) {
        throw new ArgumentError(
            'github search needs a query or at least one filter',
            'Pass a keyword, or a dimension such as --stars ">10000" --language rust --topic cli.',
        );
    }
    return parts.join(' ');
}

/** Run `mapper` over `items` with a bounded number of in-flight requests. */
async function mapWithConcurrency(items, concurrency, mapper) {
    const out = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length) {
            const i = cursor++;
            out[i] = await mapper(items[i], i);
        }
    });
    await Promise.all(workers);
    return out;
}

/**
 * Fetch the real watch count (`subscribers_count`) for each row.
 *
 * One core-API call per repo. Failures degrade to `null` rather than killing
 * the whole search — a single deleted/renamed repo shouldn't lose 99 good rows.
 */
async function enrichWatchers(rows) {
    return mapWithConcurrency(rows, ENRICH_CONCURRENCY, async (row) => {
        try {
            const detail = await githubFetch(
                `${GITHUB_API}/repos/${row.full_name}`,
                'github search (watch count)',
                { allow404: false },
            );
            return { ...row, watchers: detail?.subscribers_count != null ? Number(detail.subscribers_count) : null };
        }
        catch {
            return { ...row, watchers: null };
        }
    });
}

/** Shape one raw search item into an output row. */
function toRow(item) {
    return {
        rank: 0, // assigned after filtering/sorting
        full_name: String(item?.full_name ?? ''),
        stars: item?.stargazers_count != null ? Number(item.stargazers_count) : null,
        forks: item?.forks_count != null ? Number(item.forks_count) : null,
        // Deliberately null: the search payload's `watchers_count` is a copy of
        // the star count, not a watch count. Only enrichment fills this in.
        watchers: null,
        language: String(item?.language ?? ''),
        description: String(item?.description ?? '').trim(),
        license: String(item?.license?.spdx_id ?? ''),
        topics: Array.isArray(item?.topics) ? item.topics.join(', ') : '',
        open_issues: item?.open_issues_count != null ? Number(item.open_issues_count) : null,
        pushed: String(item?.pushed_at ?? '').slice(0, 10),
        url: String(item?.html_url ?? (item?.full_name ? `https://github.com/${item.full_name}` : '')),
    };
}

cli({
    site: 'github',
    name: 'search',
    access: 'read',
    description: 'Search GitHub repositories by stars, forks, watchers, language, topic and more',
    domain: 'api.github.com',
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
        { name: 'query', positional: true, required: false, help: 'Free-text keyword; optional when at least one filter flag is given' },
        { name: 'stars', help: 'Star count filter: "5000" (>=), ">10000", "<500", "1000..5000"' },
        { name: 'forks', help: 'Fork count filter, same syntax as --stars' },
        { name: 'watchers', help: 'Watch count filter, same syntax as --stars (client-side; costs 1 API call per scanned repo)' },
        { name: 'language', help: 'Primary language, comma-separated for multiple (e.g. "rust,go")' },
        { name: 'topic', help: 'Repository topic, comma-separated for multiple (e.g. "cli,devtools")' },
        { name: 'license', help: 'License keyword (e.g. "mit", "apache-2.0")' },
        { name: 'size', help: 'Repo size in KB: "1000" (>=), "<500", "100..1000"' },
        { name: 'pushed', help: 'Last push date: "2026-01-01" (>=), ">2026-01-01", "2025-01-01..2026-01-01"' },
        { name: 'created', help: 'Creation date, same syntax as --pushed' },
        { name: 'issues', help: 'Good-first-issue count filter, same syntax as --stars' },
        { name: 'owner', help: 'Restrict to owners/orgs, comma-separated (e.g. "facebook,vercel")' },
        { name: 'in', help: 'Restrict free-text match to: name, description, readme, topics (comma-separated)' },
        { name: 'include-forks', type: 'bool', default: false, help: 'Include forked repos (GitHub excludes them by default)' },
        { name: 'include-archived', type: 'bool', default: false, help: 'Include archived repos' },
        {
            name: 'sort',
            default: 'best-match',
            choices: ['best-match', 'stars', 'forks', 'watchers', 'updated', 'help-wanted-issues'],
            help: 'Ranking dimension; "watchers" sorts client-side and enriches every scanned row',
        },
        { name: 'order', default: 'desc', choices: ['desc', 'asc'], help: 'Sort direction' },
        { name: 'limit', type: 'int', default: 20, help: 'Max results (1-100)' },
        { name: 'page', type: 'int', default: 1, help: 'Result page; GitHub never serves past result 1000' },
        { name: 'scan', type: 'int', default: 30, help: 'Candidate pool size when filtering/sorting by watchers (1-100, one API call each)' },
        { name: 'with-watchers', type: 'bool', default: false, help: 'Add the real watch count column without filtering on it' },
    ],
    columns: ['rank', 'full_name', 'stars', 'forks', 'watchers', 'language', 'description', 'license', 'topics', 'open_issues', 'pushed', 'url'],
    func: async (args) => {
        const limit = requireBoundedInt(args.limit, 20, MAX_LIMIT);
        const page = requireBoundedInt(args.page, 1, MAX_SEARCH_WINDOW);
        const sort = String(args.sort ?? 'best-match');
        const order = String(args.order ?? 'desc') === 'asc' ? 'asc' : 'desc';
        const wantsWatchers = Boolean(args.watchers) || Boolean(args['with-watchers']) || sort === 'watchers';
        const q = buildQuery(args);

        // Watch-count work happens client-side, so pull a larger candidate pool
        // to filter/sort down from. Everything else is filtered by GitHub.
        const scan = wantsWatchers ? requireBoundedInt(args.scan, 30, MAX_SCAN, 'scan') : limit;
        const perPage = wantsWatchers ? Math.max(scan, limit) : limit;

        if (page * perPage > MAX_SEARCH_WINDOW) {
            throw new ArgumentError(
                `github search cannot reach page ${page} at ${perPage} results per page`,
                `GitHub's search index stops at result ${MAX_SEARCH_WINDOW}; narrow the query with more filters instead.`,
            );
        }

        const url = new URL(`${GITHUB_API}/search/repositories`);
        url.searchParams.set('q', q);
        url.searchParams.set('per_page', String(Math.min(perPage, MAX_LIMIT)));
        url.searchParams.set('page', String(page));
        // `best-match` is GitHub's default and is expressed by omitting `sort`.
        if (SERVER_SORTS.has(sort)) {
            url.searchParams.set('sort', sort);
            url.searchParams.set('order', order);
        }
        else if (sort === 'watchers') {
            // No server-side watch sort exists; rank the pool by stars so the
            // scanned candidates are the plausible ones, then re-sort locally.
            url.searchParams.set('sort', 'stars');
            url.searchParams.set('order', 'desc');
        }

        const body = await githubFetch(url.toString(), 'github search');
        const items = Array.isArray(body?.items) ? body.items : [];
        if (!items.length) {
            throw new EmptyResultError('github search', `No GitHub repositories matched "${q}".`);
        }

        let rows = items.map(toRow).filter((r) => r.full_name);
        if (wantsWatchers) {
            rows = await enrichWatchers(rows.slice(0, scan));
            if (args.watchers != null && String(args.watchers).trim()) {
                const pred = compileWatchersPredicate(args.watchers);
                rows = rows.filter((r) => r.watchers != null && pred(r.watchers));
            }
            if (sort === 'watchers') {
                rows.sort((a, b) => (order === 'asc'
                    ? (a.watchers ?? Infinity) - (b.watchers ?? Infinity)
                    : (b.watchers ?? -1) - (a.watchers ?? -1)));
            }
        }

        rows = rows.slice(0, limit);
        if (!rows.length) {
            throw new EmptyResultError(
                'github search',
                `No repositories in the top ${scan} results for "${q}" matched --watchers ${args.watchers}. Raise --scan or loosen the filter.`,
            );
        }
        return rows.map((r, i) => ({ ...r, rank: i + 1 }));
    },
});
