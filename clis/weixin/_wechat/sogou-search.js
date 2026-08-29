import {
  ArgumentError, AuthRequiredError, CommandExecutionError,
} from '@sovovs/bycli/errors';

const SOGOU_WEIXIN_DOMAIN = 'weixin.sogou.com';
export const DEFAULT_SOGOU_MAX_PAGES = 50;
const MAX_SOGOU_SHELL_ATTEMPTS = 2;
const SOGOU_SHELL_RETRY_DELAY_SECONDS = 2;

export function normalizePositiveInteger(value, name, defaultValue, maxValue) {
  if (value === undefined || value === null) return defaultValue;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new ArgumentError(
      `weixin sougousearch --${name} must be a positive integer`,
      `Pass --${name} as a whole number${maxValue ? ` from 1 to ${maxValue}` : ' greater than 0'}.`,
    );
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || (maxValue && parsed > maxValue)) {
    throw new ArgumentError(
      `weixin sougousearch --${name} is out of range`,
      `Pass --${name} as a whole number${maxValue ? ` from 1 to ${maxValue}` : ' greater than 0'}.`,
    );
  }
  return parsed;
}

export function buildSogouSearchUrl(query, pageNo) {
  const searchUrl = new URL('https://weixin.sogou.com/weixin');
  searchUrl.searchParams.set('query', query);
  searchUrl.searchParams.set('type', '2');
  searchUrl.searchParams.set('page', String(pageNo));
  searchUrl.searchParams.set('ie', 'utf8');
  return searchUrl.toString();
}

export function buildExtractSogouSearchResultsEvaluate() {
  return String.raw`(() => {
    const clean = (value) => {
      return (value || '')
        .replace(/\s+/g, ' ')
        .replace(/<!--red_beg-->|<!--red_end-->/g, '')
        .replace(/document\.write\(timeConvert\(['"]\d+['"]\)\)/g, '')
        .trim();
    };

    const absolutize = (href) => {
      if (!href) return '';
      try {
        return new URL(href, window.location.origin).toString();
      } catch {
        return href;
      }
    };

    const bodyText = clean(document.body && (document.body.innerText || document.body.textContent));
    const blocked = /验证码|安全验证|异常访问|访问过于频繁|请输入验证码/.test(bodyText);
    const resultCap = /当前只显示\s*100\s*条结果/.test(bodyText);
    const empty = resultCap
      || /没有找到相关的微信文章|未找到相关|暂无相关|没有找到/.test(bodyText)
      || Boolean(document.querySelector('.no-result, .no_result, .s-noresult'));
    const cards = Array.from(document.querySelectorAll('.news-list li'));
    const extracted = cards.map((item) => {
      const linkEl = item.querySelector('h3 a[href]');
      const summaryEl = item.querySelector('p.txt-info');
      const accountEl = item.querySelector('.s-p .all-time-y2');
      const timeEl = item.querySelector('.s-p .s2');
      const rawTimeHtml = timeEl && timeEl.innerHTML || '';
      const timestampMatch = rawTimeHtml.match(/timeConvert\(['"](\d{10,13})['"]\)/);
      return {
        title: clean(linkEl && linkEl.textContent),
        account: clean(accountEl && accountEl.textContent),
        url: absolutize(linkEl && linkEl.getAttribute('href')),
        summary: clean(summaryEl && summaryEl.textContent),
        publishTime: clean(timeEl && timeEl.textContent),
        publishTimestamp: timestampMatch ? Number(timestampMatch[1]) : null,
      };
    });
    const rows = extracted.filter((row) => row.title && row.url);

    return {
      blocked,
      empty,
      resultCap,
      invalidCount: extracted.length - rows.length,
      rows,
    };
  })()`;
}

function fingerprintRows(rows) {
  return rows.map(row => `${row.title}\u0000${row.url}`).join('\u0001');
}

function buildSogouRetryUrl(searchUrl, retryNo) {
  const retryUrl = new URL(searchUrl);
  retryUrl.searchParams.set('_bycli_retry', String(retryNo));
  return retryUrl.toString();
}

async function loadSogouPayload(page, searchUrl, delayBeforeSeconds = 0, navigate = true) {
  try {
    if (delayBeforeSeconds > 0) await page.wait(delayBeforeSeconds);
    if (navigate) await page.goto(searchUrl);
    await page.wait(2);
    return await page.evaluate(buildExtractSogouSearchResultsEvaluate());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CommandExecutionError(
      'weixin sougousearch failed while loading Sogou results',
      detail,
    );
  }
}

export async function searchSogouArticlePage(page, { query, pageNo, preloadedUrl }) {
  const normalizedQuery = String(query ?? '').trim();
  if (!normalizedQuery) {
    throw new ArgumentError(
      'A search query is required.',
      'Pass a non-empty keyword to search Weixin articles via Sogou.',
    );
  }
  const normalizedPage = normalizePositiveInteger(pageNo, 'page', 1);
  const searchUrl = buildSogouSearchUrl(normalizedQuery, normalizedPage);
  for (let attempt = 1; attempt <= MAX_SOGOU_SHELL_ATTEMPTS; attempt += 1) {
    const usePreloadedPage = attempt === 1 && preloadedUrl === searchUrl;
    const navigationUrl = attempt === 1
      ? searchUrl
      : buildSogouRetryUrl(searchUrl, attempt - 1);
    const payload = await loadSogouPayload(
      page,
      navigationUrl,
      attempt > 1 ? SOGOU_SHELL_RETRY_DELAY_SECONDS : 0,
      !usePreloadedPage,
    );
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.rows)) {
      throw new CommandExecutionError(
        'weixin sougousearch returned an unreadable browser payload',
        'Sogou Weixin may have changed its result page structure.',
      );
    }
    if (payload.blocked) {
      throw new AuthRequiredError(
        SOGOU_WEIXIN_DOMAIN,
        'Sogou Weixin requires verification. Complete it in the retained browser tab and explicitly confirm completion to the caller.',
      );
    }
    if (payload.invalidCount > 0) {
      throw new CommandExecutionError(
        'Sogou Weixin returned article cards without required title or URL',
        'The result page structure may have changed; refusing to return a partial result set.',
      );
    }
    if (payload.rows.length === 0 && payload.empty) {
      return {
        state: 'empty',
        reason: payload.resultCap ? 'result-cap' : 'no-results',
        page: normalizedPage,
        fingerprint: '',
        rows: [],
      };
    }
    if (payload.rows.length > 0) {
      return {
        state: 'results',
        page: normalizedPage,
        fingerprint: fingerprintRows(payload.rows),
        rows: payload.rows,
      };
    }
  }
  throw new CommandExecutionError(
    'weixin sougousearch did not expose article result cards',
    'Sogou Weixin returned a transient shell page on both bounded attempts.',
  );
}
