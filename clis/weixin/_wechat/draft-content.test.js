import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadDraftContent,
  prepareHtmlContent,
} from './draft-content.js';

describe('weixin draft content preparation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads HTML from a file and preserves the requested format', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bycli-draft-content-'));
    const filePath = join(directory, 'article.html');
    await writeFile(filePath, '<p>Hello</p>');

    expect(loadDraftContent({
      contentFile: filePath,
      contentFormat: 'html',
    })).toEqual({ format: 'html', content: '<p>Hello</p>', filePath });

    await rm(directory, { recursive: true, force: true });
  });

  it('converts an HTML file to readable paragraph text for text-first drafting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bycli-draft-content-'));
    const filePath = join(directory, 'article.html');
    await writeFile(filePath, '<h2>Heading</h2><p>First <strong>paragraph</strong>.</p><p>Second paragraph.</p>');

    expect(loadDraftContent({ contentFile: filePath, contentFormat: 'html-text' })).toEqual({
      format: 'text',
      content: 'Heading\nFirst paragraph.\nSecond paragraph.',
      filePath,
    });

    await rm(directory, { recursive: true, force: true });
  });

  it('sanitizes unsafe HTML while preserving rich-text structure', async () => {
    const result = await prepareHtmlContent(`
      <h2 style="color: #0052d9">Title</h2>
      <p onclick="alert(1)"><strong>Body</strong><script>alert(1)</script></p>
      <a href="https://example.com" style="color: red">Link</a>
    `, { resolveImage: async source => source });

    expect(result.html).toContain('<h2');
    expect(result.html).toContain('<strong>Body</strong>');
    expect(result.html).toContain('href="https://example.com"');
    expect(result.html).not.toContain('<script');
    expect(result.html).not.toContain('onclick');
  });

  it('converts background sections to WeChat-compatible card tables', async () => {
    const result = await prepareHtmlContent(
      '<section style="background-color: #f8f9fa; padding: 15px"><p>Card</p></section>',
      { resolveImage: async source => source },
    );

    expect(result.html).toContain('<table');
    expect(result.html).toContain('background-color: #f8f9fa !important');
    expect(result.html).toContain('<td');
    expect(result.html).not.toContain('<section');
  });

  it('normalizes key inline styles for WeChat compatibility', async () => {
    const result = await prepareHtmlContent(
      '<p style="font-size: 16px; line-height: 1.6; text-align: justify; box-shadow: 0 0 4px #000">Text</p>',
      { resolveImage: async source => source },
    );

    expect(result.html).toContain('font-size: 16px !important');
    expect(result.html).toContain('line-height: 1.6 !important');
    expect(result.html).toContain('text-align: justify !important');
    expect(result.html).not.toContain('box-shadow');
  });

  it('resolves local image sources before inserting HTML', async () => {
    const resolveImage = vi.fn(async source => `https://mmbiz.qpic.cn/${source}`);
    const result = await prepareHtmlContent(
      '<p><img src="./assets/cover.jpg" alt="cover"></p>',
      { baseDir: '/tmp/article', resolveImage },
    );

    expect(resolveImage).toHaveBeenCalledWith('/tmp/article/assets/cover.jpg');
    expect(result.html).toContain('src="https://mmbiz.qpic.cn//tmp/article/assets/cover.jpg"');
  });
});
