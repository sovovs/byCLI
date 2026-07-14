import * as defaultFs from 'node:fs';
import path from 'node:path';
import { CommandExecutionError } from '@sovovs/bycli/errors';
import { cleanMarkdownFilename, wechatArticleToMarkdown } from './markdown.js';

export const MAX_FILENAME_ATTEMPTS = 100;

function commandError(action, error) {
  return new CommandExecutionError(`Failed to ${action}: ${error instanceof Error ? error.message : String(error)}`);
}

function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new CommandExecutionError('Refusing to save an article outside the output directory');
  }
}

export async function saveArticles({ articles, accountName, outputDir, fetchArticleHtml, fsImpl = defaultFs }) {
  const requestedRoot = path.resolve(outputDir);
  try { fsImpl.mkdirSync(requestedRoot, { recursive: true }); } catch (error) { throw commandError('create output directory', error); }
  let root;
  try { root = fsImpl.realpathSync(requestedRoot); } catch (error) { throw commandError('resolve output directory', error); }
  const reserved = new Set();
  const rows = [];

  for (const article of articles) {
    let markdown;
    try {
      const articleHtml = await fetchArticleHtml(article);
      markdown = wechatArticleToMarkdown({ html: articleHtml, title: article.title, accountName,
        author: article.author, publishedAt: article.publishedAt, url: article.url });
    } catch (error) {
      rows.push({ title: article.title || '', url: article.url || '', status: 'failed', saved: '' });
      continue;
    }

    const base = cleanMarkdownFilename(article.title);
    let suffix = 1;
    let target;
    while (suffix <= MAX_FILENAME_ATTEMPTS) {
      const name = suffix === 1 ? base : `${base}-${suffix}`;
      target = path.resolve(root, `${name}.md`);
      assertInside(root, target);
      if (reserved.has(target)) { suffix += 1; continue; }
      try {
        const stat = fsImpl.lstatSync(target);
        if (stat.isSymbolicLink?.()) throw new CommandExecutionError('Refusing to overwrite a symbolic link');
        suffix += 1;
        continue;
      } catch (error) {
        if (error instanceof CommandExecutionError) throw error;
        if (error?.code !== 'ENOENT') throw commandError('inspect article target', error);
      }
      try {
        fsImpl.writeFileSync(target, markdown, { encoding: 'utf8', flag: 'wx' });
        reserved.add(target);
        break;
      } catch (error) {
        if (error?.code === 'EEXIST') {
          suffix += 1;
          continue;
        }
        throw commandError('write article Markdown', error);
      }
    }
    if (suffix > MAX_FILENAME_ATTEMPTS) {
      throw new CommandExecutionError(`Failed to reserve an article filename after ${MAX_FILENAME_ATTEMPTS} attempts`);
    }
    rows.push({ title: article.title || '', url: article.url || '', status: 'saved', saved: target });
  }
  return rows;
}
