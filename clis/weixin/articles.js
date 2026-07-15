import { ArgumentError, EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { readEnvironmentCredentials, resolveBrowserCredentials } from './_wechat/auth-session.js';
import { collectArticles } from './_wechat/article-service.js';
import { createWechatApi } from './_wechat/wechat-api.js';
import { readAuthSource } from './_wechat/args.js';

const DOMAIN = 'mp.weixin.qq.com';
const browserRequired = args => readAuthSource(args) === 'browser';

export const articlesCommand = cli({
  site: 'weixin', name: 'articles', access: 'read', domain: DOMAIN,
  description: 'List published articles from a WeChat official account',
  strategy: Strategy.COOKIE, browser: browserRequired,
  args: [
    { name: 'fakeid', positional: true, required: true, help: 'Official-account fakeid returned by weixin accounts' },
    { name: 'name', help: 'Optional official-account name for display context' }, { name: 'limit', type: 'int', help: 'Maximum number of articles to return' }, { name: 'max-pages', type: 'int', help: 'Maximum number of history pages to scan' },
    { name: 'auth-source', default: 'browser', choices: ['browser', 'env'], help: 'Credential source: browser session or environment variables' },
  ],
  columns: ['title', 'author', 'digest', 'publishedAt', 'url'],
  func: async (page, args) => {
    const fakeid = String(args.fakeid ?? '').trim();
    if (!fakeid) throw new ArgumentError('fakeid is required');
    const authSource = readAuthSource(args);
    const credentials = authSource === 'env'
      ? readEnvironmentCredentials(false) : await resolveBrowserCredentials(page);
    const { fetchPage } = createWechatApi(credentials);
    const { articles } = await collectArticles({ fakeid, fetchPage, limit: args.limit, maxPages: args['max-pages'] });
    if (articles.length === 0) throw new EmptyResultError('weixin articles', `No published articles were found for ${fakeid}.`);
    return articles.map(article => ({
      title: article.title, author: article.author || null, digest: article.digest || null,
      publishedAt: article.publishedAt || null, url: article.url,
    }));
  },
});
