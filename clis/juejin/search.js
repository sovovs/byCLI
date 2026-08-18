// juejin search — 掘金站内搜索，覆盖页面上的三个筛选维度。
//
// 单一 endpoint `GET api.juejin.cn/search_api/v1/search` 同时驱动网页上的
// 三组筛选控件，参数名和 UI 标签对应关系（从 juejin web bundle 的枚举表读出，
// 见 xitu_juejin_web/fa804e1.js 的 `{left: [...], right: [...]}`）：
//
//   id_type     → 顶部一级 tab：综合(0) / 文章(2) / 课程(12) / 标签(9) / 用户(1)
//   sort_type   → 排序 tab：综合排序(0) / 最新优先(1) / 最热优先(2)
//   search_type → 时间范围下拉：时间不限(0) / 最近一天(1) / 最近一周(2) / 最近三月(3)
//
// `search_type` 的命名容易误读成"搜索类型"，实际是时间窗（bundle 里这个参数由
// 名为 `period` 的变量传入），所以 CLI 侧暴露成 `--period` 而不是照搬 API 名。
//
// 响应是异构列表：每个 entry 带 `result_type` 决定 `result_model` 的形状
// （2=文章 / 1=用户 / 9=标签 / 12=课程小册）。综合 tab 会混排多种类型，
// 所以行结构做成一张统一表：identity 列 + 通用指标列，各类型特有的次要字段
// 折进 `extra`，避免列数爆炸又不丢信息。
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';

const API = 'https://api.juejin.cn/search_api/v1/search';

// 每页固定 20 条：limit 参数被服务端忽略（传 5 或 50 都返回 20），
// 分页只认 cursor，所以自己按 cursor 翻页再截断到用户要的条数。
const PAGE_SIZE = 20;
const MAX_LIMIT = 200;
const MAX_PAGES = 30;

const TYPES = {
    all: 0,
    article: 2,
    course: 12,
    tag: 9,
    user: 1,
};

const SORTS = {
    relevance: 0,
    newest: 1,
    hottest: 2,
};

const PERIODS = {
    all: 0,
    day: 1,
    week: 2,
    month3: 3,
};

const RESULT_TYPES = {
    1: 'user',
    2: 'article',
    9: 'tag',
    12: 'course',
};

function requireQuery(value) {
    const query = String(value ?? '').trim();
    if (!query) {
        throw new ArgumentError('juejin search query must not be empty', 'Example: bycli juejin search golang --sort hottest');
    }
    return query;
}

function requireChoice(value, table, flag, example) {
    const key = String(value ?? '');
    if (!Object.prototype.hasOwnProperty.call(table, key)) {
        throw new ArgumentError(`juejin search --${flag} must be one of: ${Object.keys(table).join(', ')}`, example);
    }
    return table[key];
}

function requireLimit(value) {
    const raw = value ?? 20;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        throw new ArgumentError('juejin search --limit must be a positive integer');
    }
    if (n > MAX_LIMIT) {
        throw new ArgumentError(`juejin search --limit must be <= ${MAX_LIMIT}`, 'Deep pagination hits juejin rate limits; narrow the query instead');
    }
    return n;
}

function toIsoTime(seconds) {
    const n = Number(seconds);
    // 掘金对"没有时间"用 -62135596800（Go 零值 time.Time）而不是 0/null。
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n * 1000).toISOString();
}

// rtime(发布时间) 在**较新**的文章上是 Go 零值 -62135596800，只有老文章才填。
// 所以不能写 `rtime ?? ctime`（?? 只兜 null/undefined，兜不住这个哨兵值），
// 必须按"第一个能转出合法时间的字段"取，否则 --sort newest 整列时间全 null。
function firstIsoTime(...candidates) {
    for (const candidate of candidates) {
        const iso = toIsoTime(candidate);
        if (iso) return iso;
    }
    return null;
}

function textOf(value) {
    return String(value ?? '').trim();
}

function buildUrl({ query, idType, sortType, period, cursor }) {
    const url = new URL(API);
    url.searchParams.set('aid', '2608');
    url.searchParams.set('spider', '0');
    url.searchParams.set('version', '1');
    url.searchParams.set('query', query);
    url.searchParams.set('id_type', String(idType));
    url.searchParams.set('sort_type', String(sortType));
    url.searchParams.set('search_type', String(period));
    url.searchParams.set('cursor', cursor);
    url.searchParams.set('limit', String(PAGE_SIZE));
    return url.toString();
}

