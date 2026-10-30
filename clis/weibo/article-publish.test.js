import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { __test__, runWeiboArticlePublish } from './article-publish.js';

const { analyzeHtml, prepareBody, readContent, textToHtml, validateTitle } = __test__;

describe('weibo article-publish', () => {
  let dir;
  let htmlFile;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-weibo-article-'));
    fs.mkdirSync(path.join(dir, 'images'));
    fs.writeFileSync(path.join(dir, 'images', '01.png'), 'png');
    fs.writeFileSync(path.join(dir, 'images', '02.jpg'), 'jpg');
    htmlFile = path.join(dir, 'article.html');
    fs.writeFileSync(htmlFile, '<h2>门派</h2><p>正文</p><img src="images/01.png"><figure class="image"><img src="images/02.jpg"></figure><img src="https://wx1.sinaimg.cn/large/a.jpg">');
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is dry-run by default and never needs a browser', async () => {
    const rows = await runWeiboArticlePublish(null, { title: '测试文章', content: '正文' });
    expect(rows[0]).toMatchObject({ status: 'dry-run', title: '测试文章', content_format: 'text', images: '0 local, 0 remote' });
    expect(prepareBody(readContent({ content: '正文' })).uploads).toEqual([]);
  });

  it('enforces the 32 character editor title limit', () => {
    expect(validateTitle('字'.repeat(32))).toHaveLength(32);
    expect(() => validateTitle('字'.repeat(33))).toThrow(/32/);
  });

  it('refuses Markdown files instead of converting them', () => {
    const md = path.join(dir, 'article.md');
    fs.writeFileSync(md, '# 标题');
    expect(() => readContent({ 'content-file': md })).toThrow(/Render it to HTML offline/);
  });

  it('detects html format from the file extension and resolves images next to the file', async () => {
    const rows = await runWeiboArticlePublish(null, { title: '测试文章', 'content-file': htmlFile });
    expect(rows[0]).toMatchObject({ status: 'dry-run', content_format: 'html', images: '2 local, 1 remote' });
  });

  it('replaces local images with upload placeholders and keeps sinaimg images', () => {
    const body = prepareBody(readContent({ 'content-file': htmlFile }));
    expect(body.uploads.map((upload) => [upload.kind, upload.file])).toEqual([
      ['local', path.join(dir, 'images', '01.png')],
      ['local', path.join(dir, 'images', '02.jpg')],
    ]);
    expect(body.html).toContain('<p>BYCLI_WEIBO_IMAGE_0</p><p>BYCLI_WEIBO_IMAGE_1</p>');
    expect(body.html).toContain('<img src="https://wx1.sinaimg.cn/large/a.jpg">');
    expect(body.html).not.toContain('<figure');
  });

  it('accepts inline data: images and swaps them for upload placeholders', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const report = analyzeHtml(`<img src="${png}">`, dir);
    expect(report.errors).toEqual([]);
    expect(report.images).toHaveLength(1);
    expect(report.images[0]).toMatchObject({ kind: 'data', ext: 'png' });
    const body = prepareBody({ text: `<p>正文</p><img src="${png}">`, baseDir: dir, format: 'html', source: 'inline' });
    expect(body.uploads).toHaveLength(1);
    expect(body.uploads[0]).toMatchObject({ kind: 'data', ext: 'png' });
    expect(body.html).toContain('<p>BYCLI_WEIBO_IMAGE_0</p>');
    expect(analyzeHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=">', dir).errors.join('\n')).toMatch(/Unsupported data: image type/);
  });

  it('reports HTML the editor would drop without rewriting it', () => {
    const report = analyzeHtml('<p>文字<img src="images/01.png"></p><img src="missing.png"><img src="https://example.com/a.png"><p>## 残留</p><a href="#ref">锚点</a>', dir);
    expect(report.errors.join('\n')).toMatch(/inside <p>/);
    expect(report.errors.join('\n')).toMatch(/Image file not found: missing\.png/);
    expect(report.errors.join('\n')).toMatch(/not hosted on sinaimg\.cn/);
    expect(report.errors.join('\n')).toMatch(/Markdown markers/);
    expect(report.warnings.join('\n')).toMatch(/^1 non-http link/);
    expect(analyzeHtml('<a href="https://a.com">a</a><a href=\'http://b.com\'>b</a><a href=https://c.com>c</a>', dir).warnings).toEqual([]);
    expect(() => prepareBody({ text: '<p><img src="images/01.png"></p>', baseDir: dir, format: 'html', source: 'inline' })).toThrow(/not ready for the Weibo editor/);
  });

  it('turns plain text into escaped paragraphs', () => {
    expect(textToHtml('第一段\n续行\n\n<第二段>')).toBe('<p>第一段<br>续行</p><p>&lt;第二段&gt;</p>');
  });
});
