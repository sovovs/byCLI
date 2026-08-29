import { JSDOM } from 'jsdom';
import { getRegistry } from '@sovovs/bycli/registry';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadArticle } from '@sovovs/bycli/download/article-download';
import { withAdapterResourceLocks } from '@sovovs/bycli/adapter-coordination';
import { validateDownloadedArticleRows } from './_wechat/article-artifact.js';
vi.mock('@sovovs/bycli/download/article-download', () => ({ downloadArticle: vi.fn() }));
vi.mock('@sovovs/bycli/adapter-coordination', () => ({
  assertCurrentAdapterLease: vi.fn(),
  withAdapterResourceLocks: vi.fn((_keys, operation) => operation()),
}));
vi.mock('./_wechat/article-artifact.js', () => ({
  validateDownloadedArticleRows: vi.fn(async rows => rows),
}));
import {
  detectWechatAccessIssue, extractWechatArticleContent, extractWechatPublishTime,
  isTrustedSogouRedirectUrl, isTrustedWechatArticleUrl, normalizeWechatUrl,
} from './download.js';

beforeEach(() => {
  vi.clearAllMocks();
  withAdapterResourceLocks.mockImplementation((_keys, operation) => operation());
  validateDownloadedArticleRows.mockImplementation(async rows => rows);
  downloadArticle.mockResolvedValue([{
    title: 'Article', author: 'Account', publish_time: '2026-08-15',
    status: 'success', size: '1 KB', saved: '/tmp/article.md',
  }]);
});