async function fetchPage(url) {
    let resp;
    try {
        resp = await fetch(url, {
            headers: {
                accept: 'application/json',
                'user-agent': 'Mozilla/5.0',
                referer: 'https://juejin.cn/',
            },
        });
    }
    catch (err) {
        throw new CommandExecutionError(
            `juejin search request failed: ${err?.message ?? err}`,
            'Check that api.juejin.cn is reachable from this network.',
        );
    }
    if (!resp.ok) {
        throw new CommandExecutionError(`juejin search returned HTTP ${resp.status}`, `URL: ${url}`);
    }
    let payload;
    try {
        payload = await resp.json();
    }
    catch (err) {
        throw new CommandExecutionError(`juejin search returned malformed JSON: ${err?.message ?? err}`);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new CommandExecutionError('juejin search returned malformed payload');
    }
    if (payload.err_no !== 0) {
        throw new CommandExecutionError(`juejin search API error: ${textOf(payload.err_msg) || `err_no ${payload.err_no}`}`);
    }
    if (!Array.isArray(payload.data)) {
        throw new CommandExecutionError('juejin search returned malformed data list', `URL: ${url}`);
    }
    return payload;
}

// 每个分支返回中间结构（identity/label/…），最后统一映射到 columns 命名，
// 避免中间 key 和 columns 重叠触发 silent-column-drop 误判。
function normalizeArticle(model) {
    const info = model?.article_info;
    if (!info || typeof info !== 'object') return null;
    const identity = textOf(model.article_id ?? info.article_id);
    const label = textOf(info.title);
    if (!identity || !label) return null;
    return {
        identity,
        label,
        byline: textOf(model.author_user_info?.user_name),
        viewTotal: Number(info.view_count ?? 0),
        likeTotal: Number(info.digg_count ?? 0),
        commentTotal: Number(info.comment_count ?? 0),
        heat: Number(info.hot_index ?? 0),
        stamp: firstIsoTime(info.rtime, info.ctime),
        link: `https://juejin.cn/post/${identity}`,
        aside: {
            collect_count: Number(info.collect_count ?? 0),
            category: textOf(model.category?.category_name) || null,
            // 逗号连接而不是数组：row shape 门禁要求嵌套深度 <= 1（agent-native 行）。
            tags: (Array.isArray(model.tags) ? model.tags : [])
                .map((tag) => textOf(tag?.tag_name))
                .filter(Boolean)
                .join(',') || null,
            brief: textOf(info.brief_content) || null,
            is_original: info.is_original === 1,
        },
    };
}

function normalizeUser(model) {
    const identity = textOf(model?.user_id);
    const label = textOf(model?.user_name);
    if (!identity || !label) return null;
    return {
        identity,
        label,
        // 用户自身就是作者，byline 放职位/公司当副标题更有信息量。
        byline: [textOf(model.job_title), textOf(model.company)].filter(Boolean).join(' @ '),
        viewTotal: Number(model.got_view_count ?? 0),
        likeTotal: Number(model.got_digg_count ?? 0),
        commentTotal: null,
        heat: Number(model.follower_count ?? 0),
        stamp: null,
        link: `https://juejin.cn/user/${identity}`,
        aside: {
            level: Number(model.level ?? 0),
            follower_count: Number(model.follower_count ?? 0),
            post_article_count: Number(model.post_article_count ?? 0),
            description: textOf(model.description) || null,
        },
    };
}

function normalizeTag(model) {
    const tag = model?.tag;
    const identity = textOf(model?.tag_id ?? tag?.tag_id);
    const label = textOf(tag?.tag_name);
    if (!identity || !label) return null;
    return {
        identity,
        label,
        byline: null,
        viewTotal: null,
        likeTotal: null,
        commentTotal: null,
        heat: Number(tag?.concern_user_count ?? 0),
        stamp: toIsoTime(tag?.ctime),
        link: `https://juejin.cn/tag/${encodeURIComponent(label)}`,
        aside: {
            post_article_count: Number(tag?.post_article_count ?? 0),
            concern_user_count: Number(tag?.concern_user_count ?? 0),
        },
    };
}

