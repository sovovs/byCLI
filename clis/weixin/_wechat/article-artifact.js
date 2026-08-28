import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { CommandExecutionError } from '@sovovs/bycli/errors';

function isContained(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'));
}

async function validateRegularNonEmptyFile(path, label) {
  await access(path, constants.R_OK);
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new Error(`${label} is empty or not a regular file`);
  return realpath(path);
}

function localMarkdownImageTargets(markdown) {
  const targets = [];
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split(/\s+["']/u, 1)[0];
    if (!target || /^(?:https?:|data:|#|\/\/)/iu.test(target)) continue;
    targets.push(decodeURI(target));
  }
  return targets;
}

export async function validateDownloadedArticleRows(rows, outputDir) {
  try {
    const successfulRows = rows.filter(row => row && String(row.status).toLowerCase() === 'success');
    if (successfulRows.length === 0) return rows;
    const resolvedOutput = await realpath(resolve(outputDir));
    for (const row of successfulRows) {
      if (typeof row.saved !== 'string' || extname(row.saved).toLowerCase() !== '.md') {
        throw new Error('successful article row returned no Markdown path');
      }
      const saved = await validateRegularNonEmptyFile(resolve(row.saved), 'saved Markdown');
      if (!isContained(resolvedOutput, saved)) throw new Error('saved Markdown escaped the output directory');
      const articleDir = dirname(saved);
      const markdown = await readFile(saved, 'utf8');
      for (const target of localMarkdownImageTargets(markdown)) {
        const image = await validateRegularNonEmptyFile(resolve(articleDir, target), 'local Markdown image');
        if (!isContained(articleDir, image)) throw new Error('local Markdown image escaped the article directory');
      }
    }
    return rows;
  } catch (error) {
    if (error instanceof CommandExecutionError) throw error;
    throw new CommandExecutionError(
      `Downloaded Weixin article artifact validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
