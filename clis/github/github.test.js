import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError, RateLimitedError } from '@sovovs/bycli/errors';
import './search.js';
import './repo.js';
import { buildQuery, compileWatchersPredicate } from './search.js';
import { buildDateQualifier, buildRangeQualifier, requireFullName } from './utils.js';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
});

/** One raw `/search/repositories` item, shaped like the real payload. */
function searchItem(overrides = {}) {
    return {
        full_name: 'facebook/react',
        stargazers_count: 247340,
        // The real API mirrors the star count here — it is NOT a watch count.
        watchers_count: 247340,
        forks_count: 51239,
        open_issues_count: 278,
        language: 'JavaScript',
        description: 'The library for web and native user interfaces.',
        license: { spdx_id: 'MIT' },
        topics: ['javascript', 'react', 'ui'],
        pushed_at: '2026-08-17T21:13:55Z',
        html_url: 'https://github.com/facebook/react',
        ...overrides,
    };
}

function jsonResponse(body, init = {}) {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: init.headers,
    });
}

describe('github search query construction', () => {
    it('maps every dimension onto a GitHub qualifier', () => {
        const q = buildQuery({
            query: 'http client',
            stars: '>10000',
            forks: '100..5000',
            language: 'rust,go',
            topic: 'cli',
            license: 'mit',
            size: '<50000',
            pushed: '2026-01-01',
            created: '2020-01-01..2024-01-01',
            issues: '5',
            owner: 'vercel',
        });
        expect(q).toContain('http client');
        expect(q).toContain('stars:>10000');
        expect(q).toContain('forks:100..5000');
        expect(q).toContain('language:rust');
        expect(q).toContain('language:go');
        expect(q).toContain('topic:cli');
        expect(q).toContain('license:mit');
        expect(q).toContain('size:<50000');
        expect(q).toContain('pushed:>=2026-01-01');
        expect(q).toContain('created:2020-01-01..2024-01-01');
        expect(q).toContain('good-first-issues:>=5');
        expect(q).toContain('user:vercel');
    });

    it('reads a bare number as ">=N" rather than an exact match', () => {
        // "at least 1000 stars" is what people mean; stars:1000 matches only 1000.
        expect(buildQuery({ stars: '1000' })).toContain('stars:>=1000');
        expect(buildRangeQualifier('stars', '  1000 ')).toBe('stars:>=1000');
        expect(buildRangeQualifier('stars', '>500')).toBe('stars:>500');
        expect(buildRangeQualifier('stars', '<=500')).toBe('stars:<=500');
        expect(buildRangeQualifier('stars', '10..*')).toBe('stars:10..*');
        expect(buildRangeQualifier('stars', '*..10')).toBe('stars:*..10');
        expect(buildRangeQualifier('stars', '')).toBe('');
    });

    it('rejects malformed numeric and date filters before any request', () => {
        expect(() => buildRangeQualifier('stars', 'abc')).toThrow(ArgumentError);
        expect(() => buildRangeQualifier('stars', '10..')).toThrow(ArgumentError);
        expect(() => buildRangeQualifier('stars', '-5')).toThrow(ArgumentError);
        expect(() => buildDateQualifier('pushed', '2026-13')).toThrow(ArgumentError);
        expect(() => buildDateQualifier('pushed', 'yesterday')).toThrow(ArgumentError);
        expect(buildDateQualifier('pushed', '>2026-01-01')).toBe('pushed:>2026-01-01');
        expect(buildDateQualifier('pushed', '2026-01-01..*')).toBe('pushed:2026-01-01..*');
    });

    it('excludes archived repos by default and includes forks only on request', () => {
        expect(buildQuery({ query: 'cli' })).toContain('archived:false');
        expect(buildQuery({ query: 'cli' })).not.toContain('fork:true');
        expect(buildQuery({ query: 'cli', 'include-archived': true })).not.toContain('archived:false');
        expect(buildQuery({ query: 'cli', 'include-forks': true })).toContain('fork:true');
    });

    it('requires a keyword or at least one real filter', () => {
        // `archived:false` on its own is valid GitHub syntax but would return
        // "every repo", so it must not count as a meaningful filter.
        expect(() => buildQuery()).toThrow(ArgumentError);
        expect(() => buildQuery({ query: '   ' })).toThrow(ArgumentError);
        expect(() => buildQuery({ 'include-archived': true })).toThrow(ArgumentError);
        expect(() => buildQuery({ stars: '>1' })).not.toThrow();
    });

    it('quotes qualifier values containing whitespace', () => {
        expect(buildQuery({ query: 'x', license: 'MIT License' })).toContain('license:"MIT License"');
    });

    it('restricts --in to fields GitHub actually searches', () => {
        expect(buildQuery({ query: 'x', in: 'name,readme' })).toContain('in:name,readme');
        expect(() => buildQuery({ query: 'x', in: 'body' })).toThrow(ArgumentError);
    });
});

