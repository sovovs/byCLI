import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import './search.js';
import { __test__ } from './search.js';

const {
    TYPES,
    SORTS,
    PERIODS,
    EMPTY_RETRY_ATTEMPTS,
    requireQuery,
    requireChoice,
    requireLimit,
    toIsoTime,
    firstIsoTime,
    buildUrl,
    fetchPage,
    normalizeArticle,
    normalizeUser,
    normalizeTag,
    normalizeCourse,
    normalizeEntry,
} = __test__;

const cmd = getRegistry().get('juejin/search');

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function articleEntry(overrides = {}) {
    return {
        result_type: 2,
        result_model: {
            article_id: '6844903559335526407',
            article_info: {
                article_id: '6844903559335526407',
                title: 'Golang的反射reflect深入理解和示例',
                brief_content: '在计算机科学领域，反射是指一类应用',
                view_count: 84161,
                digg_count: 214,
                comment_count: 13,
                collect_count: 272,
                hot_index: 4435,
                ctime: '1517659397',
                rtime: '1517669176',
                is_original: 1,
                ...overrides.article_info,
            },
            author_user_info: { user_name: 'AllenWu', user_id: '1187128287436808' },
            category: { category_name: '后端' },
            tags: [{ tag_name: 'Go' }, { tag_name: 'API' }],
            ...overrides.result_model,
        },
    };
}

function userEntry() {
    return {
        result_type: 1,
        result_model: {
            user_id: '2893570303362430',
            user_name: 'haojiahuo',
            job_title: '十年前的程序员',
            company: '掘金',
            level: 2,
            description: 'Go 爱好者',
            follower_count: 127,
            post_article_count: 3,
            got_digg_count: 50,
            got_view_count: 8382,
        },
    };
}

function tagEntry() {
    return {
        result_type: 9,
        result_model: {
            tag_id: '6809641219875045383',
            tag: {
                tag_id: '6809641219875045383',
                tag_name: 'VuePress',
                ctime: 1562526695,
                post_article_count: 325,
                concern_user_count: 2201,
            },
        },
    };
}

function courseEntry() {
    return {
        result_type: 12,
        result_model: {
            booklet_id: '6844733833401597966',
            base_info: {
                booklet_id: '6844733833401597966',
                title: '漫画 Go 语言 纯手绘版',
                price: 2990,
                summary: '一个简单又好玩的学习方法',
                section_count: 14,
                read_time: 20097,
                buy_count: 2083,
                put_on_time: 1598288838,
            },
            user_info: { user_name: 'haojiahuo' },
        },
    };
}

