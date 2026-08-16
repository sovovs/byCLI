import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { readEnvironmentCredentials, resolveBrowserCredentials } from './_wechat/auth-session.js';
import { createArticleIndexFetcher } from './_wechat/article-index.js';
import { callCrawler, collectArticles } from './_wechat/crawler-runtime.js';
import { readAuthSource } from './_wechat/args.js';
import { buildSecretSet, redactText } from './_wechat/redact.js';
import { collectSogouAccountArticles } from './_wechat/sogou-fallback.js';

const DOMAIN = 'mp.weixin.qq.com';
const browserRequired = args => readAuthSource(args) === 'browser';

function isEligibleFallbackError(error) {
  return error instanceof CommandExecutionError || error instanceof EmptyResultError;
}

function missingFallbackNameError(error) {
  const hint = `${error.hint ? `${error.hint} ` : ''}Sogou fallback requires the exact official-account name in --name.`;
  if (error instanceof EmptyResultError) return new EmptyResultError('weixin articles', hint);
  return new CommandExecutionError(error.message, hint);
}

function combinedFallbackError(primaryError, fallbackError, credentials) {
  if (fallbackError instanceof AuthRequiredError) return fallbackError;
  const secrets = buildSecretSet(credentials);
  const primary = redactText(primaryError.message, secrets);
  const fallback = redactText(
    fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
    secrets,
  );
  return new CommandExecutionError(
    'Weixin article index and Sogou fallback both failed',
    `Primary (${primaryError.code}): ${primary}; fallback (${fallbackError?.code ?? 'UNKNOWN'}): ${fallback}`,
  );
}

export const articlesCommand = cli({
  site: 'weixin', name: 'articles', access: 'read', domain: DOMAIN,
  description: 'List published articles from a WeChat official account',
  strategy: Strategy.COOKIE, browser: browserRequired,
  args: [
    { name: 'fakeid', positional: true, required: true, help: 'Official-account fakeid returned by weixin accounts' },
    { name: 'name', help: 'Optional official-account name for display context' }, { name: 'limit', type: 'int', help: 'Maximum number of articles to return' }, { name: 'max-pages', type: 'int', help: 'Maximum number of history pages to scan' },
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
      if (authSource !== 'browser' || !isEligibleFallbackError(primaryError)) throw primaryError;
      const accountName = String(args.name ?? '').trim();
      if (!accountName) throw missingFallbackNameError(primaryError);
      try {
        const fallback = await collectSogouAccountArticles({
          page, accountName, limit: args.limit, maxPages: args['max-pages'],
        });
        articles = fallback.articles;
        source = fallback.source;
        coverage = fallback.coverage;
      } catch (fallbackError) {
        throw combinedFallbackError(primaryError, fallbackError, credentials);
      }
    }
    return articles.map(article => ({
      title: article.title, author: article.author || null, digest: article.digest || null,
      publishedAt: article.publishedAt || null, url: article.url, source, coverage,
    }));
  },
});
