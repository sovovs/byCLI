import {
  ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError,
} from '@sovovs/bycli/errors';
import { resolveWechatArticleUrl } from './article-link.js';
import { redactText } from './redact.js';
import {
  DEFAULT_SOGOU_MAX_PAGES,
  normalizePositiveInteger,
  searchSogouArticlePage,
} from './sogou-search.js';

export function isExactAccountName(actual, expected) {
  const normalizedActual = String(actual ?? '').trim().toLowerCase();
  const normalizedExpected = String(expected ?? '').trim().toLowerCase();
  return normalizedExpected.length > 0 && normalizedActual === normalizedExpected;
}

function normalizedUrl(raw) {
  try {
    return new URL(raw).href;
  } catch {
    return String(raw ?? '').trim();
  }
}

function comparableTimestamp(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value >= 1_000_000_000_000 ? Math.floor(value / 1000) : value;
}

function safeResolutionError(error) {
  const message = error instanceof Error ? error.message : 'Sogou article link resolution failed';
  return redactText(message, []) || 'Sogou article link resolution failed';
}

export async function collectSogouAccountArticles({
  page,
  accountName,
  limit,
  maxPages,
  searchPage = searchSogouArticlePage,
  resolveUrl = resolveWechatArticleUrl,
  resolutionPolicy = 'atomic',
}) {
  const normalizedName = String(accountName ?? '').trim();
  if (!normalizedName) {
    throw new ArgumentError(
      'weixin Sogou fallback requires --name',
      'Pass the exact official-account name with --name.',
    );
  }
  if (!['atomic', 'rows'].includes(resolutionPolicy)) {
    throw new ArgumentError('Invalid Sogou fallback resolution policy');
  }
  const pageLimit = normalizePositiveInteger(
    maxPages,
    'max-pages',
    DEFAULT_SOGOU_MAX_PAGES,
  );
  const articleLimit = limit === undefined || limit === null
    ? null : normalizePositiveInteger(limit, 'limit');
  const seenFingerprints = new Set();
  const seenSogouUrls = new Set();
  const candidates = [];
  let pagesScanned = 0;
  let coverage = 'max-pages-reached';
  let firstSeen = 0;

  for (let pageNo = 1; pageNo <= pageLimit; pageNo += 1) {
    const result = await searchPage(page, { query: normalizedName, pageNo });
    pagesScanned += 1;
    if (result.state === 'empty') {
      coverage = 'search-exhausted';
      break;
    }
    if (seenFingerprints.has(result.fingerprint)) {
      throw new CommandExecutionError(
        'Sogou Weixin repeated a result page while scanning account articles',
        `Page ${pageNo} repeated an earlier page; refusing to return a partial article index.`,
      );
    }
    seenFingerprints.add(result.fingerprint);
    for (const item of result.rows) {
      if (!isExactAccountName(item.account, normalizedName)) continue;
      const sourceKey = normalizedUrl(item.url);
      if (seenSogouUrls.has(sourceKey)) continue;
      seenSogouUrls.add(sourceKey);
      candidates.push({ ...item, firstSeen, sourceKey });
      firstSeen += 1;
    }
  }

  if (candidates.length === 0) {
    throw new EmptyResultError(
      'weixin Sogou account fallback',
      `No Sogou articles matched the exact official-account name "${normalizedName}"; similarly named accounts were excluded.`,
    );
  }

  candidates.sort((left, right) => {
    const leftTime = comparableTimestamp(left.publishTimestamp);
    const rightTime = comparableTimestamp(right.publishTimestamp);
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return rightTime - leftTime;
    if (leftTime !== null && rightTime === null) return -1;
    if (leftTime === null && rightTime !== null) return 1;
    return left.firstSeen - right.firstSeen;
  });

  const seenResolvedUrls = new Set();
  const articles = [];
  const resolutionFailures = [];
  let terminalCount = 0;
  for (const candidate of candidates) {
    if (articleLimit !== null && terminalCount >= articleLimit) break;
    try {
      const resolved = await resolveUrl(page, candidate.url);
      const resolvedKey = normalizedUrl(resolved.resolvedUrl);
      if (seenResolvedUrls.has(resolvedKey)) continue;
      seenResolvedUrls.add(resolvedKey);
      articles.push({
        title: candidate.title,
        author: null,
        digest: candidate.summary || null,
        publishedAt: candidate.publishTime || null,
        url: resolved.resolvedUrl,
        sourceUrl: resolved.sourceUrl,
        order: terminalCount,
      });
      terminalCount += 1;
    } catch (error) {
      if (error instanceof AuthRequiredError || resolutionPolicy === 'atomic') throw error;
      resolutionFailures.push({
        title: candidate.title,
        status: 'failed',
        stage: 'resolve',
        error: safeResolutionError(error),
        url: candidate.url,
        order: terminalCount,
      });
      terminalCount += 1;
    }
  }

  return {
    source: 'sogou',
    coverage,
    pagesScanned,
    articles,
    resolutionFailures,
  };
}