describe('github search watch-count handling', () => {
    const cmd = getRegistry().get('github/search');

    it('never reports the search payload watchers_count as a watch count', async () => {
        // Regression guard: GitHub sets watchers_count === stargazers_count in
        // search results. Copying it would silently duplicate the star column.
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [searchItem()] })));
        const rows = await cmd.func({ query: 'react', limit: 5 });
        expect(rows[0].stars).toBe(247340);
        expect(rows[0].watchers).toBeNull();
    });

    it('enriches the watch count from subscribers_count on the repo endpoint', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ items: [searchItem()] }))
            .mockResolvedValueOnce(jsonResponse({ subscribers_count: 6601, watchers_count: 247340 }));
        vi.stubGlobal('fetch', fetchMock);

        const rows = await cmd.func({ query: 'react', limit: 5, 'with-watchers': true });
        expect(rows[0].watchers).toBe(6601);
        expect(rows[0].stars).toBe(247340);
        expect(fetchMock.mock.calls[1][0]).toBe('https://api.github.com/repos/facebook/react');
    });

    it('filters client-side on the enriched watch count', async () => {
        const items = [
            searchItem({ full_name: 'a/one' }),
            searchItem({ full_name: 'b/two' }),
            searchItem({ full_name: 'c/three' }),
        ];
        const subs = { 'a/one': 9000, 'b/two': 50, 'c/three': 4000 };
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            if (String(url).includes('/search/repositories')) return jsonResponse({ items });
            const name = String(url).replace('https://api.github.com/repos/', '');
            return jsonResponse({ subscribers_count: subs[name] });
        }));

        const rows = await cmd.func({ query: 'x', watchers: '>=1000', limit: 10, scan: 10 });
        expect(rows.map((r) => r.full_name)).toEqual(['a/one', 'c/three']);
        expect(rows.map((r) => r.rank)).toEqual([1, 2]);
    });

    it('sorts by the enriched watch count, not by stars', async () => {
        const items = [
            searchItem({ full_name: 'a/one', stargazers_count: 300 }),
            searchItem({ full_name: 'b/two', stargazers_count: 200 }),
            searchItem({ full_name: 'c/three', stargazers_count: 100 }),
        ];
        const subs = { 'a/one': 10, 'b/two': 900, 'c/three': 500 };
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            if (String(url).includes('/search/repositories')) return jsonResponse({ items });
            return jsonResponse({ subscribers_count: subs[String(url).replace('https://api.github.com/repos/', '')] });
        }));

        const desc = await cmd.func({ query: 'x', sort: 'watchers', limit: 10, scan: 10 });
        expect(desc.map((r) => r.full_name)).toEqual(['b/two', 'c/three', 'a/one']);

        const asc = await cmd.func({ query: 'x', sort: 'watchers', order: 'asc', limit: 10, scan: 10 });
        expect(asc.map((r) => r.full_name)).toEqual(['a/one', 'c/three', 'b/two']);
    });

    it('keeps the other rows when one enrichment call fails', async () => {
        const items = [searchItem({ full_name: 'a/one' }), searchItem({ full_name: 'b/two' })];
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            if (String(url).includes('/search/repositories')) return jsonResponse({ items });
            if (String(url).endsWith('a/one')) return new Response('boom', { status: 500 });
            return jsonResponse({ subscribers_count: 42 });
        }));

        const rows = await cmd.func({ query: 'x', limit: 10, scan: 10, 'with-watchers': true });
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.full_name === 'a/one').watchers).toBeNull();
        expect(rows.find((r) => r.full_name === 'b/two').watchers).toBe(42);
    });

    it('explains an empty watch-filtered result in terms of the scan pool', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).includes('/search/repositories')
            ? jsonResponse({ items: [searchItem()] })
            : jsonResponse({ subscribers_count: 1 }))));
        await expect(cmd.func({ query: 'x', watchers: '>=100000', scan: 5 })).rejects.toThrow(EmptyResultError);
    });

    it('compiles every supported watch predicate form', () => {
        expect(compileWatchersPredicate('100')(100)).toBe(true);
        expect(compileWatchersPredicate('100')(99)).toBe(false);
        expect(compileWatchersPredicate('>100')(100)).toBe(false);
        expect(compileWatchersPredicate('<=10')(10)).toBe(true);
        expect(compileWatchersPredicate('<10')(10)).toBe(false);
        expect(compileWatchersPredicate('10..20')(15)).toBe(true);
        expect(compileWatchersPredicate('10..20')(21)).toBe(false);
        expect(compileWatchersPredicate('10..*')(1e6)).toBe(true);
        expect(compileWatchersPredicate('*..10')(5)).toBe(true);
        expect(() => compileWatchersPredicate('lots')).toThrow(ArgumentError);
    });
});

