import { describe, expect, it } from 'vitest';
import { CommandExecutionError } from '../errors.js';
import { extractWechatArticleHtml, MAX_WECHAT_CODE_BLOCKS, MAX_WECHAT_HTML_BYTES, MAX_WECHAT_NODES } from './wechat-article.js';

describe('extractWechatArticleHtml', () => {
  it('uses HTML parsing for quoted >, arbitrary image attributes, entities, and nested noise', () => {
    const result = extractWechatArticleHtml(`<main><div data-x=">" id="js_content"><h2>A &amp; &#x42; &#x110000;</h2>
      <img alt="a" data-src="https://img/a_(1).png" src="placeholder">
      <div class="reward_area"><div>secret noise</div></div><script>bad()</script>
      <pre><code>const ticks = \`\`\`;</code></pre></div></main>`);
    expect(result.contentHtml).toContain('A &amp; B �');
    expect(result.contentHtml).toContain('src="https://img/a_(1).png"');
    expect(result.contentHtml).not.toMatch(/placeholder|secret noise|bad\(\)/);
    expect(result.imageUrls).toEqual(['https://img/a_(1).png']);
  });

  it('rejects deterministic byte and DOM-node caps', () => {
    expect(() => extractWechatArticleHtml(`<div id="js_content">${'x'.repeat(MAX_WECHAT_HTML_BYTES)}</div>`))
      .toThrow(CommandExecutionError);
    expect(() => extractWechatArticleHtml(`<div id="js_content">${'<i>x</i>'.repeat(MAX_WECHAT_NODES)}</div>`))
      .toThrow(CommandExecutionError);
    expect(() => extractWechatArticleHtml(`<div id="js_content">${'<pre>x</pre>'.repeat(MAX_WECHAT_CODE_BLOCKS + 1)}</div>`))
      .toThrow(/code block limit/);
  });

  it('normalizes safe URL attributes and removes active schemes', () => {
    const result = extractWechatArticleHtml(`<div id="js_content">
      <a href="//safe.example/a">safe</a><a href="javascript:alert(1)">bad</a>
      <img src="data:image/png,x"><img src="https://safe.example/a.png">
      <video poster="file:///tmp/x"></video></div>`);
    expect(result.contentHtml).toContain('href="https://safe.example/a"');
    expect(result.contentHtml).toContain('src="https://safe.example/a.png"');
    expect(result.contentHtml).not.toMatch(/javascript:|data:|file:/);
  });
});