function normalizeCourse(model) {
    const base = model?.base_info;
    const identity = textOf(model?.booklet_id ?? base?.booklet_id);
    const label = textOf(base?.title);
    if (!identity || !label) return null;
    return {
        identity,
        label,
        byline: textOf(model.user_info?.user_name),
        viewTotal: Number(base?.read_time ?? 0),
        likeTotal: null,
        commentTotal: null,
        heat: Number(base?.buy_count ?? 0),
        stamp: firstIsoTime(base?.put_on_time, base?.ctime),
        link: `https://juejin.cn/book/${identity}`,
        aside: {
            // price 是分，转成元避免下游误读成 2990 元。
            price_yuan: Number.isFinite(Number(base?.price)) ? Number(base.price) / 100 : null,
            section_count: Number(base?.section_count ?? 0),
            buy_count: Number(base?.buy_count ?? 0),
            summary: textOf(base?.summary) || null,
        },
    };
}

const NORMALIZERS = {
    article: normalizeArticle,
    user: normalizeUser,
    tag: normalizeTag,
    course: normalizeCourse,
};

function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const kind = RESULT_TYPES[entry.result_type];
    // 掘金以后可能加新的 result_type（沸点等）。未知类型静默跳过而不是抛错，
    // 否则综合 tab 上线一个新卡片类型就会让整个命令挂掉。
    if (!kind) return null;
    const parsed = NORMALIZERS[kind](entry.result_model);
    if (!parsed) return null;
    return { resultKind: kind, parsed };
}

cli({
    site: 'juejin',
    name: 'search',
    access: 'read',
    description: '掘金搜索，支持综合/文章/课程/标签/用户维度与综合/最新/最热排序',
    domain: 'api.juejin.cn',
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
        { name: 'query', required: true, positional: true, help: '搜索关键词' },
        { name: 'type', default: 'all', choices: Object.keys(TYPES), help: '结果类型：all(综合) / article(文章) / course(课程) / tag(标签) / user(用户)' },
        { name: 'sort', default: 'relevance', choices: Object.keys(SORTS), help: '排序：relevance(综合) / newest(最新优先) / hottest(最热优先)' },
        { name: 'period', default: 'all', choices: Object.keys(PERIODS), help: '时间范围：all(不限) / day(最近一天) / week(最近一周) / month3(最近三月)' },
        { name: 'limit', type: 'int', default: 20, help: `返回条数 (max ${MAX_LIMIT})` },
    ],
    columns: ['rank', 'kind', 'id', 'title', 'author', 'views', 'likes', 'comments', 'hot_index', 'published_at', 'url', 'extra'],
    func: async (args) => {
        const query = requireQuery(args.query);
        const idType = requireChoice(args.type, TYPES, 'type', 'Example: bycli juejin search rust --type article');
        const sortType = requireChoice(args.sort, SORTS, 'sort', 'Example: bycli juejin search rust --sort hottest');
        const period = requireChoice(args.period, PERIODS, 'period', 'Example: bycli juejin search rust --period week');
        const limit = requireLimit(args.limit);

        const rows = [];
        const seen = new Set();
        let cursor = '0';
        let pages = 0;

        while (rows.length < limit && pages < MAX_PAGES) {
            const url = buildUrl({ query, idType, sortType, period, cursor });
            const payload = await fetchPage(url);
            pages += 1;

            for (const entry of payload.data) {
                const normalized = normalizeEntry(entry);
                if (!normalized) continue;
                const { resultKind: kind, parsed } = normalized;
                const dedupeKey = `${kind}:${parsed.identity}`;
                // 服务端跨页会重复少量结果（实测 6 页 118 条里 6 条重复）。
                if (seen.has(dedupeKey)) continue;
                seen.add(dedupeKey);
                rows.push({
                    rank: rows.length + 1,
                    kind,
                    id: parsed.identity,
                    title: parsed.label,
                    author: parsed.byline || null,
                    views: parsed.viewTotal,
                    likes: parsed.likeTotal,
                    comments: parsed.commentTotal,
                    hot_index: parsed.heat,
                    published_at: parsed.stamp,
                    url: parsed.link,
                    extra: parsed.aside,
                });
                if (rows.length >= limit) break;
            }

            if (rows.length >= limit) break;
            const nextCursor = textOf(payload.cursor);
            if (!payload.has_more || !nextCursor || nextCursor === cursor) break;
            cursor = nextCursor;
        }

        if (rows.length === 0) {
            throw new EmptyResultError('juejin search', `No ${args.type === 'all' ? '' : `${args.type} `}results for "${query}"`);
        }
        return rows;
    },
});

export const __test__ = {
    TYPES,
    SORTS,
    PERIODS,
    RESULT_TYPES,
    PAGE_SIZE,
    MAX_LIMIT,
    MAX_PAGES,
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
};