describe('github search request shaping', () => {
    const cmd = getRegistry().get('github/search');

    /** Capture the search URL the adapter builds. */
    async function captureUrl(args) {
        let seen = '';
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            if (String(url).includes('/search/repositories')) {
                seen = String(url);
                return jsonResponse({ items: [searchItem()] });
            }
            return jsonResponse({ subscribers_count: 1 });
        }));
        await cmd.func(args);
        return new URL(seen);
    }

    it('omits the sort param for best-match (GitHub default)', async () => {
        const url = await captureUrl({ query: 'react', limit: 3 });
        expect(url.searchParams.get('sort')).toBeNull();
        expect(url.searchParams.get('per_page')).toBe('3');
        expect(url.searchParams.get('page')).toBe('1');
    });

    it('passes server-side sorts straight through with order', async () => {
        const url = await captureUrl({ query: 'react', sort: 'forks', order: 'asc', limit: 3 });
        expect(url.searchParams.get('sort')).toBe('forks');
        expect(url.searchParams.get('order')).toBe('asc');
    });

    it('falls back to a stars-ranked pool for the watchers sort', async () => {
        // There is no server-side watch sort, so the candidate pool is ranked by
        // stars and re-sorted locally after enrichment.
        const url = await captureUrl({ query: 'react', sort: 'watchers', limit: 3, scan: 25 });
        expect(url.searchParams.get('sort')).toBe('stars');
        expect(url.searchParams.get('order')).toBe('desc');
        expect(url.searchParams.get('per_page')).toBe('25');
    });

    it('widens per_page to the scan pool when watch data is needed', async () => {
        const url = await captureUrl({ query: 'react', limit: 5, scan: 40, 'with-watchers': true });
        expect(url.searchParams.get('per_page')).toBe('40');
    });

    it('validates limit, page and scan bounds', async () => {
        vi.stubGlobal('fetch', vi.fn());
        await expect(cmd.func({ query: 'x', limit: 0 })).rejects.toThrow(ArgumentError);
        await expect(cmd.func({ query: 'x', limit: 101 })).rejects.toThrow(ArgumentError);
        await expect(cmd.func({ query: 'x', limit: 2.5 })).rejects.toThrow(ArgumentError);
        await expect(cmd.func({ query: 'x', scan: 101, watchers: '>1' })).rejects.toThrow(ArgumentError);
    });

    it('refuses pages beyond GitHub\'s 1000-result search window', async () => {
        vi.stubGlobal('fetch', vi.fn());
        await expect(cmd.func({ query: 'x', limit: 100, page: 11 })).rejects.toThrow(/1000|cannot reach page/);
    });

    it('sends an Accept and User-Agent header, and a bearer token when set', async () => {
        process.env.GITHUB_TOKEN = 'ghp_example';
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [searchItem()] }));
        vi.stubGlobal('fetch', fetchMock);
        await cmd.func({ query: 'react', limit: 1 });
        const headers = fetchMock.mock.calls[0][1].headers;
        expect(headers.accept).toBe('application/vnd.github+json');
        expect(headers['user-agent']).toContain('bycli');
        expect(headers.authorization).toBe('Bearer ghp_example');
    });

    it('omits the authorization header when no token is configured', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [searchItem()] }));
        vi.stubGlobal('fetch', fetchMock);
        await cmd.func({ query: 'react', limit: 1 });
        expect(fetchMock.mock.calls[0][1].headers.authorization).toBeUndefined();
    });
});