// 按顺序返回每个 page，用完后固定重复最后一个（用于断言重试次数）。
function mockSequence(pages) {
    const queue = [...pages];
    const fetchMock = vi.fn(async () => {
        const page = queue.length > 0 ? queue.shift() : pages[pages.length - 1];
        return { ok: true, status: 200, json: async () => page };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function mockJson(pages) {
    const queue = [...pages];
    const fetchMock = vi.fn(async () => {
        const page = queue.length > 1 ? queue.shift() : queue[0];
        return {
            ok: true,
            status: 200,
            json: async () => page,
        };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('juejin/search registration', () => {
    it('registers a public no-browser command with the documented row shape', () => {
        expect(cmd?.strategy).toBe('public');
        expect(cmd?.browser).toBe(false);
        expect(cmd?.access).toBe('read');
        expect(cmd?.domain).toBe('api.juejin.cn');
        expect(cmd?.columns).toEqual([
            'rank', 'kind', 'id', 'title', 'author', 'views', 'likes',
            'comments', 'hot_index', 'published_at', 'url', 'extra',
        ]);
    });

    it('exposes query positional plus the three search dimensions', () => {
        const args = cmd?.args ?? [];
        expect(args.map((a) => a.name)).toEqual(['query', 'type', 'sort', 'period', 'limit']);
        const query = args.find((a) => a.name === 'query');
        expect(query?.required).toBe(true);
        expect(query?.positional).toBe(true);
        expect(args.find((a) => a.name === 'type')?.choices).toEqual(['all', 'article', 'course', 'tag', 'user']);
        expect(args.find((a) => a.name === 'sort')?.choices).toEqual(['relevance', 'newest', 'hottest']);
        expect(args.find((a) => a.name === 'period')?.choices).toEqual(['all', 'day', 'week', 'month3']);
    });

    it('maps CLI dimension names onto the juejin API enum values', () => {
        expect(TYPES).toEqual({ all: 0, article: 2, course: 12, tag: 9, user: 1 });
        expect(SORTS).toEqual({ relevance: 0, newest: 1, hottest: 2 });
        expect(PERIODS).toEqual({ all: 0, day: 1, week: 2, month3: 3 });
    });
});

describe('argument validation', () => {
    it('rejects an empty query', () => {
        expect(() => requireQuery('   ')).toThrow(ArgumentError);
        expect(() => requireQuery(undefined)).toThrow(ArgumentError);
        expect(requireQuery('  golang ')).toBe('golang');
    });

    it('rejects unknown dimension values instead of silently defaulting', () => {
        expect(() => requireChoice('pins', TYPES, 'type')).toThrow(ArgumentError);
        expect(() => requireChoice('oldest', SORTS, 'sort')).toThrow(ArgumentError);
        expect(() => requireChoice('year', PERIODS, 'period')).toThrow(ArgumentError);
        expect(requireChoice('hottest', SORTS, 'sort')).toBe(2);
        // sort=relevance / type=all / period=all 都映射到 0，不能被当成 falsy 漏掉
        expect(requireChoice('all', TYPES, 'type')).toBe(0);
    });

    it('rejects out-of-range limits instead of clamping', () => {
        expect(() => requireLimit(0)).toThrow(ArgumentError);
        expect(() => requireLimit(-3)).toThrow(ArgumentError);
        expect(() => requireLimit(2.5)).toThrow(ArgumentError);
        expect(() => requireLimit(201)).toThrow(ArgumentError);
        expect(requireLimit(undefined)).toBe(20);
        expect(requireLimit('50')).toBe(50);
    });
});

describe('URL construction', () => {
    it('sends period as search_type and sort as sort_type', () => {
        const url = new URL(buildUrl({ query: 'go lang', idType: 2, sortType: 2, period: 3, cursor: '20_abc' }));
        expect(url.origin + url.pathname).toBe('https://api.juejin.cn/search_api/v1/search');
        expect(url.searchParams.get('query')).toBe('go lang');
        expect(url.searchParams.get('id_type')).toBe('2');
        expect(url.searchParams.get('sort_type')).toBe('2');
        expect(url.searchParams.get('search_type')).toBe('3');
        expect(url.searchParams.get('cursor')).toBe('20_abc');
        expect(url.searchParams.get('limit')).toBe('20');
        expect(url.searchParams.get('aid')).toBe('2608');
    });
});

describe('timestamp decoding', () => {
    it('converts unix seconds to ISO and maps Go zero-time to null', () => {
        expect(toIsoTime('1517669176')).toBe('2018-02-03T14:46:16.000Z');
        expect(toIsoTime(-62135596800)).toBeNull();
        expect(toIsoTime(0)).toBeNull();
        expect(toIsoTime(undefined)).toBeNull();
    });

    it('falls through the Go zero-value sentinel, not just null/undefined', () => {
        // `rtime ?? ctime` would keep the sentinel and yield null here.
        expect(firstIsoTime(-62135596800, '1786601404')).toBe('2026-08-13T06:10:04.000Z');
        expect(firstIsoTime(undefined, '1786601404')).toBe('2026-08-13T06:10:04.000Z');
        expect(firstIsoTime('1517669176', '1786601404')).toBe('2018-02-03T14:46:16.000Z');
        expect(firstIsoTime(-62135596800, 0, undefined)).toBeNull();
    });

    it('keeps published_at populated for freshly posted articles (rtime unset)', () => {
        const model = articleEntry({ article_info: { rtime: '-62135596800', ctime: '1786601404' } }).result_model;
        expect(normalizeArticle(model).stamp).toBe('2026-08-13T06:10:04.000Z');
    });
});

describe('per-type normalization', () => {
    it('maps article rows onto the shared row shape', () => {
        const row = normalizeArticle(articleEntry().result_model);
        expect(row).toMatchObject({
            identity: '6844903559335526407',
            label: 'Golang的反射reflect深入理解和示例',
            byline: 'AllenWu',
            viewTotal: 84161,
            likeTotal: 214,
            commentTotal: 13,
            heat: 4435,
            link: 'https://juejin.cn/post/6844903559335526407',
        });
        expect(row.stamp).toBe('2018-02-03T14:46:16.000Z');
        // tags 折成字符串（不是数组）：row shape 门禁限制嵌套深度 <= 1。
        expect(row.aside).toMatchObject({ category: '后端', tags: 'Go,API', collect_count: 272, is_original: true });
    });

    it('returns null (not an empty string) when an article carries no tags', () => {
        const model = articleEntry({ result_model: { tags: [] } }).result_model;
        expect(normalizeArticle(model).aside.tags).toBeNull();
    });

    it('maps users with job/company byline and follower heat', () => {
        const row = normalizeUser(userEntry().result_model);
        expect(row).toMatchObject({
            identity: '2893570303362430',
            label: 'haojiahuo',
            byline: '十年前的程序员 @ 掘金',
            viewTotal: 8382,
            likeTotal: 50,
            commentTotal: null,
            heat: 127,
            stamp: null,
            link: 'https://juejin.cn/user/2893570303362430',
        });
        expect(row.aside).toMatchObject({ level: 2, post_article_count: 3 });
    });

    it('maps tags with url-encoded tag name and null metrics', () => {
        const row = normalizeTag(tagEntry().result_model);
        expect(row).toMatchObject({
            identity: '6809641219875045383',
            label: 'VuePress',
            viewTotal: null,
            likeTotal: null,
            heat: 2201,
        });
        expect(row.link).toBe('https://juejin.cn/tag/VuePress');
        expect(row.aside).toMatchObject({ post_article_count: 325, concern_user_count: 2201 });
    });

    it('url-encodes non-ascii tag names', () => {
        const model = tagEntry().result_model;
        model.tag.tag_name = '前端';
        expect(normalizeTag(model).link).toBe('https://juejin.cn/tag/%E5%89%8D%E7%AB%AF');
    });

    it('maps courses to /book/ urls and converts fen price to yuan', () => {
        const row = normalizeCourse(courseEntry().result_model);
        expect(row).toMatchObject({
            identity: '6844733833401597966',
            label: '漫画 Go 语言 纯手绘版',
            byline: 'haojiahuo',
            viewTotal: 20097,
            heat: 2083,
            link: 'https://juejin.cn/book/6844733833401597966',
        });
        expect(row.aside.price_yuan).toBe(29.9);
        expect(row.aside.section_count).toBe(14);
    });

    it('drops entries whose identity or title is missing', () => {
        expect(normalizeArticle({ article_info: { title: 'no id' } })).toBeNull();
        expect(normalizeArticle({ article_id: '1', article_info: { title: '' } })).toBeNull();
        expect(normalizeArticle({ article_id: '1' })).toBeNull();
        expect(normalizeUser({ user_id: '1' })).toBeNull();
        expect(normalizeTag({ tag_id: '1', tag: {} })).toBeNull();
        expect(normalizeCourse({ booklet_id: '1', base_info: {} })).toBeNull();
    });

    it('skips unknown result_type instead of throwing (forward compatible)', () => {
        expect(normalizeEntry({ result_type: 4, result_model: { pin_id: '1' } })).toBeNull();
        expect(normalizeEntry(null)).toBeNull();
        expect(normalizeEntry(articleEntry())?.resultKind).toBe('article');
        expect(normalizeEntry(userEntry())?.resultKind).toBe('user');
        expect(normalizeEntry(tagEntry())?.resultKind).toBe('tag');
        expect(normalizeEntry(courseEntry())?.resultKind).toBe('course');
    });
});

describe('transport error classification', () => {
    it('raises CommandExecutionError on non-2xx', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
        await expect(fetchPage('https://api.juejin.cn/x')).rejects.toThrow(CommandExecutionError);
    });

    it('raises CommandExecutionError when fetch throws', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
        await expect(fetchPage('https://api.juejin.cn/x')).rejects.toThrow(/ECONNRESET/);
    });

    it('raises CommandExecutionError on a business err_no', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ err_no: 403, err_msg: 'rate limited', data: [] }) })));
        await expect(fetchPage('https://api.juejin.cn/x')).rejects.toThrow(/rate limited/);
    });

    it('raises CommandExecutionError when data is not a list', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ err_no: 0, data: null }) })));
        await expect(fetchPage('https://api.juejin.cn/x')).rejects.toThrow(/malformed data list/);
    });

    it('raises CommandExecutionError on unparseable JSON', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad token'); } })));
        await expect(fetchPage('https://api.juejin.cn/x')).rejects.toThrow(/malformed JSON/);
    });
});

