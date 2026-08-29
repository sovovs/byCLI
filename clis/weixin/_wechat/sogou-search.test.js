import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import {
  buildExtractSogouSearchResultsEvaluate,
  buildSogouSearchUrl,
  normalizePositiveInteger,
  searchSogouArticlePage,
} from './sogou-search.js';

function makePage(payload) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(payload),
  };
}

const shellPayload = { blocked: false, empty: false, invalidCount: 0, rows: [] };
const emptyPayload = { blocked: false, empty: true, invalidCount: 0, rows: [] };
const resultPayload = {
  blocked: false,
  empty: false,
  invalidCount: 0,
  rows: [{
    title: 'Recovered', account: 'Acct',
    url: 'https://weixin.sogou.com/link?url=recovered',
    summary: '', publishTime: 'today', publishTimestamp: 10,
  }],
};

describe('Sogou Weixin page search helper', () => {
  it('validates positive integers and encodes page URLs', () => {
    expect(normalizePositiveInteger(undefined, 'page', 1)).toBe(1);
    expect(normalizePositiveInteger('2', 'page', 1)).toBe(2);
    expect(() => normalizePositiveInteger('0', 'page', 1)).toThrow(ArgumentError);
    expect(() => normalizePositiveInteger('2.5', 'page', 1)).toThrow(ArgumentError);
    expect(buildSogouSearchUrl('AI 搜索', 2)).toBe(
      'https://weixin.sogou.com/weixin?query=AI+%E6%90%9C%E7%B4%A2&type=2&page=2&ie=utf8',
    );
  });

  it('extracts rendered time and its raw Unix timestamp from result cards', () => {
    const dom = new JSDOM(`
      <ul class="news-list"><li>
        <h3><a href="/link?url=x"> First result </a></h3>
        <p class="txt-info"> Summary </p>
        <div class="s-p"><a class="all-time-y2"> Test Account </a>
          <span class="s2">2026-08-16<script>document.write(timeConvert('1786800000'))</script></span>
        </div>
      </li></ul>
    `, { url: 'https://weixin.sogou.com/weixin?query=x', runScripts: 'outside-only' });

    const payload = dom.window.eval(buildExtractSogouSearchResultsEvaluate());

    expect(payload).toMatchObject({ blocked: false, empty: false, invalidCount: 0 });
    expect(payload.rows).toEqual([{
      title: 'First result',
      account: 'Test Account',
      url: 'https://weixin.sogou.com/link?url=x',
      summary: 'Summary',
      publishTime: '2026-08-16',
      publishTimestamp: 1786800000,
    }]);
  });

  it('returns a stable result envelope and fingerprint', async () => {
    const page = makePage({
      blocked: false,
      empty: false,
      invalidCount: 0,
      rows: [{
        title: 'A', account: 'Acct', url: 'https://weixin.sogou.com/link?url=a',
        summary: '', publishTime: 'today', publishTimestamp: 10,
      }],
    });

    await expect(searchSogouArticlePage(page, { query: 'Acct', pageNo: 2 })).resolves.toEqual({
      state: 'results',
      page: 2,
      fingerprint: expect.any(String),
      rows: [{
        title: 'A', account: 'Acct', url: 'https://weixin.sogou.com/link?url=a',
        summary: '', publishTime: 'today', publishTimestamp: 10,
      }],
    });
    expect(page.wait).toHaveBeenCalledWith(2);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it('parses an explicitly preloaded matching search URL without navigating again', async () => {
    const page = makePage(resultPayload);
    const preloadedUrl = buildSogouSearchUrl('Acct', 1);

    await expect(searchSogouArticlePage(page, {
      query: 'Acct', pageNo: 1, preloadedUrl,
    })).resolves.toMatchObject({ state: 'results', page: 1, rows: resultPayload.rows });
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.wait).toHaveBeenCalledTimes(1);
  });

  it('ignores a preloaded URL that does not match the requested logical page', async () => {
    const page = makePage(resultPayload);

    await searchSogouArticlePage(page, {
      query: 'Acct', pageNo: 2, preloadedUrl: buildSogouSearchUrl('Acct', 1),
    });

    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it('forces one distinct-URL reload when a matching preloaded page is a shell', async () => {
    const page = makePage(shellPayload);
    page.evaluate.mockResolvedValueOnce(shellPayload).mockResolvedValueOnce(resultPayload);

    await expect(searchSogouArticlePage(page, {
      query: 'Acct', pageNo: 1, preloadedUrl: buildSogouSearchUrl('Acct', 1),
    })).resolves.toMatchObject({ state: 'results', rows: resultPayload.rows });

    expect(page.goto).toHaveBeenCalledTimes(1);
    const retryUrl = new URL(page.goto.mock.calls[0][0]);
    expect(retryUrl.searchParams.get('query')).toBe('Acct');
    expect(retryUrl.searchParams.get('page')).toBe('1');
    expect(retryUrl.searchParams.get('_bycli_retry')).toBe('1');
    expect(page.wait.mock.calls.map(([seconds]) => seconds)).toEqual([2, 2, 2]);
  });

  it('forces one distinct-URL reload when the first valid payload is an ambiguous shell', async () => {
    const page = makePage(shellPayload);
    page.evaluate.mockResolvedValueOnce(shellPayload).mockResolvedValueOnce(resultPayload);

    await expect(searchSogouArticlePage(page, { query: 'Acct', pageNo: 2 }))
      .resolves.toMatchObject({ state: 'results', page: 2, rows: resultPayload.rows });
    expect(page.goto).toHaveBeenCalledTimes(2);
    const [initialUrl, retryUrl] = page.goto.mock.calls.map(([url]) => new URL(url));
    expect(initialUrl.searchParams.get('_bycli_retry')).toBeNull();
    expect(retryUrl.searchParams.get('query')).toBe('Acct');
    expect(retryUrl.searchParams.get('page')).toBe('2');
    expect(retryUrl.searchParams.get('_bycli_retry')).toBe('1');
    expect(page.wait.mock.calls.map(([seconds]) => seconds)).toEqual([2, 2, 2]);
  });

  it('accepts an explicit empty page after one ambiguous-shell retry', async () => {
    const page = makePage(shellPayload);
    page.evaluate.mockResolvedValueOnce(shellPayload).mockResolvedValueOnce(emptyPayload);

    await expect(searchSogouArticlePage(page, { query: 'Acct', pageNo: 1 }))
      .resolves.toMatchObject({ state: 'empty', page: 1, rows: [] });
    expect(page.goto).toHaveBeenCalledTimes(2);
  });

  it('fails after two ambiguous shells without unbounded navigation', async () => {
    const page = makePage(shellPayload);

    await expect(searchSogouArticlePage(page, { query: 'Acct', pageNo: 1 }))
      .rejects.toMatchObject({ code: 'COMMAND_EXEC' });
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(page.wait).toHaveBeenCalledTimes(3);
  });

  it('wraps a retry-delay failure without performing a second navigation', async () => {
    const page = makePage(shellPayload);
    page.wait
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('retry delay failed'));

    await expect(searchSogouArticlePage(page, { query: 'Acct', pageNo: 1 }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it('returns explicit empty pages but stops on verification', async () => {
    const emptyPage = makePage({ blocked: false, empty: true, invalidCount: 0, rows: [] });
    await expect(searchSogouArticlePage(emptyPage, { query: 'Acct', pageNo: 1 }))
      .resolves.toMatchObject({ state: 'empty', page: 1, rows: [] });
    expect(emptyPage.goto).toHaveBeenCalledTimes(1);

    const blockedPage = makePage({ blocked: true, empty: false, invalidCount: 0, rows: [] });
    const error = await searchSogouArticlePage(
      blockedPage,
      { query: 'Acct', pageNo: 1 },
    ).catch(value => value);
    expect(error).toBeInstanceOf(AuthRequiredError);
    expect(error.message).toContain('explicitly confirm completion');
    expect(error.message).not.toContain('run the command again');
    expect(blockedPage.goto).toHaveBeenCalledTimes(1);
  });

  it('rejects unreadable payloads and partial cards', async () => {
    const unreadablePage = makePage(null);
    await expect(searchSogouArticlePage(unreadablePage, { query: 'Acct', pageNo: 1 }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    expect(unreadablePage.goto).toHaveBeenCalledTimes(1);

    const malformedPage = makePage({ blocked: false, empty: false, invalidCount: 1, rows: [] });
    await expect(searchSogouArticlePage(malformedPage, { query: 'Acct', pageNo: 1 }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    expect(malformedPage.goto).toHaveBeenCalledTimes(1);
  });

  it('does not retry a navigation failure', async () => {
    const page = makePage(resultPayload);
    page.goto.mockRejectedValue(new Error('navigation failed'));

    await expect(searchSogouArticlePage(page, { query: 'Acct', pageNo: 1 }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    expect(page.goto).toHaveBeenCalledTimes(1);
    });
  });

  it('recognizes Sogou anonymous 100-result cap as an explicit terminal page', async () => {
    const dom = new JSDOM(`
      <div id="noresult_part1_container">
        <p>呀！</p>
        <p>当前只显示100条结果，请您：登录后查看更多结果，或者返回微信搜索首页</p>
      </div>
    `, { url: 'https://weixin.sogou.com/weixin?query=x&page=11', runScripts: 'outside-only' });
    const payload = dom.window.eval(buildExtractSogouSearchResultsEvaluate());
    const page = makePage(payload);

    expect(payload).toMatchObject({ empty: true, resultCap: true, rows: [] });
    await expect(searchSogouArticlePage(page, { query: 'x', pageNo: 11 }))
      .resolves.toMatchObject({ state: 'empty', reason: 'result-cap', page: 11 });
    expect(page.goto).toHaveBeenCalledTimes(1);
  });
