import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';

export const MAX_PAGES = 100;
export const MAX_PAGE_SIZE = 10;
export const MAX_ARTICLES = 1000;

export function isTrustedWechatArticleUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'mp.weixin.qq.com'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && (url.pathname === '/s' || url.pathname.startsWith('/s/'));
  } catch {
    return false;
  }
}

/** @param {any} article */
export function isUsableArticle(article) {
  return Boolean(article)
    && article.isDeleted !== true
    && typeof article.url === 'string'
    && isTrustedWechatArticleUrl(article.url)
    && !article.url.includes('tempkey=');
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return value;
  }
}

function publicArticle(article) {
  return {
    title: typeof article.title === 'string' ? article.title : '',
    url: article.url,
    publishedAt: typeof article.publishedAt === 'string' ? article.publishedAt : null,
    digest: typeof article.digest === 'string' ? article.digest : '',
    author: typeof article.author === 'string' ? article.author : '',
  };
}

/**
 * @param {{fakeid:string,fetchPage:(input:{fakeid:string,begin:number,count:number})=>Promise<any>,limit?:number,maxPages?:number,pageSize?:number}} options
 */
export async function collectArticles({ fakeid, fetchPage, limit, maxPages, pageSize = 10 }) {
  for (const [name, value, maximum] of [
    ['pageSize', pageSize, MAX_PAGE_SIZE],
    ['limit', limit, MAX_ARTICLES],
    ['maxPages', maxPages, MAX_PAGES],
  ]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new ArgumentError(`${name} must be a positive safe integer`);
    }
    if (value !== undefined && value > maximum) {
      throw new ArgumentError(`${name} must not exceed ${maximum}`);
    }
  }
  const pageLimit = maxPages ?? MAX_PAGES;
  const articleLimit = limit ?? MAX_ARTICLES;
  const articles = [];
  const seen = new Set();
  let totalFromApi = 0;
  let scanned = 0;
  let invalid = 0;
  let duplicates = 0;
  let pages = 0;
  let begin = 0;

  while (true) {
    const page = await fetchPage({ fakeid, begin, count: pageSize });
    pages += 1;
    const pageTotal = page?.total === undefined ? 0 : page.total;
    if (!Number.isSafeInteger(pageTotal) || pageTotal < 0) {
      throw new CommandExecutionError('WeChat article history returned invalid total metadata');
    }
    if (pages === 1) totalFromApi = pageTotal;
    const rawArticles = Array.isArray(page?.articles) ? page.articles : [];
    const publishItemCount = page?.publishItemCount === undefined ? 0 : page.publishItemCount;
    if (!Number.isSafeInteger(publishItemCount) || publishItemCount < 0) {
      throw new CommandExecutionError('WeChat article history returned invalid publish-item metadata');
    }

    for (const article of rawArticles) {
      scanned += 1;
      if (!isUsableArticle(article)) {
        invalid += 1;
        continue;
      }
      const canonical = canonicalUrl(article.url);
      if (seen.has(canonical)) {
        duplicates += 1;
        continue;
      }
      seen.add(canonical);
      articles.push(publicArticle(article));
      if (articles.length >= articleLimit) break;
    }

    const reachedLimit = articles.length >= articleLimit;
    const reachedMaxPages = pages >= pageLimit;
    const reachedEnd = publishItemCount === 0
      || publishItemCount < pageSize
      || (totalFromApi > 0 && begin + publishItemCount >= totalFromApi);
    if (reachedLimit || reachedMaxPages || reachedEnd) break;
    const nextBegin = begin + pageSize;
    if (!Number.isSafeInteger(nextBegin) || nextBegin <= begin) {
      throw new CommandExecutionError('WeChat article pagination could not advance safely');
    }
    begin = nextBegin;
  }

  return {
    articles,
    summary: { totalFromApi, scanned, valid: articles.length, invalid, duplicates, pages },
  };
}
