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

  it('renavigates once when the first valid payload is an ambiguous shell', async () => {
    const page = makePage(shellPayload);
    page.evaluate.mockResolvedValueOnce(shellPayload).mockResolvedValueOnce(resultPayload);

    await expect(searchSogouArticlePage(page, { query: 'Acct', pageNo: 2 }))
      .resolves.toMatchObject({ state: 'results', page: 2, rows: resultPayload.rows });
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(page.goto.mock.calls[0][0]).toBe(page.goto.mock.calls[1][0]);
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
    await expect(searchSogouArticlePage(blockedPage, { query: 'Acct', pageNo: 1 }))
      .rejects.toBeInstanceOf(AuthRequiredError);
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
