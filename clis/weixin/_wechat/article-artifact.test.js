import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateDownloadedArticleRows } from './article-artifact.js';

const roots = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('validateDownloadedArticleRows', () => {
  it('preserves terminal failed rows without requiring an output directory', async () => {
    const missing = join(tmpdir(), `bycli-missing-${Date.now()}`);
    const rows = [{ status: 'failed — no title', saved: '-' }];
    await expect(validateDownloadedArticleRows(rows, missing)).resolves.toBe(rows);
  });

  it('accepts non-empty Markdown and local images contained by the article directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bycli-article-artifact-'));
    roots.push(root);
    const articleDir = join(root, 'article');
    await mkdir(join(articleDir, 'images'), { recursive: true });
    const markdown = join(articleDir, 'article.md');
    await writeFile(join(articleDir, 'images', 'cover.png'), Buffer.from([1, 2, 3]));
    await writeFile(markdown, '# Article\n\n![cover](images/cover.png)\n![remote](//mmbiz.qpic.cn/remote.png)\n');

    await expect(validateDownloadedArticleRows([{ status: 'success', saved: markdown }], root))
      .resolves.toEqual([{ status: 'success', saved: markdown }]);
  });

  it('rejects saved Markdown outside output and missing or escaping local images', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bycli-article-artifact-'));
    const outside = await mkdtemp(join(tmpdir(), 'bycli-article-outside-'));
    roots.push(root, outside);
    const outsideMarkdown = join(outside, 'outside.md');
    await writeFile(outsideMarkdown, '# outside');
    await expect(validateDownloadedArticleRows([{ status: 'success', saved: outsideMarkdown }], root))
      .rejects.toMatchObject({ code: 'COMMAND_EXEC' });

    const articleDir = join(root, 'article');
    await mkdir(articleDir, { recursive: true });
    const markdown = join(articleDir, 'article.md');
    await writeFile(markdown, '![missing](images/missing.png)');
    await expect(validateDownloadedArticleRows([{ status: 'success', saved: markdown }], root))
      .rejects.toMatchObject({ code: 'COMMAND_EXEC' });

    await symlink(outsideMarkdown, join(articleDir, 'escape.md'));
    await writeFile(markdown, '![escape](escape.md)');
    await expect(validateDownloadedArticleRows([{ status: 'success', saved: markdown }], root))
      .rejects.toMatchObject({ code: 'COMMAND_EXEC' });
  });
});
