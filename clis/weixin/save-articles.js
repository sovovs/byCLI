import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { readEnvironmentCredentials, resolveBrowserCredentials } from './_wechat/auth-session.js';
import { collectArticles } from './_wechat/article-service.js';
import { saveArticles } from './_wechat/save-service.js';
import { createWechatApi } from './_wechat/wechat-api.js';

const DOMAIN = 'mp.weixin.qq.com';
const browserRequired = args => args['auth-source'] !== 'env';
function source(args) {
  const value = args['auth-source'] ?? 'browser';
  if (value !== 'browser' && value !== 'env') throw new ArgumentError('auth-source must be browser or env');
  return value;
}

async function fetchArticleHtml(article) {
  try {
    const response = await fetch(article.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new CommandExecutionError(`Article request failed: HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (error instanceof CommandExecutionError) throw error;
    throw new CommandExecutionError(`Article request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const saveArticlesCommand = cli({
  site: 'weixin', name: 'save-articles', access: 'write', domain: DOMAIN,
  strategy: Strategy.COOKIE, browser: browserRequired,
  args: [
    { name: 'fakeid', positional: true, required: true, help: 'Official-account fakeid returned by weixin accounts' }, { name: 'name' },
    { name: 'output', default: './weixin-articles' }, { name: 'limit', type: 'int' },
    { name: 'max-pages', type: 'int' }, { name: 'auth-source', default: 'browser' },
  ],
  columns: ['title', 'status', 'stage', 'path', 'error', 'url'],
  func: async (page, args) => {
    const fakeid = String(args.fakeid ?? '').trim();
    if (!fakeid) throw new ArgumentError('fakeid is required');
    const authSource = source(args);
    const credentials = authSource === 'env'
      ? readEnvironmentCredentials(false) : await resolveBrowserCredentials(page);
    const { fetchPage } = createWechatApi(credentials);
    const { articles } = await collectArticles({ fakeid, fetchPage, limit: args.limit, maxPages: args['max-pages'] });
    const rows = await saveArticles({
      articles, accountName: String(args.name ?? '').trim(),
      outputDir: args.output ?? './weixin-articles', fetchArticleHtml,
    });
    return rows.map(row => ({
      title: row.title, status: row.status, stage: row.stage || null, path: row.saved || null,
      error: row.error || null, url: row.url,
    }));
  },
});
