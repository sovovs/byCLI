/** @param {any} article */
export function isUsableArticle(article) {
  return Boolean(article)
    && article.isDeleted !== true
    && typeof article.url === 'string'
    && article.url.length > 0
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
    if (pages === 1) totalFromApi = typeof page?.total === 'number' ? page.total : 0;
    const rawArticles = Array.isArray(page?.articles) ? page.articles : [];
    const publishItemCount = Number.isInteger(page?.publishItemCount) && page.publishItemCount >= 0
      ? page.publishItemCount : 0;

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
      if (limit && articles.length >= limit) break;
    }

    const reachedLimit = Boolean(limit && articles.length >= limit);
    const reachedMaxPages = Boolean(maxPages && pages >= maxPages);
    const reachedEnd = publishItemCount === 0
      || publishItemCount < pageSize
      || (totalFromApi > 0 && begin + publishItemCount >= totalFromApi);
    if (reachedLimit || reachedMaxPages || reachedEnd) break;
    begin += pageSize;
  }

  return {
    articles,
    summary: { totalFromApi, scanned, valid: articles.length, invalid, duplicates, pages },
  };
}
