import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { extractWechatArticleContent } from './article-content.js';

describe('extractWechatArticleContent', () => {
  it('extracts nested content, removes noise, promotes lazy images, and preserves code', () => {
    const document = new JSDOM(`<main><div id="js_content"><section><h2>A &amp; B</h2>
      <script>bad()</script><style>.bad{}</style>
      <img data-src="https://img/a.png"><img src="https://img/b.jpg">
      <div class="code-snippet__fix"><i class="code-snippet__line-index">1</i><pre data-lang="js"><code>const x = 1 &lt; 2;</code></pre></div>
    </section></div></main>`).window.document;
    const value = extractWechatArticleContent(document);
    expect(value.contentHtml).toContain('<section>');
    expect(value.contentHtml).not.toMatch(/script|style|line-index/);
    expect(value.contentHtml).toContain('src="https://img/a.png"');
    expect(value.imageUrls).toEqual(['https://img/a.png', 'https://img/b.jpg']);
    expect(value.codeBlocks).toEqual([]);
    expect(value.contentHtml).toContain('<pre data-lang="js"><code>const x = 1 &lt; 2;</code></pre>');
    expect(value.contentHtml).not.toContain('CODEBLOCK-PLACEHOLDER');
  });

  it('normalizes safe URL attributes and removes active schemes in browser extraction', () => {
    const document = new JSDOM(`<div id="js_content"><a href="javascript:alert(1)">bad</a>
      <a href="//safe.example/a">safe</a><img data-src="data:image/png,x"><video poster="file:///x"></video></div>`).window.document;
    const value = extractWechatArticleContent(document);
    expect(value.contentHtml).toContain('href="https://safe.example/a"');
    expect(value.contentHtml).not.toMatch(/javascript:|data:|file:/);
  });
});