describe('github API error mapping', () => {
    const cmd = getRegistry().get('github/search');

    it('maps an exhausted rate limit to RateLimitedError', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1787020228' },
        })));
        await expect(cmd.func({ query: 'react' })).rejects.toThrow(RateLimitedError);
    });

    it('maps HTTP 429 to RateLimitedError', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })));
        await expect(cmd.func({ query: 'react' })).rejects.toThrow(RateLimitedError);
    });

    it('maps a non-quota 403 to CommandExecutionError', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
            status: 403,
            headers: { 'x-ratelimit-remaining': '58' },
        })));
        await expect(cmd.func({ query: 'react' })).rejects.toThrow(CommandExecutionError);
    });

    it('maps a 422 validation failure to ArgumentError with the field name', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            message: 'Validation Failed',
            errors: [{ resource: 'Search', field: 'q', code: 'missing' }],
        }, { status: 422 })));
        await expect(cmd.func({ query: 'react' })).rejects.toThrow(ArgumentError);
        await expect(cmd.func({ query: 'react' })).rejects.toThrow(/q/);
    });

    it('maps zero search hits to EmptyResultError', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ total_count: 0, items: [] })));
        await expect(cmd.func({ query: 'zzzz' })).rejects.toThrow(EmptyResultError);
    });

    it('maps malformed JSON to CommandExecutionError', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
        await expect(cmd.func({ query: 'react' })).rejects.toThrow(CommandExecutionError);
    });

    it('maps a network failure to CommandExecutionError', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
        await expect(cmd.func({ query: 'react' })).rejects.toThrow(CommandExecutionError);
    });
});

describe('github repo', () => {
    const cmd = getRegistry().get('github/repo');

    it('reports subscribers_count as the watch count, not watchers_count', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            full_name: 'facebook/react',
            stargazers_count: 247340,
            watchers_count: 247340, // legacy star alias
            subscribers_count: 6601,
            forks_count: 51239,
            open_issues_count: 278,
            language: 'JavaScript',
            license: { spdx_id: 'MIT' },
            topics: ['react'],
            size: 1000,
            fork: false,
            archived: false,
            created_at: '2013-05-24T16:15:54Z',
            pushed_at: '2026-08-17T21:13:55Z',
            html_url: 'https://github.com/facebook/react',
        })));

        const [row] = await cmd.func({ repo: 'facebook/react' });
        expect(row.watchers).toBe(6601);
        expect(row.stars).toBe(247340);
        expect(row.forks).toBe(51239);
        expect(row.license).toBe('MIT');
        expect(row.archived).toBe(false);
    });

    it('accepts a github.com URL and normalizes it to owner/repo', () => {
        expect(requireFullName('https://github.com/facebook/react')).toBe('facebook/react');
        expect(requireFullName('https://github.com/facebook/react.git')).toBe('facebook/react');
        expect(requireFullName('https://www.github.com/facebook/react/')).toBe('facebook/react');
        expect(requireFullName('  facebook/react ')).toBe('facebook/react');
    });

    it('rejects malformed repo names before fetching', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await expect(cmd.func({ repo: '' })).rejects.toThrow(ArgumentError);
        await expect(cmd.func({ repo: 'react' })).rejects.toThrow(ArgumentError);
        await expect(cmd.func({ repo: 'a/b/c' })).rejects.toThrow(ArgumentError);
        await expect(cmd.func({ repo: 'has space/repo' })).rejects.toThrow(ArgumentError);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('maps a missing repo to EmptyResultError', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
        await expect(cmd.func({ repo: 'nope/nope' })).rejects.toThrow(EmptyResultError);
    });
});

describe('github command metadata', () => {
    it('registers both commands as read-only public non-browser commands', () => {
        for (const key of ['github/search', 'github/repo']) {
            const cmd = getRegistry().get(key);
            expect(cmd, key).toBeTruthy();
            expect(cmd.access).toBe('read');
            expect(cmd.browser).toBe(false);
            expect(cmd.domain).toBe('api.github.com');
        }
    });

    it('exposes the star / fork / watch dimensions as columns', () => {
        const cmd = getRegistry().get('github/search');
        expect(cmd.columns).toEqual([
            'rank', 'full_name', 'stars', 'forks', 'watchers', 'language',
            'description', 'license', 'topics', 'open_issues', 'pushed', 'url',
        ]);
    });

    it('round-trips full_name from search into the repo positional', () => {
        const search = getRegistry().get('github/search');
        const repo = getRegistry().get('github/repo');
        expect(search.columns).toContain('full_name');
        const positional = repo.args.find((a) => a.positional);
        expect(positional.name).toBe('repo');
        expect(positional.required).toBe(true);
        expect(positional.help).toBeTruthy();
    });

    it('gives every positional arg non-empty help text (build gate)', () => {
        for (const key of ['github/search', 'github/repo']) {
            for (const arg of getRegistry().get(key).args.filter((a) => a.positional)) {
                expect(String(arg.help ?? '').trim(), `${key}/${arg.name}`).not.toBe('');
            }
        }
    });

    it('offers the watchers dimension in both filter and sort form', () => {
        const cmd = getRegistry().get('github/search');
        expect(cmd.args.map((a) => a.name)).toContain('watchers');
        expect(cmd.args.find((a) => a.name === 'sort').choices).toContain('watchers');
    });
});
