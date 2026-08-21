/**
 * Toutiao public site search — extracts rich result cards from the rendered
 * public search page. No authentication required.
 */
import { cli, Strategy } from '@sovovs/bycli/registry';
import { CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import { parseSearchLimit, parseSearchType, parseToutiaoSearchHtml, TOUTIAO_SEARCH_URL } from './utils.js';

cli({
    site: 'toutiao',
    name: 'search',
    access: 'read',
    description: '搜索今日头条公开站内内容',
    domain: 'www.toutiao.com',
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
        { name: 'query', type: 'string', positional: true, help: '搜索关键词' },
        { name: 'type', type: 'string', default: 'synthesis', help: '搜索类型 (synthesis/information/video/atlas/user/xiaoshipin/weitoutiao/music)' },
        { name: 'limit', type: 'int', default: 20, help: '返回条数 (1-50)' },
    ],
    columns: [
        'rank', 'title', 'url', 'source', 'publish_time', 'summary', 'image_url',
        'like_count', 'comment_count', 'share_count', 'read_count',
    ],
    func: async (_page, kwargs) => {
        const query = String(kwargs?.query ?? '').trim();
        if (!query) throw new CommandExecutionError('toutiao search requires a non-empty query');
        const type = parseSearchType(kwargs?.type, 'synthesis');
        const limit = parseSearchLimit(kwargs?.limit, 20);
        const url = new URL(TOUTIAO_SEARCH_URL);
        url.searchParams.set('keyword', query);
        url.searchParams.set('pd', type);
        url.searchParams.set('page_num', '0');

        let resp;
        try {
            resp = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    Accept: 'text/html,application/xhtml+xml',
                    Referer: 'https://www.toutiao.com/',
                },
            });
        } catch (error) {
            throw new CommandExecutionError(`toutiao search request failed: ${error?.message || error}`);
        }
        if (!resp.ok) {
            throw new CommandExecutionError(`toutiao search failed: HTTP ${resp.status}`);
        }
        let html;
        try {
            html = await resp.text();
        } catch (error) {
            throw new CommandExecutionError(`toutiao search response read failed: ${error?.message || error}`);
        }
        const rows = parseToutiaoSearchHtml(html, limit);
        if (rows.length === 0) {
            throw new EmptyResultError('toutiao search', `未找到与「${query}」相关的公开内容。`);
        }
        return rows;
    },
});
