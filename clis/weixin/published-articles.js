import { ArgumentError, EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { readOfficialApiCredentials } from './_wechat/api-freepublish.js';
import { resolveBrowserCredentials } from './_wechat/auth-session.js';
import { isFreepublishFallbackEligible } from './_wechat/freepublish-fallback.js';
import { collectPublishedRecords } from './_wechat/publish-records.js';
import { freepublishListCommand, OFFICIAL_API_ARGS } from './freepublish-list.js';

export const FACADE_COLUMNS = [
  'article_id', 'title', 'author', 'digest', 'published_at', 'url', 'content_html',
  'artifact_paths_json', 'thumb_media_id', 'image_info_json', 'source', 'fallback_reason',
];

function sourceValue(value) {
  const source = String(value ?? 'auto');
  if (!['auto', 'api', 'browser'].includes(source)) throw new ArgumentError('source must be auto, api, or browser');
  return source;
}

function limitValue(value) {
  const limit = value ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new ArgumentError('limit must be a positive safe integer');
  return limit;
}

export function projectOfficialRows(rows, fallbackReason = null) {
  return rows.map(row => ({
    article_id: row.article_id, title: row.title, author: row.author, digest: row.digest,
    published_at: row.updated_at, url: row.published_url, content_html: row.content_html,
    artifact_paths_json: row.artifact_paths_json, thumb_media_id: row.thumb_media_id,
    image_info_json: row.image_info_json, source: 'official-api', fallback_reason: fallbackReason,
  }));
}

async function browserRows(page, args, fallbackReason) {
  const { token } = await resolveBrowserCredentials(page);
  const rows = await collectPublishedRecords(page, {
    token, limit: args.limit ?? 20, maxPages: args['max-pages'] ?? 5, timeout: args.timeout ?? 30,
  });
  return rows.map(row => ({
    article_id: null, title: row.title, author: null, digest: null,
    published_at: row.publishedAt, url: row.url, content_html: null,
    artifact_paths_json: null, thumb_media_id: null, image_info_json: null,
    source: 'browser', fallback_reason: fallbackReason,
  }));
}

async function officialRows(args) {
  const limit = limitValue(args.limit);
  const rows = [];
  let offset = 0;
  while (rows.length < limit) {
    const remaining = limit - rows.length;
    const count = remaining > 20 ? 20 : remaining;
    let pageRows;
    try {
      pageRows = await freepublishListCommand.func({
        ...args, offset, count, content: args.content ?? 'none',
      });
    } catch (error) {
      if (error instanceof EmptyResultError && rows.length > 0) break;
      throw error;
    }
    rows.push(...pageRows);
    offset += count;
    if (pageRows.length < count) break;
  }
  return rows.slice(0, limit);
}

export const publishedArticlesCommand = cli({
  site: 'weixin', name: 'published-articles', access: 'read', domain: 'mp.weixin.qq.com',
  description: 'List published Weixin articles with optional official-API-to-browser fallback',
  strategy: Strategy.COOKIE,
  browser: args => sourceValue(args.source) !== 'api',
  args: [
    { name: 'source', default: 'auto', choices: ['auto', 'api', 'browser'], help: 'Article source and fallback policy' },
    { name: 'limit', type: 'int', default: 20, help: 'Maximum articles to return' },
    { name: 'max-pages', type: 'int', default: 5, help: 'Maximum browser pages to scan' },
    { name: 'timeout', type: 'int', default: 30, help: 'Browser request timeout in seconds' },
    { name: 'content', default: 'none', choices: ['none', 'inline', 'file'], help: 'Official API HTML handling' },
    { name: 'output', default: './weixin-published', help: 'Official API artifact directory' },
    ...OFFICIAL_API_ARGS,
  ],
  columns: FACADE_COLUMNS,
  func: async (page, args) => {
    const source = sourceValue(args.source);
    const limit = limitValue(args.limit);
    const normalizedArgs = { ...args, limit };
    if (source === 'browser') return browserRows(page, normalizedArgs, null);
    const credentials = readOfficialApiCredentials(args);
    if (source === 'auto' && !credentials.configured) return browserRows(page, normalizedArgs, 'api-not-configured');
    try {
      const rows = await officialRows(normalizedArgs);
      return projectOfficialRows(rows);
    } catch (error) {
      if (source === 'auto' && isFreepublishFallbackEligible(error)) {
        return browserRows(page, normalizedArgs, 'api-not-authorized');
      }
      if (error instanceof EmptyResultError) throw error;
      throw error;
    }
  },
});

export { sourceValue };
