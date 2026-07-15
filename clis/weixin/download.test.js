import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  detectWechatAccessIssue, extractWechatArticleContent, extractWechatPublishTime, normalizeWechatUrl,
} from './download.js';

describe('weixin download characterization', () => {
  it('keeps URL, publish-time, and access-gate outputs stable', () => {
    expect(normalizeWechatUrl(' <http:\\/\\/mp.weixin.qq.com\\/s\\/x?foo=1&amp;bar=2> '))
      .toBe('https://mp.weixin.qq.com/s/x?foo=1&bar=2');
    expect(extractWechatPublishTime(' 2026-01-02 ', '<html>')).toBe('2026-01-02');
    expect(extractWechatPublishTime('', 'var x={create_time:1704067200};')).toBe('2024-01-01 08:00:00');
    expect(detectWechatAccessIssue('环境异常 去验证', '<html>')).toBe('environment verification required');
    expect(detectWechatAccessIssue('article', '<html>')).toBe('');
  });

  it('re-exports the shared content extractor', () => {
    const document = new JSDOM('<div id="js_content"><p>body</p></div>').window.document;
    expect(extractWechatArticleContent(document).contentHtml).toBe('<p>body</p>');
  });
});
