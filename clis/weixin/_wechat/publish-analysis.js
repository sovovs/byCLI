import { link, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CommandExecutionError } from '@sovovs/bycli/errors';

const DOMAIN = 'mp.weixin.qq.com';

function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function heading(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function table(headers, rows) {
  return [`| ${headers.map(cell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)];
}

function appendSection(lines, name, value, level = 2) {
  if (value === null || value === undefined) return;
  lines.push(`${'#'.repeat(level)} ${heading(name)}`, '');
  if (Array.isArray(value)) {
    if (value.length === 0) { lines.push('_No data_', ''); return; }
    if (value.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
      const headers = [...new Set(value.flatMap(item => Object.keys(item)))];
      lines.push(...table(headers, value.map(item => headers.map(key => item[key]))), '');
      return;
    }
    lines.push(...table(['Value'], value.map(item => [item])), '');
    return;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    const scalars = entries.filter(([, item]) => item === null || typeof item !== 'object');
    if (scalars.length) lines.push(...table(['Metric', 'Value'], scalars), '');
    for (const [key, item] of entries.filter(([, item]) => item && typeof item === 'object')) appendSection(lines, key, item, level + 1);
    return;
  }
  lines.push(...table(['Metric', 'Value'], [[name, value]]), '');
}

export function formatAnalysisMarkdown({ title, publishedAt, data }) {
  const lines = [`# ${heading(title)}`, '', `Published: ${cell(publishedAt)}`, ''];
  for (const [name, value] of Object.entries(data ?? {})) appendSection(lines, name, value);
  return `${lines.join('\n').trimEnd()}\n`;
}

export function extractAnalysisPayloads(entries) {
  const result = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    try {
      const url = new URL(String(entry?.url ?? ''));
      if (url.protocol !== 'https:' || url.hostname !== DOMAIN || url.port !== ''
        || !['/misc/appmsganalysis', '/misc/videoanalysis'].includes(url.pathname)
        || Number(entry.responseStatus) !== 200) continue;
      const text = entry.responsePreview;
      if (typeof text !== 'string') continue;
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object') continue;
      result.push({ name: url.pathname.split('/').at(-1), data });
    } catch { /* unrelated or malformed response */ }
  }
  return result;
}

function safeFilename(title) {
  const name = basename(String(title)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'weixin-publish-analysis';
  return `${name}.md`;
}

async function publishMarkdown(outputDir, filename, content) {
  await mkdir(outputDir, { recursive: true });
  const temporary = resolve(outputDir, `.bycli-publish-analysis-${randomUUID()}.tmp`);
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  try {
    const extension = '.md';
    const stem = filename.slice(0, -extension.length);
    for (let index = 0; index <= 9999; index += 1) {
      const path = resolve(outputDir, index === 0 ? filename : `${stem}-${index}${extension}`);
      try { await link(temporary, path); return path; } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    throw new CommandExecutionError('WeChat publish analysis could not allocate a report filename');
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function collectPublishAnalysis(page, { detailUrl, title, publishedAt, outputDir }) {
  if (typeof page?.goto !== 'function' || typeof page?.readNetworkCapture !== 'function') {
    throw new CommandExecutionError('WeChat publish analysis requires browser network capture support');
  }
  await page.startNetworkCapture?.('mp.weixin.qq.com');
  await page.goto(detailUrl);
  await page.wait?.(1000);
  const payloads = extractAnalysisPayloads(await page.readNetworkCapture());
  let data = Object.fromEntries(payloads.map(({ name, data: value }, index) => [index === 0 ? name : `${name}-${index + 1}`, value]));
  if (payloads.length === 0 && typeof page.evaluate === 'function') {
    const visible = await page.evaluate(`(() => {
      const text = element => String(element?.innerText ?? element?.textContent ?? '').trim();
      const tables = [...document.querySelectorAll('table')].map((table, index) => {
        const rows = [...table.querySelectorAll('tr')].map(row => [...row.querySelectorAll('th,td')].map(text)).filter(row => row.length > 0);
        return { name: text(table.closest('section,div')?.querySelector('h1,h2,h3,h4')) || 'Table ' + (index + 1), rows };
      }).filter(table => table.rows.length > 0);
      const result = {};
      for (const table of tables) {
        const [headers, ...rows] = table.rows;
        if (headers?.length) result[table.name] = rows.map(row => Object.fromEntries(headers.map((key, index) => [key || 'Column ' + (index + 1), row[index] ?? ''])));
      }
      if (Object.keys(result).length === 0) result['Content analysis'] = { content: text(document.body) };
      return result;
    })()`);
    if (visible && typeof visible === 'object' && Object.keys(visible).length > 0) data = visible;
  }
  if (Object.keys(data).length === 0) throw new CommandExecutionError('WeChat publish analysis returned no readable analysis data');
  const content = formatAnalysisMarkdown({ title, publishedAt, data });
  const path = await publishMarkdown(resolve(outputDir), safeFilename(title), content);
  const info = await stat(path);
  return { status: 'saved', path, size: info.size };
}
