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
  });

  it('returns explicit empty pages but stops on verification', async () => {
    const emptyPage = makePage({ blocked: false, empty: true, invalidCount: 0, rows: [] });
    await expect(searchSogouArticlePage(emptyPage, { query: 'Acct', pageNo: 1 }))
      .resolves.toMatchObject({ state: 'empty', page: 1, rows: [] });

    const blockedPage = makePage({ blocked: true, empty: false, invalidCount: 0, rows: [] });
    await expect(searchSogouArticlePage(blockedPage, { query: 'Acct', pageNo: 1 }))
      .rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('rejects unreadable payloads and partial cards', async () => {
    const unreadablePage = makePage(null);
    await expect(searchSogouArticlePage(unreadablePage, { query: 'Acct', pageNo: 1 }))
      .rejects.toBeInstanceOf(CommandExecutionError);

    const malformedPage = makePage({ blocked: false, empty: false, invalidCount: 1, rows: [] });
    await expect(searchSogouArticlePage(malformedPage, { query: 'Acct', pageNo: 1 }))
      .rejects.toBeInstanceOf(CommandExecutionError);
  });
});