describe('end-to-end func behaviour', () => {
    it('returns mixed-type rows for the 综合 tab in column order', async () => {
        mockJson([{ err_no: 0, err_msg: 'success', data: [articleEntry(), tagEntry(), courseEntry(), userEntry()], cursor: '20_x', has_more: false }]);
        const rows = await cmd.func({ query: 'golang', type: 'all', sort: 'relevance', period: 'all', limit: 20 });
        expect(rows.map((r) => r.kind)).toEqual(['article', 'tag', 'course', 'user']);
        expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
        expect(Object.keys(rows[0])).toEqual(cmd.columns);
    });

    it('passes the selected dimensions through to the request', async () => {
        const fetchMock = mockJson([{ err_no: 0, data: [articleEntry()], cursor: '20_a', has_more: false }]);
        await cmd.func({ query: 'rust', type: 'article', sort: 'hottest', period: 'week', limit: 1 });
        const url = new URL(fetchMock.mock.calls[0][0]);
        expect(url.searchParams.get('id_type')).toBe('2');
        expect(url.searchParams.get('sort_type')).toBe('2');
        expect(url.searchParams.get('search_type')).toBe('2');
    });

    it('follows the cursor across pages and dedupes repeated ids', async () => {
        const dup = articleEntry();
        const other = articleEntry({ article_info: { article_id: '999', title: 'second' }, result_model: { article_id: '999' } });
        const fetchMock = mockJson([
            { err_no: 0, data: [dup], cursor: '20_p2', has_more: true },
            { err_no: 0, data: [dup, other], cursor: '40_p3', has_more: false },
        ]);
        const rows = await cmd.func({ query: 'golang', type: 'article', sort: 'relevance', period: 'all', limit: 20 });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('cursor')).toBe('0');
        expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('cursor')).toBe('20_p2');
        expect(rows.map((r) => r.id)).toEqual(['6844903559335526407', '999']);
    });

    it('stops paging and truncates exactly at limit', async () => {
        const page = {
            err_no: 0,
            has_more: true,
            cursor: '20_next',
            data: Array.from({ length: 20 }, (_, i) => articleEntry({
                article_info: { article_id: `id-${i}`, title: `t-${i}` },
                result_model: { article_id: `id-${i}` },
            })),
        };
        const fetchMock = mockJson([page]);
        const rows = await cmd.func({ query: 'golang', type: 'article', sort: 'relevance', period: 'all', limit: 5 });
        expect(rows).toHaveLength(5);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('stops when the cursor repeats instead of looping forever', async () => {
        const fetchMock = mockJson([{ err_no: 0, data: [articleEntry()], cursor: '0', has_more: true }]);
        const rows = await cmd.func({ query: 'golang', type: 'article', sort: 'relevance', period: 'all', limit: 50 });
        expect(rows).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries a flaky empty first page and returns the rows it eventually gets', async () => {
        // 掘金对 period != all 会间歇性返回空首页（err_no=0 但 data=[]）。
        const empty = { err_no: 0, err_msg: 'success', data: [], cursor: '20_x', has_more: false };
        const full = { err_no: 0, err_msg: 'success', data: [articleEntry()], cursor: '20_y', has_more: false };
        const fetchMock = mockSequence([empty, empty, full]);
        const rows = await cmd.func({ query: 'rust', type: 'article', sort: 'newest', period: 'week', limit: 20 });
        expect(rows).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('gives up after a bounded number of retries and still reports empty', async () => {
        const fetchMock = mockJson([{ err_no: 0, err_msg: 'success', data: [], cursor: '', has_more: false }]);
        await expect(cmd.func({ query: '鿃鿄鿅鿆', type: 'article', sort: 'relevance', period: 'all', limit: 20 }))
            .rejects.toThrow(EmptyResultError);
        expect(fetchMock).toHaveBeenCalledTimes(EMPTY_RETRY_ATTEMPTS);
    });

    it('does not retry an empty page reached mid-pagination', async () => {
        // 翻页途中的空页是正常终止信号，不该触发重试。
        const first = { err_no: 0, data: [articleEntry()], cursor: '20_p2', has_more: true };
        const empty = { err_no: 0, data: [], cursor: '40_p3', has_more: false };
        const fetchMock = mockSequence([first, empty]);
        const rows = await cmd.func({ query: 'golang', type: 'article', sort: 'relevance', period: 'all', limit: 20 });
        expect(rows).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws EmptyResultError rather than returning an empty list', async () => {
        mockJson([{ err_no: 0, err_msg: 'success', data: [], cursor: '', has_more: false }]);
        await expect(cmd.func({ query: 'zzqqxx', type: 'tag', sort: 'relevance', period: 'all', limit: 20 }))
            .rejects.toThrow(EmptyResultError);
    });

    it('throws EmptyResultError when every row is an unknown result_type', async () => {
        mockJson([{ err_no: 0, data: [{ result_type: 4, result_model: {} }], cursor: '', has_more: false }]);
        await expect(cmd.func({ query: 'golang', type: 'all', sort: 'relevance', period: 'all', limit: 20 }))
            .rejects.toThrow(EmptyResultError);
    });

    it('validates args before issuing any request', async () => {
        const fetchMock = mockJson([{ err_no: 0, data: [articleEntry()], cursor: '', has_more: false }]);
        await expect(cmd.func({ query: 'golang', type: 'pins', sort: 'relevance', period: 'all', limit: 20 }))
            .rejects.toThrow(ArgumentError);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
