import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { cli } from '@sovovs/bycli/registry';
import { ArgumentError, AuthRequiredError, CliError, CommandExecutionError, EmptyResultError, TimeoutError } from '@sovovs/bycli/errors';
import { metadata, idArg, requiredId, connect, getMail, attachmentsOf, BASE, HOST } from './client.js';
import { browserDownloadResponse } from './browser-download.js';

function safeName(name) {
  const leaf = String(name).replaceAll('\\', '/').split('/').pop() ?? '';
  const clean = leaf.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  // Keep UTF-8 filenames below filesystem byte limits, preserving the extension.
  const ext = path.extname(clean).slice(0, 20);
  let stem = clean.slice(0, clean.length - ext.length) || 'attachment';
  while (Buffer.byteLength(stem + ext) > 220) stem = Array.from(stem).slice(0, -1).join('');
  return stem + ext;
}
async function reserveFile(directory, name) {
  const ext = path.extname(name); const stem = name.slice(0, name.length - ext.length);
  for (let index = 0; index < 10000; index++) {
    const file = path.join(directory, index ? `${stem} (${index})${ext}` : name);
    try { return { file, handle: await fs.open(file, 'wx', 0o600) }; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new CommandExecutionError('Too many files with the same attachment name');
}

export async function runDownload(page, args, deps = {}) {
  const id = requiredId(args.emailId);
  const output = path.resolve(String(args.output ?? '.'));
  await connect(page);
  const item = await getMail(page, id);
  const attachments = attachmentsOf(item);
  const selector = String(args.attachment ?? 'all');
  const selected = selector === 'all' ? attachments.filter(a => !a.inline)
    : attachments.filter(a => a.attachmentId === selector || String(a.index) === selector);
  if (!selected.length) throw new EmptyResultError('iwhalecloud download', 'No matching attachments; use read to inspect attachment IDs and indexes');
  if (selected.length > 1 && selector !== 'all') throw new ArgumentError('Attachment selector is ambiguous; use the attachment ID');
  if (selected.some(a => !a.attachmentId || a.kind !== 'FileAttachment')) {
    throw new CommandExecutionError('Only file attachments can be downloaded; select a FileAttachment ID shown by read');
  }
  try { await fs.mkdir(output, { recursive: true }); }
  catch { throw new CommandExecutionError('Cannot create attachment output directory', 'Choose a writable directory with --output'); }
  const rows = [];
  for (const attachment of selected) {
    let reserved;
    let response;
    try {
      response = deps.fetch
        ? await deps.fetch(`${BASE}/owa/service.svc/s/GetFileAttachment?id=${encodeURIComponent(attachment.attachmentId)}`)
        : await browserDownloadResponse(page, attachment.attachmentId);
      if ([301, 302, 303, 307, 308, 401, 403, 440].includes(response.status)) throw new AuthRequiredError(HOST);
      if (!response.ok || !response.body) throw new CommandExecutionError(`Attachment download failed (HTTP ${response.status})`);
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/html') && !attachment.contentType.includes('text/html')) throw new AuthRequiredError(HOST);
      reserved = await reserveFile(output, safeName(attachment.name));
      await pipeline(Readable.fromWeb(response.body), reserved.handle.createWriteStream());
      const stat = await fs.stat(reserved.file);
      rows.push({ emailId: id, attachmentId: attachment.attachmentId, name: attachment.name,
        path: reserved.file, size: stat.size, contentType: attachment.contentType });
    } catch (error) {
      if (reserved) { await reserved.handle.close().catch(() => {}); await fs.unlink(reserved.file).catch(() => {}); }
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      const saved = rows.length ? `; ${rows.length} earlier attachment(s) were saved in ${output}` : '';
      if (error instanceof CliError) { error.message += saved; throw error; }
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new TimeoutError(`Attachment download${saved}`, 120);
      throw new CommandExecutionError(`Attachment download failed${saved}`, 'Check connectivity and retry; existing files will not be overwritten');
    }
  }
  return rows;
}
cli({ ...metadata, name: 'download', description: '下载浩鲸邮件附件到本地目录，同名文件自动编号',
  example: 'bycli iwhalecloud download "<emailId>" --attachment all --output ./mail-downloads -f yaml',
  args: [idArg, { name: 'attachment', default: 'all', help: 'all（不含内嵌图片）、附件 ID 或 read 中的序号（从 1 开始）' },
    { name: 'output', default: '.', help: '本地输出目录' }],
  columns: ['emailId', 'attachmentId', 'name', 'path', 'size', 'contentType'], func: runDownload });
