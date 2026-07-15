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

  it('preserves literal placeholder-looking text and safely fences embedded backticks', () => {
    const result = wechatArticleToMarkdown({
      title: 'Code',
      html: '<div id="js_content"><p>CODEBLOCK-PLACEHOLDER-0</p><pre data-lang="js"><code>const x = ```;</code></pre></div>',
    });
    expect(result).toContain('CODEBLOCK-PLACEHOLDER-0');
    expect(result).toContain('const x = ```;');
    expect(result).toMatch(/`{4,}js\nconst x = ```;\n`{4,}/);
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
