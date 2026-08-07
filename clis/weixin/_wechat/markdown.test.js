import { describe, expect, it } from 'vitest';
import { cleanMarkdownFilename, wechatArticleToMarkdown } from './markdown.js';

describe('wechatArticleToMarkdown', () => {
  it('converts only nested #js_content with headings, entities, images, and fenced code', () => {
    const html = `<h1>outside</h1><div id="js_content"><section><h2>A &amp; B</h2><p>Hello&nbsp;world</p>
      <img data-src="https://img/a.png" alt="A"><script>bad()</script>
      <div class="code-snippet__fix"><pre data-lang="js"><code>if (a &lt; b) {</code><code>  ok()</code></pre></div>
    </section></div>`;
    const result = wechatArticleToMarkdown({ html, title: 'Title', accountName: 'Account', url: 'https://mp.weixin.qq.com/s/a' });
    expect(result).toContain('# Title');
    expect(result).toContain('## A & B');
    expect(result).toContain('Hello world');
    expect(result).toContain('![A](https://img/a.png)');
    expect(result).toContain('```js\nif (a < b) {\n  ok()\n```');
    expect(result).not.toMatch(/outside|bad\(\)/);
  });

  it('prefers data-src over an image placeholder src', () => {
    const result = wechatArticleToMarkdown({
      html: '<div id="js_content"><img src="placeholder.gif" data-src="https://img/real.png" alt="real"></div>',
      title: 'Image',
    });
    expect(result).toContain('![real](https://img/real.png)');
    expect(result).not.toContain('placeholder.gif');
  });

  it('removes WeChat noise and preserves nested code snippet lines', () => {
    const result = wechatArticleToMarkdown({ title: 'Code', html: `<div id="js_content">
      <div class="qr_code_pc">qr noise</div><div class="reward_area"><div>reward noise</div></div>
      <div class="code-snippet__fix"><div class="code-snippet__line-index">1</div><pre data-lang="js">
        <code>a()</code><div><code>b()</code></div><code>c()</code></pre></div></div>` });
    expect(result).toContain('```js\na()\nb()\nc()\n```');
    expect(result).not.toMatch(/qr noise|reward noise/);
  });

  it('single-lines and escapes untrusted title and metadata', () => {
    const result = wechatArticleToMarkdown({
      title: '# title\n> injected', accountName: 'acct\n# injected', author: '[author](bad)',
      publishedAt: '> date', url: 'https://example.com/a_(1)', digest: 'digest\n> injected',
      html: '<div id="js_content"><p>body</p></div>',
    });
    expect(result).toContain('# \\# title &gt; injected');
    expect(result).toContain('> 公众号: acct \\# injected');
    expect(result).toContain('> 作者: \\[author\\]\\(bad\\)');
    expect(result).not.toContain('\n> injected');
  });

  it('keeps the source URL followable instead of markdown-escaping it', () => {
    const result = wechatArticleToMarkdown({
      title: 'Link', url: 'https://mp.weixin.qq.com/s/zJAxgVqEUl_AkpCHjFkXGA',
      html: '<div id="js_content"><p>body</p></div>',
    });
    expect(result).toContain('> 原文链接: <https://mp.weixin.qq.com/s/zJAxgVqEUl_AkpCHjFkXGA>');
    expect(result).not.toContain('\\.');
    expect(result).not.toContain('\\_');
  });

  it('preserves query separators and drops whitespace in the source URL', () => {
    const result = wechatArticleToMarkdown({
      title: 'Query', url: '  https://example.com/a?b=1&c=2#frag\n',
      html: '<div id="js_content"><p>body</p></div>',
    });
    expect(result).toContain('> 原文链接: <https://example.com/a?b=1&c=2#frag>');
    expect(result).not.toContain('&amp;');
  });

  it('omits the source URL line for non-http(s) schemes', () => {
    const hostile = wechatArticleToMarkdown({
      title: 'Bad', url: 'javascript:alert(1)', html: '<div id="js_content"><p>body</p></div>',
    });
    expect(hostile).not.toContain('原文链接');
    expect(hostile).not.toContain('javascript:');
    const empty = wechatArticleToMarkdown({ title: 'None', html: '<div id="js_content"><p>body</p></div>' });
    expect(empty).not.toContain('原文链接');
  });

  it('prevents a hostile URL from closing the autolink early', () => {
    const result = wechatArticleToMarkdown({
      title: 'Escape', url: 'https://example.com/a><script>alert(1)</script>',
      html: '<div id="js_content"><p>body</p></div>',
    });
    expect(result).toContain('> 原文链接: <https://example.com/a%3E%3Cscript%3Ealert(1)%3C/script%3E>');
    expect(result).not.toMatch(/<script\b/i);
  });

  it('preserves literal placeholder-looking text and safely fences embedded backticks', () => {
    const result = wechatArticleToMarkdown({
      title: 'Code',
      html: '<div id="js_content"><p>CODEBLOCK-PLACEHOLDER-0</p><pre data-lang="js"><code>const x = ```;</code></pre></div>',
    });
    expect(result).toContain('CODEBLOCK-PLACEHOLDER-0');
    expect(result).toContain('const x = ```;');
    expect(result).toMatch(/`{4,}js\nconst x = ```;\n`{4,}/);
  });

  it('neutralizes metadata and hostile link/image contexts without breaking safe URLs', () => {
    const result = wechatArticleToMarkdown({
      title: '<img onerror=alert(1)>', accountName: '<script>alert(2)</script>',
      author: 'A & "B"', publishedAt: '<b>today</b>', digest: '<svg onload=alert(3)>',
      html: `<div id="js_content">
        <img src="javascript:alert(4)" alt="](javascript:alert(5)) <svg onload=alert(6)>">
        <img src="https://safe.example/a_(1).png" alt="safe ] label">
        <a href="javascript:alert(7)">bad</a><a href="https://safe.example/a_(1)">safe ] link</a>
      </div>`,
    });
    expect(result).not.toMatch(/<(?:img|script|svg|b)\b/i);
    expect(result).not.toMatch(/\]\(\s*javascript:/i);
    expect(result).toContain(String.raw`&lt;img onerror=alert\(1\)&gt;`);
    expect(result).toContain(String.raw`https://safe.example/a_\(1\).png`);
    expect(result).toContain(String.raw`https://safe.example/a_\(1\)`);
  });
});

describe('cleanMarkdownFilename', () => {
  it('removes cross-platform invalid/control/path characters, trailing dots/spaces, and bounds length', () => {
    expect(cleanMarkdownFilename('  a/b\\c:*?"<>|\u0001.  ')).toBe('a_b_c________');
    expect(cleanMarkdownFilename(`${'文'.repeat(120)}.`, 80)).toHaveLength(80);
    expect(cleanMarkdownFilename('...')).toBe('untitled');
    expect(cleanMarkdownFilename('CON')).toBe('_CON');
    expect(Buffer.byteLength(`${cleanMarkdownFilename('文'.repeat(120))}.md`)).toBeLessThanOrEqual(255);
    const suffixed = `${cleanMarkdownFilename('文'.repeat(120), 100, '-100')}-100.md`;
    expect(Buffer.byteLength(suffixed)).toBeLessThanOrEqual(255);
  });
});
