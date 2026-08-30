import { ArgumentError } from '@sovovs/bycli/errors';
import { cli, getRegistry, Strategy } from '@sovovs/bycli/registry';
import { readOfficialApiCredentials } from './_wechat/api-freepublish.js';
import { isFreepublishFallbackEligible, requireBrowserFallbackUrl } from './_wechat/freepublish-fallback.js';
import { freepublishGetCommand, } from './freepublish-get.js';
import { OFFICIAL_API_ARGS } from './freepublish-list.js';
import { FACADE_COLUMNS, projectOfficialRows, sourceValue } from './published-articles.js';

export async function loadBrowserDownloadCommand() {
  const existing = getRegistry().get('weixin/download');
  if (typeof existing?.func === 'function') return existing;
  const module = await import('./download.js');
  const registered = getRegistry().get('weixin/download');
  return typeof registered?.func === 'function' ? registered : module.weixinDownloadCommand;
}

async function browserArticle(page, args, fallbackReason) {
  const url = requireBrowserFallbackUrl(args.url);
  const download = await loadBrowserDownloadCommand();
  if (!download) throw new ArgumentError('weixin download command is unavailable for browser fallback');
  const rows = await download.func(page, { url, output: args.output, 'download-images': args['download-images'] ?? true });
  return rows.map(row => ({
    article_id: null, title: row.title, author: row.author ?? null, digest: null,
    published_at: row.publish_time ?? null, url: row.resolved_url ?? url, content_html: null,
    artifact_paths_json: JSON.stringify({ markdown: row.saved }), thumb_media_id: null,
    image_info_json: null, source: 'browser', fallback_reason: fallbackReason,
  }));
}

export const articleFetchCommand = cli({
  site: 'weixin', name: 'article-fetch', access: 'read', domain: 'mp.weixin.qq.com',
  description: 'Fetch one published Weixin article with optional browser fallback',
  strategy: Strategy.COOKIE,
  browser: args => sourceValue(args.source) !== 'api',
  args: [
    { name: 'article-id', help: 'Official article_id for API retrieval' },
    { name: 'url', help: 'Trusted public article URL required for browser mode or fallback' },
    { name: 'source', default: 'auto', choices: ['auto', 'api', 'browser'], help: 'Article source and fallback policy' },
    { name: 'content', default: 'file', choices: ['none', 'inline', 'file'], help: 'Official API HTML handling' },
    { name: 'output', default: './weixin-published', help: 'Artifact output directory' },
    { name: 'download-images', type: 'boolean', default: true, help: 'Download images in browser mode' },
    ...OFFICIAL_API_ARGS,
  ],
  columns: FACADE_COLUMNS,
  func: async (page, args) => {
    const source = sourceValue(args.source);
    if (source === 'browser') return browserArticle(page, args, null);
    const articleId = String(args['article-id'] ?? '').trim();
    if (!articleId) {
      if (source === 'auto') return browserArticle(page, args, 'article-id-not-provided');
      throw new ArgumentError('article-id is required in API mode');
    }
    const credentials = readOfficialApiCredentials(args);
    if (source === 'auto' && !credentials.configured) return browserArticle(page, args, 'api-not-configured');
    try {
      return projectOfficialRows(await freepublishGetCommand.func({
        ...args, articleId, content: args.content ?? 'file',
      }));
    } catch (error) {
      if (source === 'auto' && isFreepublishFallbackEligible(error)) {
        return browserArticle(page, args, 'api-not-authorized');
      }
      throw error;
    }
  },
});
