import {
  ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError,
} from '@sovovs/bycli/errors';
import { MAX_WECHAT_HTML_BYTES } from '@sovovs/bycli/download/wechat-article';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { readEnvironmentCredentials, resolveBrowserCredentials } from './_wechat/auth-session.js';
import { createArticleIndexFetcher } from './_wechat/article-index.js';
import {
  callCrawler, collectArticles, isTrustedWechatArticleUrl, saveArticles,
} from './_wechat/crawler-runtime.js';
import { readAuthSource } from './_wechat/args.js';
import { wechatArticleToMarkdown } from './_wechat/markdown.js';
import { buildSecretSet, redactText } from './_wechat/redact.js';
import { collectSogouAccountArticles } from './_wechat/sogou-fallback.js';

const DOMAIN = 'mp.weixin.qq.com';
const browserRequired = args => readAuthSource(args) === 'browser';

const MAX_REDIRECTS = 5;

function isEligibleFallbackError(error) {
  return error instanceof CommandExecutionError || error instanceof EmptyResultError;
}

function missingFallbackNameError(error) {
  const hint = `${error.hint ? `${error.hint} ` : ''}Sogou fallback requires the exact official-account name in --name.`;
  if (error instanceof EmptyResultError) return new EmptyResultError('weixin save-articles', hint);
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

async function readBoundedHtml(response) {
  const lengthValue = response.headers?.get?.('content-length');
  if (lengthValue !== null && lengthValue !== undefined && lengthValue !== '') {
    const length = Number(lengthValue);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_WECHAT_HTML_BYTES) {
      throw new CommandExecutionError('Article response exceeds the allowed size');
    }
  }
  if (!response.body?.getReader) {
    if (typeof response.text !== 'function') throw new CommandExecutionError('Article response has no readable body');
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_WECHAT_HTML_BYTES) {
      throw new CommandExecutionError('Article response exceeds the allowed size');
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) throw new CommandExecutionError('Article response returned invalid body data');
    total += value.byteLength;
    if (total > MAX_WECHAT_HTML_BYTES) {
      try { await reader.cancel(); } catch { /* best-effort stream cleanup */ }
      throw new CommandExecutionError('Article response exceeds the allowed size');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function fetchArticleHtml(article, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  try {
    if (!isTrustedWechatArticleUrl(article?.url)) throw new CommandExecutionError('Article request rejected an untrusted URL');
    let current = new URL(article.url).href;
    const seen = new Set([current]);
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetchImpl(current, {
        signal: AbortSignal.timeout(timeoutMs), redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        if (redirects >= MAX_REDIRECTS) throw new CommandExecutionError('Article request exceeded the redirect limit');
        const location = response.headers?.get?.('location');
        if (!location) throw new CommandExecutionError('Article redirect was missing a destination');
        let next;
        try { next = new URL(location, current).href; } catch { throw new CommandExecutionError('Article redirect was invalid'); }
        if (!isTrustedWechatArticleUrl(next)) throw new CommandExecutionError('Article redirect was rejected');
        if (seen.has(next)) throw new CommandExecutionError('Article redirect loop was rejected');
        seen.add(next);
        current = next;
        continue;
      }
      if (!response.ok) throw new CommandExecutionError(`Article request failed: HTTP ${response.status}`);
      return await readBoundedHtml(response);
    }
  } catch (error) {
    if (error instanceof CommandExecutionError) throw error;
    throw new CommandExecutionError('Article request failed');
  }
}

export async function fetchArticleHtmlInBrowser(article, page) {
  try {
    if (!isTrustedWechatArticleUrl(article?.url)) {
      throw new CommandExecutionError('Article browser request rejected an untrusted URL');
    }
    if (!page || typeof page.goto !== 'function' || typeof page.evaluate !== 'function') {
      throw new CommandExecutionError('Article browser fallback is unavailable');
    }
    await page.goto(article.url);
    await page.wait(5);
    const result = await page.evaluate(({ maxBytes }) => {
      const html = document.documentElement?.outerHTML ?? '';
      const pageText = document.body?.innerText?.replace(/\s+/g, ' ').trim() ?? '';
      const finalUrl = window.location.href;
      const pathname = window.location.pathname;
      const accessIssue = pathname.includes('/mp/wappoc_appmsgcaptcha')
        || (/环境异常/.test(pageText) && /(完成验证后即可继续访问|去验证)/.test(pageText))
        || /secitptpage\/verify\.html/.test(html)
        || /id=["']js_verify["']/.test(html)
        ? 'environment verification required' : '';
      const byteLength = new TextEncoder().encode(html).byteLength;
      return {
        finalUrl,
        accessIssue,
        byteLength,
        tooLarge: byteLength > maxBytes,
        html: byteLength > maxBytes ? '' : html,
      };
    }, { maxBytes: MAX_WECHAT_HTML_BYTES });
    if (result?.accessIssue) {
      throw new AuthRequiredError(
        DOMAIN,
        'WeChat article page requires environment verification. Complete it in the open browser tab and run the command again.',
      );
    }
    if (!isTrustedWechatArticleUrl(result?.finalUrl)) {
      throw new CommandExecutionError('Article browser navigation left the trusted article path');
    }
    if (result?.tooLarge || !Number.isSafeInteger(result?.byteLength)
        || result.byteLength < 0 || result.byteLength > MAX_WECHAT_HTML_BYTES) {
      throw new CommandExecutionError('Article response exceeds the allowed size');
    }
    if (typeof result?.html !== 'string' || result.html.length === 0) {
      throw new CommandExecutionError('Article browser page returned no HTML');
    }
    if (new TextEncoder().encode(result.html).byteLength > MAX_WECHAT_HTML_BYTES) {
      throw new CommandExecutionError('Article response exceeds the allowed size');
    }
    return result.html;
  } catch (error) {
    if (error instanceof CommandExecutionError || error instanceof AuthRequiredError) throw error;
    throw new CommandExecutionError('Article browser request failed');
  }
}

export function createArticleHtmlDownloader({
  authSource,
  page,
  nodeFetcher = fetchArticleHtml,
  browserFetcher = fetchArticleHtmlInBrowser,
}) {
  return async article => {
    try {
      return await nodeFetcher(article);
    } catch (error) {
      if (authSource !== 'browser') throw error;
      return browserFetcher(article, page);
    }
  };
}

export const saveArticlesCommand = cli({
  site: 'weixin', name: 'save-articles', access: 'write', domain: DOMAIN,
  description: 'Download WeChat official-account articles as Markdown files',
  strategy: Strategy.COOKIE, browser: browserRequired,
  args: [
    { name: 'fakeid', positional: true, required: true, help: 'Official-account fakeid returned by weixin accounts' }, { name: 'name', help: 'Official-account name used in Markdown metadata' },
    { name: 'output', default: './weixin-articles', help: 'Directory for saved Markdown files' }, { name: 'limit', type: 'int', help: 'Maximum number of articles to save' },
    { name: 'max-pages', type: 'int', help: 'Maximum number of history pages to scan' }, { name: 'auth-source', default: 'browser', choices: ['browser', 'env'], help: 'Credential source: browser session or environment variables' },
  ],
  columns: ['title', 'status', 'stage', 'path', 'error', 'url', 'source', 'coverage'],
  func: async (page, args) => {
    const fakeid = String(args.fakeid ?? '').trim();
    if (!fakeid) throw new ArgumentError('fakeid is required');
    const authSource = readAuthSource(args);
    const credentials = authSource === 'env'
      ? readEnvironmentCredentials(false) : await resolveBrowserCredentials(page);
    const articleHtmlDownloader = createArticleHtmlDownloader({ authSource, page });
    const fetchPage = createArticleIndexFetcher({ page, source: authSource, credentials });
    let articles;
    let resolutionFailures = [];
    let source = 'wechat';
    let coverage = null;
    try {
      const result = await callCrawler(() => collectArticles({
        fakeid, fetchPage, limit: args.limit, maxPages: args['max-pages'],
      }));
      articles = result.articles;
      if (articles.length === 0) {
        throw new EmptyResultError('weixin save-articles', `No published articles were found for ${fakeid}.`);
      }
    } catch (primaryError) {
      if (authSource !== 'browser' || !isEligibleFallbackError(primaryError)) throw primaryError;
      const accountName = String(args.name ?? '').trim();
      if (!accountName) throw missingFallbackNameError(primaryError);
      try {
        const fallback = await collectSogouAccountArticles({
          page, accountName, limit: args.limit, maxPages: args['max-pages'],
          resolutionPolicy: 'rows',
        });
        articles = fallback.articles;
        resolutionFailures = fallback.resolutionFailures;
        source = fallback.source;
        coverage = fallback.coverage;
      } catch (fallbackError) {
        throw combinedFallbackError(primaryError, fallbackError, credentials);
      }
    }

    const savedRows = articles.length === 0 ? [] : await callCrawler(() => saveArticles({
        articles, accountName: String(args.name ?? '').trim(),
        outputDir: args.output ?? './weixin-articles', fetchArticleHtml: articleHtmlDownloader,
        buildMarkdown: (article, html) => wechatArticleToMarkdown({
          html, title: article.title, accountName: String(args.name ?? '').trim(), author: article.author,
          publishedAt: article.publishedAt, digest: article.digest, url: article.url,
        }), existingFilePolicy: 'suffix',
      }));
    const orderedRows = source === 'sogou'
      ? [
        ...savedRows.map((row, index) => ({ ...row, order: articles[index]?.order ?? index })),
        ...resolutionFailures,
      ].sort((left, right) => left.order - right.order)
      : savedRows;
    return orderedRows.map(row => ({
      title: row.title, status: row.status, stage: row.stage || null, path: row.saved || null,
      error: row.error || null, url: row.url, source, coverage,
    }));
  },
});
