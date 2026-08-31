import { ArgumentError, EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { readEnvironmentCredentials, resolveBrowserCredentials } from './_wechat/auth-session.js';
import {
  combineArticleFallbackErrors,
  isEligibleArticleFallbackError,
  withMissingFallbackName,
} from './_wechat/article-fallback-policy.js';
import { createArticleIndexFetcher } from './_wechat/article-index.js';
import { callCrawler, collectArticles } from './_wechat/crawler-runtime.js';
import { readAuthSource } from './_wechat/args.js';
import { collectSogouAccountArticles } from './_wechat/sogou-fallback.js';

const DOMAIN = 'mp.weixin.qq.com';
const browserRequired = args => readAuthSource(args) === 'browser';

export const articlesCommand = cli({
  site: 'weixin', name: 'articles', access: 'read', domain: DOMAIN,
  description: 'List published articles from a WeChat official account',
  strategy: Strategy.COOKIE, browser: browserRequired,
  args: [
    { name: 'fakeid', positional: true, required: true, help: 'Official-account fakeid returned by weixin get-public-account-info' },
    { name: 'name', help: 'Official-account name; exact case-insensitive match required for browser Sogou fallback' }, { name: 'limit', type: 'int', help: 'Maximum number of articles to return' }, { name: 'max-pages', type: 'int', help: 'Maximum number of history pages to scan' },
    { name: 'auth-source', default: 'browser', choices: ['browser', 'env'], help: 'Credential source: browser session or environment variables' },
  ],
  columns: ['title', 'author', 'digest', 'publishedAt', 'url', 'source', 'coverage'],
  func: async (page, args) => {
    const fakeid = String(args.fakeid ?? '').trim();
    if (!fakeid) throw new ArgumentError('fakeid is required');
    const authSource = readAuthSource(args);
    const credentials = authSource === 'env'
      ? readEnvironmentCredentials(false) : await resolveBrowserCredentials(page);
    const fetchPage = createArticleIndexFetcher({ page, source: authSource, credentials });
    let articles;
    let source = 'wechat';
    let coverage = null;
    try {
      const result = await callCrawler(() => collectArticles({
        fakeid, fetchPage, limit: args.limit, maxPages: args['max-pages'],
      }));
      articles = result.articles;
      if (articles.length === 0) {
        throw new EmptyResultError('weixin articles', `No published articles were found for ${fakeid}.`);
      }
    } catch (primaryError) {
      if (authSource !== 'browser' || !isEligibleArticleFallbackError(primaryError)) throw primaryError;
      const accountName = String(args.name ?? '').trim();
      if (!accountName) throw withMissingFallbackName('weixin articles', primaryError);
      try {
        const fallback = await collectSogouAccountArticles({
          page, accountName, limit: args.limit, maxPages: args['max-pages'], freshPage: true,
        });
        articles = fallback.articles;
        source = fallback.source;
        coverage = fallback.coverage;
      } catch (fallbackError) {
        throw combineArticleFallbackErrors({
          operation: 'weixin articles', primaryError, fallbackError, credentials,
        });
      }
    }
    return articles.map(article => ({
      title: article.title, author: article.author || null, digest: article.digest || null,
      publishedAt: article.publishedAt || null, url: article.url, source, coverage,
    }));
  },
});
