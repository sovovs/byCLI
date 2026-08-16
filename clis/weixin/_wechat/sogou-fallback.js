import {
  ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError,
} from '@sovovs/bycli/errors';
import { resolveWechatArticleUrl } from './article-link.js';
import { redactText } from './redact.js';
import {
  buildSogouSearchUrl,
  DEFAULT_SOGOU_MAX_PAGES,
  normalizePositiveInteger,
  searchSogouArticlePage,
} from './sogou-search.js';

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

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

function validCstEpochSeconds(year, month, day, hour, minute, second) {
  const epochMs = Date.UTC(year, month - 1, day, hour, minute, second) - CST_OFFSET_MS;
  const check = new Date(epochMs + CST_OFFSET_MS);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1
      || check.getUTCDate() !== day || check.getUTCHours() !== hour
      || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) return null;
  return Math.floor(epochMs / 1000);
}

export function normalizeSogouPublishTimestamp({
  publishTimestamp,
  publishTime,
  scanStartedAt,
}) {
  const raw = comparableTimestamp(publishTimestamp);
  if (raw !== null) return Math.floor(raw);
  const startMs = Number(scanStartedAt);
  if (!Number.isFinite(startMs)) return null;
  const text = String(publishTime ?? '').trim();

  const relative = text.match(/^(\d+)(分钟|小时|天)前$/);
  if (relative) {
    const amount = Number(relative[1]);
    const secondsPerUnit = { 分钟: 60, 小时: 3600, 天: 86400 }[relative[2]];
    if (!Number.isSafeInteger(amount)) return null;
    const timestamp = Math.floor(startMs / 1000) - amount * secondsPerUnit;
    return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
  }

  const dayWord = text.match(/^(昨天|前天)(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dayWord) {
    const cstNow = new Date(startMs + CST_OFFSET_MS);
    const dayOffset = dayWord[1] === '昨天' ? 1 : 2;
    const clock = dayWord[2] === undefined
      ? [cstNow.getUTCHours(), cstNow.getUTCMinutes(), cstNow.getUTCSeconds()]
      : [Number(dayWord[2]), Number(dayWord[3]), Number(dayWord[4] ?? 0)];
    const prior = new Date(Date.UTC(
      cstNow.getUTCFullYear(), cstNow.getUTCMonth(), cstNow.getUTCDate() - dayOffset,
    ));
    return validCstEpochSeconds(
      prior.getUTCFullYear(), prior.getUTCMonth() + 1, prior.getUTCDate(), ...clock,
    );
  }

  const absolute = text.match(
    /^(\d{4})(?:-(\d{1,2})-(\d{1,2})|\/(\d{1,2})\/(\d{1,2})|年(\d{1,2})月(\d{1,2})日)(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!absolute) return null;
  const month = Number(absolute[2] ?? absolute[4] ?? absolute[6]);
  const day = Number(absolute[3] ?? absolute[5] ?? absolute[7]);
  return validCstEpochSeconds(
    Number(absolute[1]), month, day,
    Number(absolute[8] ?? 0), Number(absolute[9] ?? 0), Number(absolute[10] ?? 0),
  );
}

function safeResolutionError(error) {
  const message = error instanceof Error ? error.message : 'Sogou article link resolution failed';
  return redactText(message, []) || 'Sogou article link resolution failed';
}

async function replaceWithFreshSogouPage(page, accountName) {
  if (typeof page?.closeWindow !== 'function'
      || typeof page?.newTab !== 'function'
      || typeof page?.setActivePage !== 'function') {
    throw new CommandExecutionError(
      'weixin Sogou fallback cannot create an isolated browser page',
      'Update byCLI and Browser Bridge, then retry the command.',
    );
  }
  const searchUrl = buildSogouSearchUrl(accountName, 1);
  let createdPage;
  try {
    await page.closeWindow();
    createdPage = await page.newTab(searchUrl);
    if (!createdPage) throw new Error('Browser Bridge returned no page identity');
    page.setActivePage(createdPage);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CommandExecutionError(
      'weixin Sogou fallback failed to create an isolated browser page',
      detail,
    );
  }
  return searchUrl;
}

export async function collectSogouAccountArticles({
  page,
  accountName,
  limit,
  maxPages,
  searchPage = searchSogouArticlePage,
  resolveUrl = resolveWechatArticleUrl,
  resolutionPolicy = 'atomic',
  scanStartedAt = Date.now(),
  freshPage = false,
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
  const preloadedFirstPageUrl = freshPage
    ? await replaceWithFreshSogouPage(page, normalizedName)
    : undefined;

  for (let pageNo = 1; pageNo <= pageLimit; pageNo += 1) {
    const result = await searchPage(page, {
      query: normalizedName,
      pageNo,
      preloadedUrl: pageNo === 1 ? preloadedFirstPageUrl : undefined,
    });
    pagesScanned += 1;
    if (result.state === 'empty') {
      coverage = result.reason === 'result-cap'
        ? 'result-cap-reached'
        : 'search-exhausted';
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
      candidates.push({
        ...item,
        firstSeen,
        sourceKey,
        normalizedTimestamp: normalizeSogouPublishTimestamp({
          publishTimestamp: item.publishTimestamp,
          publishTime: item.publishTime,
          scanStartedAt,
        }),
      });
      firstSeen += 1;
    }
  }

  if (candidates.length === 0) {
    let coverageHint;
    if (coverage === 'max-pages-reached') {
      coverageHint = `Scanned ${pagesScanned} pages and reached the page cap; later pages may still contain a match.`;
    } else if (coverage === 'result-cap-reached') {
      coverageHint = 'Sogou stopped anonymous browsing at its 100-result visibility cap; hidden results may still contain a match.';
    } else {
      coverageHint = `Sogou search exhausted after ${pagesScanned} pages.`;
    }
    throw new EmptyResultError(
      'weixin Sogou account fallback',
      `No Sogou articles matched the exact official-account name "${normalizedName}"; similarly named accounts were excluded. ${coverageHint}`,
    );
  }

  candidates.sort((left, right) => {
    const leftTime = left.normalizedTimestamp;
    const rightTime = right.normalizedTimestamp;
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
