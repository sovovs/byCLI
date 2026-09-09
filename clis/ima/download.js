import fs from 'node:fs';
import path from 'node:path';
import { httpDownload } from '@sovovs/bycli/download';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import { readImaMediaUrl, readKnowledgeBaseFromChrome } from './native-client.js';
import { readCurrentViewerUrl } from './ax.js';
import { extractOriginUrl, resolveOutputPath, sha256File } from './download-utils.js';

function countPdfPages(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.subarray(0, 5).toString() !== '%PDF-') return null;
  return (bytes.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length || null;
}

export async function runDownloadCommand(page, kwargs, deps = {}) {
  const kb = String(kwargs.knowledgeBase ?? '').trim();
  const title = String(kwargs.file ?? '').trim();
  if (!kb || !title) throw new CommandExecutionError('knowledge base and file title are required');
  const currentViewer = deps.readCurrentViewerUrl?.(title)
    ?? (process.platform === 'darwin' ? readCurrentViewerUrl(title) : null);
  const effectivePage = page ?? (process.env.BYCLI_IMA_COOKIE ? {
    fetchJson: async (url, options = {}) => {
      const response = await fetch(url, { method: options.method ?? 'GET', headers: options.headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
      const text = await response.text();
      try { return JSON.parse(text); } catch { throw new Error(`IMA HTTP ${response.status}: invalid JSON response`); }
    },
  } : page);
  const reader = deps.read ?? ((query) => readKnowledgeBaseFromChrome(effectivePage, query));
  let envelope;
  if (currentViewer) {
    const origin = extractOriginUrl(currentViewer);
    const parsed = new URL(origin);
    envelope = {
      knowledgeBase: kb,
      items: [{ title, contentType: 'PDF', mediaId: parsed.searchParams.get('media_id') || '', url: currentViewer }],
    };
  } else {
    try {
      envelope = await reader(kb);
    } catch (error) {
      if (process.platform !== 'darwin') throw error;
      const { readKnowledgeBase: readKnowledgeBaseFromDesktop } = await import('./ax.js');
      envelope = await Promise.resolve(readKnowledgeBaseFromDesktop(kb));
    }
  }
  const items = (envelope?.items ?? []).filter((item) => item.title === title
    && (!kwargs.mediaId || item.mediaId === kwargs.mediaId));
  if (items.length === 0) throw new EmptyResultError('ima download', `File "${title}" was not found`);
  if (items.length > 1) throw new CommandExecutionError('Multiple files matched; specify --media-id');
  const item = items[0];
  let originUrl;
  if (currentViewer) originUrl = extractOriginUrl(currentViewer);
  if (item.url) {
    originUrl = String(item.url).startsWith('chrome-extension://')
      ? extractOriginUrl(item.url)
      : item.url;
  }
  if (!originUrl && kwargs.viewerUrl) originUrl = extractOriginUrl(kwargs.viewerUrl);
  if (!originUrl && page?.getCurrentUrl) {
    const currentUrl = await page.getCurrentUrl();
    if (currentUrl?.includes('originUrl=')) originUrl = extractOriginUrl(currentUrl);
  }
  let mediaError;
  if (!originUrl && deps.readOriginalUrl) {
    try {
      originUrl = await deps.readOriginalUrl(item);
    } catch (error) {
      mediaError = error;
    }
  }
  if (!originUrl && (effectivePage?.requestImaMedia || effectivePage?.fetchJson)) {
    try {
      originUrl = await readImaMediaUrl(effectivePage, { ...item, knowledgeBaseId: item.knowledgeBaseId || envelope.knowledgeBaseId });
    } catch (error) {
      mediaError = error;
    }
  }
  if (!originUrl && process.platform === 'darwin') {
    const { readKnowledgeBase: readKnowledgeBaseFromDesktop } = await import('./ax.js');
    const desktop = await Promise.resolve(readKnowledgeBaseFromDesktop(kb));
    const desktopItem = desktop?.items?.find((entry) => entry.title === title);
    if (desktopItem?.url) originUrl = desktopItem.url;
  }
  if (!originUrl) {
    const message = mediaError instanceof Error ? mediaError.message : 'IMA original file URL is unavailable; open the file in the IMA client first';
    throw new CommandExecutionError(message);
  }
  const outputPath = resolveOutputPath(kwargs.output || '.', item.title);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const download = deps.httpDownload ?? httpDownload;
  const result = await download(originUrl, outputPath, { timeout: 120000 });
  if (!result.success) throw new CommandExecutionError(result.error || 'IMA file download failed');
  const stat = fs.statSync(outputPath);
  const sha256 = await sha256File(outputPath);
  const pages = item.contentType === 'PDF' ? countPdfPages(outputPath) : null;
  return [{ path: outputPath, title: item.title, contentType: item.contentType, size: stat.size, sha256, pages }];
}

cli({
  site: 'ima', name: 'download', access: 'read', description: '下载 ima 知识库中的完整原始文件（Linux 无需 IMA App）',
  domain: 'ima.qq.com', strategy: Strategy.COOKIE, browser: () => !process.env.BYCLI_IMA_COOKIE, navigateBefore: false,
  args: [
    { name: 'knowledgeBase', positional: true, required: true, help: '知识库名称或 ID' },
    { name: 'file', positional: true, required: true, help: '文件标题' },
    { name: 'output', flags: '--output <path>', default: '.', help: '输出文件或目录' },
    { name: 'mediaId', flags: '--media-id <id>', help: 'IMA mediaId，用于精确定位' },
    { name: 'viewerUrl', flags: '--viewer-url <url>', help: '已打开的 IMA 查看器 URL（含 originUrl 签名参数；Linux 可省略）' },
  ],
  columns: ['path', 'title', 'contentType', 'size', 'sha256', 'pages'],
  func: (page, kwargs) => runDownloadCommand(page, kwargs),
});

export const __test__ = { countPdfPages, runDownloadCommand };
