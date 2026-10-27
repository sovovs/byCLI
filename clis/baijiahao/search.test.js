import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { searchCommand } from './search.js';
import { searchOptions, searchRows, searchSnapshot, searchUrl } from './_shared/search.js';
import { publicTarget } from './_shared/model.js';
import { videoDownloadCommand } from './video-download.js';

const html = readFileSync(new URL('./__fixtures__/search.html', import.meta.url), 'utf8');
function browser(markup = html) {
  const dom = new JSDOM(markup, { url: searchUrl('科普'), runScripts: 'outside-only' });
  return { dom, page: {
    goto: vi.fn(async url => dom.reconfigure({ url })), wait: vi.fn(async () => {}),
    evaluate: vi.fn(async code => dom.window.eval(code)),
  }, snapshot: () => dom.window.eval(`(${searchSnapshot.toString()})()`) };
}

describe('Baijiahao public video search through native Haokan', () => {
  it('registers the native public video entry and validates before navigation', async () => {
    expect(searchCommand).toMatchObject({ site: 'baijiahao', name: 'search', domain: 'haokan.baidu.com', browser: true, strategy: 'public' });
    const u = new URL(searchUrl('航天 & 科普#入门'));
    expect(u.searchParams.get('query')).toBe('航天 & 科普#入门');
    expect(u.pathname).toBe('/web/search/page'); expect(u.searchParams.get('tab')).toBe('video');
    const b = browser();
    try {
      for (const args of [{ query: '' }, { query: 'x'.repeat(256) }, { query: 'x', limit: 0 }, { query: 'x', limit: 51 }, { query: 'x', timeout: 121 }]) {
        expect(() => searchOptions(args)).toThrow();
        await expect(searchCommand.func(b.page, args)).rejects.toMatchObject({ code: 'ARGUMENT' });
      }
      expect(b.page.goto).not.toHaveBeenCalled();
    } finally { b.dom.window.close(); }
  });

  it('extracts only native results, keeps precise IDs and emits downloader-compatible URLs', async () => {
    const b = browser();
    try {
      const rows = await searchCommand.func(b.page, { query: '科普', limit: 2 });
      expect(rows).toHaveLength(2);
      expect(Object.keys(rows[0])).toEqual(searchCommand.columns);
      expect(rows[0]).toEqual({ rank: 1, id: '10637456184973686790', title: '#科普', author: '姜姜医师', duration: '00:34', playsText: '1.1万次播放', publishedAtText: '9个月前', url: 'https://haokan.baidu.com/v?vid=10637456184973686790', source: 'haokan' });
      for (const row of rows) {
        expect(publicTarget(row.url).id).toBe(row.id);
        expect(() => videoDownloadCommand.validateArgs({ url: row.url, output: '/tmp/search-download-test' })).not.toThrow();
      }
      expect(b.page.goto).toHaveBeenCalledWith(searchUrl('科普'), { stealth: false });
    } finally { b.dom.window.close(); }
  });

  it('deduplicates canonical identities and rejects foreign/preview links', () => {
    const b = browser();
    try {
      const state = b.snapshot(); state.items.push({ ...state.items[0], url: state.items[0].url + '&tracking=x' });
      expect(searchRows(state, '科普')).toHaveLength(2);
      for (const url of ['https://haokan.baidu.com.evil/v?vid=123', 'https://baijiahao.baidu.com/builder/preview/s?id=123']) {
        expect(() => searchRows({ ...state, items: [{ ...state.items[0], url }] }, '科普')).toThrow();
      }
    } finally { b.dom.window.close(); }
  });

  it('does not treat homepage, wrong query, author tab or verification as video results', () => {
    const b = browser();
    try {
      const state = b.snapshot();
      for (const url of ['chrome-error://chromewebdata/', 'https://haokan.baidu.com/', searchUrl('其他'), searchUrl('科普') + '&tab=user']) {
        expect(() => searchRows({ ...state, url }, '科普')).toThrow();
      }
      expect(searchRows({ ...state, query: '旧查询' }, '科普')).toBeNull();
      expect(searchRows({ ...state, activeTab: '作者' }, '科普')).toBeNull();
      expect(() => searchRows({ ...state, blocked: true }, '科普')).toThrow(/verification/);
    } finally { b.dom.window.close(); }
  });

  it('scrolls the actual search list and waits for appended results', async () => {
    const b = browser();
    try {
      b.dom.window.scrollBy = vi.fn();
      b.dom.window.scrollTo = vi.fn(() => {
        const clone = b.dom.window.document.querySelector('a.videolist').cloneNode(true);
        clone.href = 'https://haokan.baidu.com/v?vid=12345678901234567890';
        b.dom.window.document.querySelector('.message-list').append(clone);
      });
      const rows = await searchCommand.func(b.page, { query: '科普', limit: 3 });
      expect(rows.map(r => r.id)).toEqual(['10637456184973686790', '3950447640891158653', '12345678901234567890']);
      expect(b.dom.window.scrollTo).toHaveBeenCalledOnce();
    } finally { b.dom.window.close(); }
  });

  it('returns fewer rows only with an end marker, and distinguishes empty from pending', async () => {
    const b = browser(html + '<div class="tabs-content"><p class="message-list-footer">没有更多搜索结果了哦～</p></div>');
    try { expect(await searchCommand.func(b.page, { query: '科普', limit: 10 })).toHaveLength(2); }
    finally { b.dom.window.close(); }
    const empty = browser('<input id="search_input" value="科普"><div role="tab" aria-selected="true">视频</div><div class="tabs-content"><div class="msg-empty-list"><h5 class="msg-empty-tips">抱歉没有找到相关内容</h5></div></div>');
    try { await expect(searchCommand.func(empty.page, { query: '科普' })).rejects.toMatchObject({ code: 'EMPTY_RESULT' }); }
    finally { empty.dom.window.close(); }
    const pending = browser('<input id="search_input" value="科普"><div role="tab" aria-selected="true">视频</div><div class="tabs-content"><div class="message-list"></div></div>');
    try { await expect(searchCommand.func(pending.page, { query: '科普', timeout: 1 })).rejects.toMatchObject({ code: 'TIMEOUT' }); }
    finally { pending.dom.window.close(); }
  });
});