describe('weixin download characterization', () => {
  it('declares isolated Adapter tabs with a maximum of three workers', () => {
    expect(getRegistry().get('weixin/download').adapterConcurrency)
      .toEqual({ isolatedTabs: true, maxParallel: 3 });
  });
  it('keeps URL, publish-time, and access-gate outputs stable', () => {
    expect(normalizeWechatUrl(' <http:\\/\\/mp.weixin.qq.com\\/s\\/x?foo=1&amp;bar=2> '))
      .toBe('https://mp.weixin.qq.com/s/x?foo=1&bar=2');
    expect(extractWechatPublishTime(' 2026-01-02 ', '<html>')).toBe('2026-01-02');
    expect(extractWechatPublishTime('', 'var x={create_time:1704067200};')).toBe('2024-01-01 08:00:00');
    expect(detectWechatAccessIssue('环境异常 去验证', '<html>')).toBe('environment verification required');
    expect(detectWechatAccessIssue('article', '<html>')).toBe('');
  });

  it('requires explicit human completion without instructing an automatic rerun', async () => {
    const command = getRegistry().get('weixin/download');
    const page = {
      goto: vi.fn(),
      wait: vi.fn(),
      evaluate: vi.fn().mockResolvedValue({
        title: '', author: '', publishTime: '', contentHtml: '', codeBlocks: [],
        imageUrls: [], errorHint: 'environment verification required',
      }),
    };

    const error = await command.func(page, {
      url: 'https://mp.weixin.qq.com/s/article',
      output: '/tmp/out',
    }).catch(value => value);

    expect(error).toMatchObject({ name: 'AuthRequiredError', code: 'AUTH_REQUIRED' });
    expect(error.message).toContain('explicitly confirm completion');
    expect(error.message).not.toContain('run the command again');
  });

  it('re-exports the shared content extractor', () => {
    const document = new JSDOM('<div id="js_content"><p>body</p></div>').window.document;
    expect(extractWechatArticleContent(document).contentHtml).toBe('<p>body</p>');
  });

  it('accepts only trusted WeChat articles and Sogou result redirects', () => {
    expect(isTrustedWechatArticleUrl('https://mp.weixin.qq.com/s/abc')).toBe(true);
    expect(isTrustedWechatArticleUrl('https://mp.weixin.qq.com/s?__biz=x')).toBe(true);
    expect(isTrustedWechatArticleUrl('https://mp.weixin.qq.com.evil.test/s/abc')).toBe(false);
    expect(isTrustedWechatArticleUrl('http://mp.weixin.qq.com/s/abc')).toBe(false);
    expect(isTrustedSogouRedirectUrl('https://weixin.sogou.com/link?url=abc')).toBe(true);
    expect(isTrustedSogouRedirectUrl('https://weixin.sogou.com/weixin?query=x')).toBe(false);
    expect(isTrustedSogouRedirectUrl('https://user@weixin.sogou.com/link?url=abc')).toBe(false);
  });

  it('downloads a direct WeChat URL and exposes source and resolved URLs', async () => {
    const command = getRegistry().get('weixin/download');
    const url = 'https://mp.weixin.qq.com/s/direct';
    const page = {
      goto: vi.fn(), wait: vi.fn(),
      evaluate: vi.fn().mockResolvedValue({
        title: 'Article', author: 'Account', publishTime: '2026-08-15',
        contentHtml: '<p>body</p>', codeBlocks: [], imageUrls: [], errorHint: '',
      }),
    };

    await expect(command.func(page, { url, output: '/tmp/out', 'download-images': false })).resolves.toEqual([{
      title: 'Article', author: 'Account', publish_time: '2026-08-15', status: 'success',
      size: '1 KB', saved: '/tmp/article.md', source_url: url, resolved_url: url,
    }]);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith(url);
    expect(downloadArticle).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: url }), expect.any(Object));
    expect(withAdapterResourceLocks).toHaveBeenCalledWith([
      expect.stringMatching(/^article:[a-f0-9]{64}$/),
      expect.stringMatching(/^output:[a-f0-9]{64}$/),
    ], expect.any(Function));
    expect(validateDownloadedArticleRows).toHaveBeenCalledWith(expect.any(Array), '/tmp/out');
  });

  it('resolves a Sogou result link before extracting and records both URLs', async () => {
    const command = getRegistry().get('weixin/download');
    const sourceUrl = 'https://weixin.sogou.com/link?url=encoded';
    const resolvedUrl = 'https://mp.weixin.qq.com/s/resolved';
    const page = {
      goto: vi.fn(), wait: vi.fn(),
      evaluate: vi.fn()
        .mockResolvedValueOnce({ finalUrl: resolvedUrl, pageText: '公众号正文', html: '<html></html>' })
        .mockResolvedValueOnce({
          title: 'Article', author: 'Account', publishTime: '', contentHtml: '<p>body</p>',
          codeBlocks: [], imageUrls: [], errorHint: '',
        }),
    };

    const rows = await command.func(page, { url: sourceUrl, output: '/tmp/out' });

    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith(sourceUrl);
    expect(rows[0]).toMatchObject({ source_url: sourceUrl, resolved_url: resolvedUrl });
    expect(downloadArticle).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: resolvedUrl }), expect.any(Object));
  });

  it('rejects invalid input, Sogou verification, and untrusted redirect destinations', async () => {
    const command = getRegistry().get('weixin/download');
    const makePage = payload => ({
      goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValue(payload),
    });

    await expect(command.func(makePage({}), { url: 'https://example.com/article' }))
      .rejects.toMatchObject({ name: 'ArgumentError', code: 'ARGUMENT' });
    await expect(command.func(makePage({
      finalUrl: 'https://weixin.sogou.com/antispider/?from=%2Flink', pageText: '请输入验证码 安全验证', html: '',
    }), { url: 'https://weixin.sogou.com/link?url=x' }))
      .rejects.toMatchObject({ name: 'AuthRequiredError', code: 'AUTH_REQUIRED' });
    await expect(command.func(makePage({
      finalUrl: 'https://evil.test/article', pageText: '', html: '<html></html>',
    }), { url: 'https://weixin.sogou.com/link?url=x' }))
      .rejects.toMatchObject({ name: 'CommandExecutionError', code: 'COMMAND_EXEC' });
    expect(downloadArticle).not.toHaveBeenCalled();
  });
});
