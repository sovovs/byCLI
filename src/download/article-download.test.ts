import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { convertArticleHtmlToMarkdown, downloadArticle } from './article-download.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors in tests.
    }
  }
  tempDirs.length = 0;
});

async function runAndRead(
  contentHtml: string,
  opts: { cleanSelectors?: string[] } = {},
): Promise<string> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bycli-article-'));
  tempDirs.push(tempDir);
  const result = await downloadArticle({
    title: 'Test Article',
    contentHtml,
  }, {
    output: tempDir,
    downloadImages: false,
    ...(opts.cleanSelectors && { cleanSelectors: opts.cleanSelectors }),
  });
  expect(result[0].status).toBe('success');
  return fs.readFileSync(result[0].saved, 'utf8');
}

describe('downloadArticle', () => {
  it('exports robust Markdown conversion for fenced code and URLs with parentheses', () => {
    const md = convertArticleHtmlToMarkdown('<pre><code>const ticks = ```;</code></pre><img alt="x" src="https://img/a_(1).png">', { safeFencedCodeBlocks: true });
    expect(md).toContain('const ticks = ```;');
    expect(md).toContain(String.raw`https://img/a_\(1\).png`);
    const fence = md.match(/(^|\n)(`{3,})[^\n]*\nconst ticks/m)?.[2] || '';
    expect(fence.length).toBeGreaterThan(3);
  });
  it('does not replace user text that resembles the legacy code placeholder', () => {
    expect(convertArticleHtmlToMarkdown('<p>CODEBLOCK-PLACEHOLDER-0</p><pre><code>ok()</code></pre>', { safeFencedCodeBlocks: true }))
      .toContain('CODEBLOCK-PLACEHOLDER-0');
  });
  it('splits bare-text URLs fused by adjacent inline nodes', () => {
    const md = convertArticleHtmlToMarkdown(
      '<p>均已开源：<span>https://github.com/beyonai/ByDC</span><span>https://github.com/beyonai/ByKC</span></p>',
      { safeFencedCodeBlocks: true },
    );
    expect(md).toBe('均已开源：https://github.com/beyonai/ByDC\nhttps://github.com/beyonai/ByKC');
  });
  it('keeps a URL carrying another URL in its query intact', () => {
    expect(convertArticleHtmlToMarkdown('<p>https://a.com/r?next=https://b.com/x</p>', { safeFencedCodeBlocks: true }))
      .toBe('https://a.com/r?next=https://b.com/x');
    expect(convertArticleHtmlToMarkdown('<p><img src="https://img.io/p.png?u=https://o.com/a.png" alt="x"></p>', { safeFencedCodeBlocks: true }))
      .toBe('![x](https://img.io/p.png?u=https://o.com/a.png)');
  });
  it('leaves markdown link destinations and spaced prose URLs unbroken', () => {
    expect(convertArticleHtmlToMarkdown('<p><a href="https://a.com/1">ByDC</a></p>', { safeFencedCodeBlocks: true }))
      .toBe('[ByDC](https://a.com/1)');
    expect(convertArticleHtmlToMarkdown('<p>见 https://a.com/1 结束</p>', { safeFencedCodeBlocks: true }))
      .toBe('见 https://a.com/1 结束');
  });
  it('returns the saved markdown file path on success', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bycli-article-'));
    tempDirs.push(tempDir);

    const result = await downloadArticle({
      title: 'Test Article',
      author: 'Author',
      publishTime: '2026-04-20 12:00:00',
      sourceUrl: 'https://example.com/article',
      contentHtml: '<p>Hello world</p>',
    }, {
      output: tempDir,
      downloadImages: false,
    });

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('success');
    expect(result[0].saved).toMatch(new RegExp(`^${tempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(path.extname(result[0].saved)).toBe('.md');
    expect(fs.existsSync(result[0].saved)).toBe(true);
    expect(fs.readFileSync(result[0].saved, 'utf8')).toContain('Hello world');
  });

  it('escapes untrusted header fields when secure Markdown is enabled', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bycli-article-'));
    tempDirs.push(tempDir);
    const [result] = await downloadArticle({
      title: '<img onerror=alert(1)>', author: '<script>alert(2)</script>',
      publishTime: '<b>today</b>', sourceUrl: 'https://safe.example/a_(1)',
      contentHtml: '<p>safe</p>',
    }, { output: tempDir, downloadImages: false, secureMarkdown: true });
    const md = fs.readFileSync(result.saved, 'utf8');
    expect(md).not.toMatch(/<(?:img|script|b)\b/i);
    expect(md).toContain(String.raw`# &lt;img onerror=alert\(1\)&gt;`);
    // The URL stays followable: escaping it would defeat the whole point of a
    // source link. Only the surrounding text fields are escaped.
    expect(md).toContain('> 原文链接: <https://safe.example/a_(1)>');
    expect(md).not.toContain(String.raw`https://safe\.example`);
  });

  it('keeps the source URL followable and rejects hostile schemes', async () => {
    const base = {
      title: 'T', contentHtml: '<p>x</p>',
    };
    const opts = { downloadImages: false, secureMarkdown: true };

    const okDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bycli-article-'));
    tempDirs.push(okDir);
    const [ok] = await downloadArticle({
      ...base, sourceUrl: 'https://mp.weixin.qq.com/s/zJAxgVqEUl_AkpCHjFkXGA',
    }, { ...opts, output: okDir });
    const okMd = fs.readFileSync(ok.saved, 'utf8');
    expect(okMd).toContain('> 原文链接: <https://mp.weixin.qq.com/s/zJAxgVqEUl_AkpCHjFkXGA>');
    expect(okMd).not.toMatch(/\\\.|\\_/);

    // Query separators must survive: `&` entity-encoded breaks the link.
    const qDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bycli-article-'));
    tempDirs.push(qDir);
    const [q] = await downloadArticle({
      ...base, sourceUrl: 'https://example.com/a?b=1&c=2#frag',
    }, { ...opts, output: qDir });
    const qMd = fs.readFileSync(q.saved, 'utf8');
    expect(qMd).toContain('> 原文链接: <https://example.com/a?b=1&c=2#frag>');
    expect(qMd).not.toContain('&amp;');

    // A non-http(s) scheme drops the line rather than emitting a live link.
    const badDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bycli-article-'));
    tempDirs.push(badDir);
    const [bad] = await downloadArticle({
      ...base, sourceUrl: 'javascript:alert(1)',
    }, { ...opts, output: badDir });
    const badMd = fs.readFileSync(bad.saved, 'utf8');
    expect(badMd).not.toContain('原文链接');
    expect(badMd).not.toContain('javascript:');

    // A hostile URL cannot close the autolink early and inject markup.
    const hDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bycli-article-'));
    tempDirs.push(hDir);
    const [h] = await downloadArticle({
      ...base, sourceUrl: 'https://example.com/a><script>alert(1)</script>',
    }, { ...opts, output: hDir });
    const hMd = fs.readFileSync(h.saved, 'utf8');
    expect(hMd).not.toMatch(/<script/i);
    expect(hMd).toContain('%3E%3Cscript%3E');
  });

  it('neutralizes hostile iframe titles and destinations in secure Markdown mode', () => {
    const md = convertArticleHtmlToMarkdown(
      '<iframe title="](javascript:alert(1)) <svg onload=alert(2)>" src="javascript:alert(3)"></iframe>',
      { safeFencedCodeBlocks: true },
    );
    expect(md).not.toMatch(/<(?:svg)\b|\]\(\s*javascript:/i);
    expect(md).not.toContain('javascript:alert(3)');
  });

  describe('markdown pipeline', () => {
    it('converts GFM tables', async () => {
      const md = await runAndRead(
        '<table><thead><tr><th>a</th><th>b</th></tr></thead>' +
        '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
      );
      expect(md).toMatch(/\|\s*a\s*\|\s*b\s*\|/);
      expect(md).toMatch(/\|\s*---\s*\|\s*---\s*\|/);
      expect(md).toMatch(/\|\s*1\s*\|\s*2\s*\|/);
    });

    it('converts strikethrough and task lists', async () => {
      const md = await runAndRead(
        '<p><del>gone</del></p>' +
        '<ul><li><input type="checkbox" checked>done</li><li><input type="checkbox">todo</li></ul>',
      );
      expect(md).toContain('~~gone~~');
      expect(md).toContain('[x] done');
      expect(md).toContain('[ ] todo');
    });

    it('strips script / style / noscript / form but keeps iframe as a link', async () => {
      const md = await runAndRead(
        '<p>keep</p>' +
        '<script>alert(1)</script>' +
        '<style>.x{color:red}</style>' +
        '<noscript>nojs</noscript>' +
        '<iframe src="https://www.youtube.com/embed/abc" title="Demo video"></iframe>' +
        '<form><button>click</button></form>',
      );
      expect(md).toContain('keep');
      expect(md).not.toContain('alert');
      expect(md).not.toContain('color:red');
      expect(md).not.toContain('nojs');
      expect(md).not.toContain('click');
      // Iframe degrades to a link preserving the embedded URL.
      expect(md).toContain('[Demo video](https://www.youtube.com/embed/abc)');
    });

    it('strips SVG nodes entirely', async () => {
      const md = await runAndRead(
        '<p>before</p><svg><circle cx="5" cy="5" r="4"/></svg><p>after</p>',
      );
      expect(md).toContain('before');
      expect(md).toContain('after');
      expect(md).not.toContain('svg');
      expect(md).not.toContain('circle');
    });

    it('drops base64 data URI images but keeps regular images', async () => {
      const md = await runAndRead(
        '<p><img alt="inline" src="data:image/png;base64,iVBORw0KGgo="></p>' +
        '<p><img alt="keep" src="https://example.com/a.jpg"></p>',
      );
      expect(md).not.toContain('data:image');
      expect(md).toContain('![keep](https://example.com/a.jpg)');
    });

    it('collapses 3+ blank lines and strips lone bullet / middle-dot residue', async () => {
      const md = await runAndRead(
        '<p>top</p>' +
        '<p>-</p>' +
        '<p>·</p>' +
        '<p>bottom</p>',
      );
      expect(md).not.toMatch(/\n{3,}/);
      expect(md).not.toMatch(/^\s*-\s*$/m);
      expect(md).not.toMatch(/^\s*·\s*$/m);
      expect(md).toContain('top');
      expect(md).toContain('bottom');
    });

    it('strips page chrome (header / footer / nav / aside)', async () => {
      const md = await runAndRead(
        '<header><p>page-header-text</p></header>' +
        '<nav><a href="/">home-link</a></nav>' +
        '<p>article-body</p>' +
        '<aside><p>sidebar-text</p></aside>' +
        '<footer><p>page-footer-text</p></footer>',
      );
      expect(md).toContain('article-body');
      expect(md).not.toContain('page-header-text');
      expect(md).not.toContain('home-link');
      expect(md).not.toContain('sidebar-text');
      expect(md).not.toContain('page-footer-text');
    });

    it('cleanSelectors removes matching nodes before conversion', async () => {
      const md = await runAndRead(
        '<p>keep-me</p>' +
        '<div class="vote-card">折叠卡</div>' +
        '<section class="reward-panel">赞赏栏</section>' +
        '<p>also-keep</p>',
        { cleanSelectors: ['.vote-card', '.reward-panel'] },
      );
      expect(md).toContain('keep-me');
      expect(md).toContain('also-keep');
      expect(md).not.toContain('折叠卡');
      expect(md).not.toContain('赞赏栏');
    });

    it('cleanSelectors silently ignores invalid selectors', async () => {
      const md = await runAndRead(
        '<p>survives</p><div class="x">and-this-too</div>',
        { cleanSelectors: ['!!!not-a-valid-selector', '.missing'] },
      );
      expect(md).toContain('survives');
      expect(md).toContain('and-this-too');
    });

    it('cleanSelectors keeps valid selectors active when one selector is invalid', async () => {
      const md = await runAndRead(
        '<p>keep</p><div class="vote-card">strip-me</div><p>also-keep</p>',
        { cleanSelectors: ['!!!not-a-valid-selector', '.vote-card'] },
      );
      expect(md).toContain('keep');
      expect(md).toContain('also-keep');
      expect(md).not.toContain('strip-me');
    });

    it('preserves <video> as inline HTML with src + poster', async () => {
      const md = await runAndRead(
        '<p>before</p>' +
        '<video src="https://cdn.example.com/clip.mp4" poster="https://cdn.example.com/poster.jpg"></video>' +
        '<p>after</p>',
      );
      expect(md).toContain('<video src="https://cdn.example.com/clip.mp4" controls poster="https://cdn.example.com/poster.jpg"></video>');
      expect(md).toContain('before');
      expect(md).toContain('after');
    });

    it('falls back to <source> inside <video> when src attribute is absent', async () => {
      const md = await runAndRead(
        '<video><source src="https://cdn.example.com/clip.mp4" type="video/mp4"></video>',
      );
      expect(md).toContain('<video src="https://cdn.example.com/clip.mp4" controls></video>');
    });

    it('drops <video> with no src and no <source>', async () => {
      const md = await runAndRead('<p>before</p><video></video><p>after</p>');
      expect(md).not.toContain('<video');
      expect(md).toContain('before');
      expect(md).toContain('after');
    });

    it('preserves <audio> as inline HTML', async () => {
      const md = await runAndRead(
        '<audio src="https://cdn.example.com/podcast.mp3"></audio>',
      );
      expect(md).toContain('<audio src="https://cdn.example.com/podcast.mp3" controls></audio>');
    });

    it('degrades <iframe> to a markdown link with title', async () => {
      const md = await runAndRead(
        '<iframe src="https://codepen.io/pen/abc" title="Live demo"></iframe>',
      );
      expect(md).toContain('[Live demo](https://codepen.io/pen/abc)');
    });

    it('defaults iframe title to "Embedded content" when missing', async () => {
      const md = await runAndRead(
        '<iframe src="https://example.com/embed"></iframe>',
      );
      expect(md).toContain('[Embedded content](https://example.com/embed)');
    });

    it('drops <iframe> with no src', async () => {
      const md = await runAndRead('<p>before</p><iframe></iframe><p>after</p>');
      expect(md).not.toContain('iframe');
      expect(md).toContain('before');
      expect(md).toContain('after');
    });
  });

  describe('stdout mode', () => {
    it('writes markdown to process.stdout and skips file write', async () => {
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bycli-article-'));
      tempDirs.push(tempDir);

      const chunks: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      }) as typeof process.stdout.write;

      try {
        const result = await downloadArticle({
          title: 'Piped',
          contentHtml: '<p>Streaming body</p>',
          sourceUrl: 'https://example.com/a',
        }, {
          output: tempDir,
          stdout: true,
        });

        expect(result[0].status).toBe('success');
        expect(result[0].saved).toBe('-');
        expect(fs.readdirSync(tempDir)).toHaveLength(0);

        const emitted = chunks.join('');
        expect(emitted).toContain('# Piped');
        expect(emitted).toContain('Streaming body');
        expect(emitted.endsWith('\n')).toBe(true);
      } finally {
        process.stdout.write = originalWrite;
      }
    });

    it('keeps remote image URLs intact in stdout mode (no download)', async () => {
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bycli-article-'));
      tempDirs.push(tempDir);

      const chunks: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      }) as typeof process.stdout.write;

      try {
        await downloadArticle({
          title: 'WithImage',
          contentHtml: '<p><img src="https://example.com/a.jpg"></p>',
          imageUrls: ['https://example.com/a.jpg'],
        }, {
          output: tempDir,
          downloadImages: true,
          stdout: true,
        });

        expect(fs.readdirSync(tempDir)).toHaveLength(0);
        expect(chunks.join('')).toContain('https://example.com/a.jpg');
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });
});
