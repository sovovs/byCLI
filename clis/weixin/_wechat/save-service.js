import * as defaultFs from 'node:fs';
import path from 'node:path';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
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

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertResolvedPathComponents(root, fsImpl) {
  const parsed = path.parse(root);
  let current = parsed.root;
  for (const part of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fsImpl.lstatSync(current);
    if (stat.isSymbolicLink?.()) throw new CommandExecutionError('Refusing to save through a symbolic link');
  }
}

function assertRootIdentity(root, rootFd, rootIdentity, fsImpl) {
  assertResolvedPathComponents(root, fsImpl);
  const pathStat = fsImpl.lstatSync(root);
  const fdStat = fsImpl.fstatSync(rootFd);
  if (!pathStat.isDirectory?.() || !fdStat.isDirectory?.()
      || !sameIdentity(pathStat, rootIdentity) || !sameIdentity(fdStat, rootIdentity)) {
    throw new CommandExecutionError('Output directory identity changed during save');
  }
}

function cleanupOpenedTarget(target, openedStat, fsImpl) {
  try {
    const current = fsImpl.lstatSync(target);
    if (sameIdentity(current, openedStat) && !current.isSymbolicLink?.()) fsImpl.unlinkSync(target);
  } catch {
    // Fail closed; cleanup is best effort after identity mismatch.
  }
}

function writeExclusive(root, rootFd, rootIdentity, target, markdown, fsImpl) {
  const noFollow = defaultFs.constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') {
    throw new CommandExecutionError('Secure article saving is unavailable: O_NOFOLLOW is unsupported');
  }
  assertRootIdentity(root, rootFd, rootIdentity, fsImpl);
  let fd;
  let openedStat;
  try {
    fd = fsImpl.openSync(target,
      defaultFs.constants.O_CREAT | defaultFs.constants.O_EXCL | defaultFs.constants.O_WRONLY | noFollow,
      0o600);
    openedStat = fsImpl.fstatSync(fd);
    if (!openedStat.isFile?.() || openedStat.isSymbolicLink?.()) {
      throw new CommandExecutionError('Refusing to write a non-regular article target');
    }
    assertRootIdentity(root, rootFd, rootIdentity, fsImpl);
    const body = Buffer.from(markdown, 'utf8');
    let offset = 0;
    while (offset < body.length) {
      const written = fsImpl.writeSync(fd, body, offset, body.length - offset);
      if (!Number.isInteger(written) || written <= 0) throw new CommandExecutionError('Failed to write article bytes');
      offset += written;
    }
    fsImpl.fsyncSync?.(fd);
    assertRootIdentity(root, rootFd, rootIdentity, fsImpl);
  } catch (error) {
    if (openedStat) cleanupOpenedTarget(target, openedStat, fsImpl);
    throw error;
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
  }
}

export async function saveArticles({ articles, accountName, outputDir, fetchArticleHtml, fsImpl = defaultFs }) {
  if (!Array.isArray(articles) || articles.length > 1000) {
    throw new ArgumentError('articles must be an array of at most 1000 items');
  }
  const requestedRoot = path.resolve(outputDir);
  try { fsImpl.mkdirSync(requestedRoot, { recursive: true }); } catch (error) { throw commandError('create output directory', error); }
  let root;
  try { root = fsImpl.realpathSync(requestedRoot); } catch (error) { throw commandError('resolve output directory', error); }
  let rootFd;
  let rootIdentity;
  try {
    assertResolvedPathComponents(root, fsImpl);
    rootIdentity = fsImpl.lstatSync(root);
    if (!rootIdentity.isDirectory?.() || rootIdentity.isSymbolicLink?.()) throw new Error('not a directory');
    rootFd = fsImpl.openSync(root, defaultFs.constants.O_RDONLY);
    const openedRoot = fsImpl.fstatSync(rootFd);
    if (!openedRoot.isDirectory?.() || !sameIdentity(openedRoot, rootIdentity)) {
      throw new CommandExecutionError('Output directory identity changed during secure open');
    }
    assertRootIdentity(root, rootFd, rootIdentity, fsImpl);
  } catch (error) {
    if (rootFd !== undefined) fsImpl.closeSync(rootFd);
    if (error instanceof CommandExecutionError) throw error;
    throw commandError('secure output directory', error);
  }
  const reserved = new Set();
  const rows = [];

  try {
    for (const article of articles) {
      let markdown;
      try {
        const articleHtml = await fetchArticleHtml(article);
        markdown = wechatArticleToMarkdown({ html: articleHtml, title: article.title, accountName,
          author: article.author, publishedAt: article.publishedAt, digest: article.digest, url: article.url });
      } catch (error) {
        const reason = error instanceof CommandExecutionError ? 'invalid article content' : 'fetch failed';
        rows.push({ title: article.title || '', url: article.url || '', status: 'failed', saved: '', error: reason });
        continue;
      }

      let suffix = 1;
      let target;
      while (suffix <= MAX_FILENAME_ATTEMPTS) {
        const suffixText = suffix === 1 ? '' : `-${suffix}`;
        const name = `${cleanMarkdownFilename(article.title, 100, suffixText)}${suffixText}`;
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
          writeExclusive(root, rootFd, rootIdentity, target, markdown, fsImpl);
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
      rows.push({ title: article.title || '', url: article.url || '', status: 'saved', saved: target, error: '' });
    }
  } finally {
    fsImpl.closeSync(rootFd);
  }
  return rows;
}
