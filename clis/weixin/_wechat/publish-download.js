import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, stat, unlink } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';

function commandError(message) {
  return new CommandExecutionError(`WeChat publish-data download ${message}`);
}

function trustedDownloadLink(link, detailUrl) {
  let candidate;
  let detail;
  try {
    candidate = new URL(link);
    detail = new URL(detailUrl);
  } catch {
    return false;
  }

  return candidate.protocol === 'https:'
    && candidate.hostname === 'mp.weixin.qq.com'
    && candidate.port === ''
    && candidate.pathname === '/misc/appmsganalysis'
    && candidate.searchParams.get('action') === 'detailpage'
    && candidate.searchParams.get('msgid') === detail.searchParams.get('msgid')
    && candidate.searchParams.get('publish_date') === detail.searchParams.get('publish_date')
    && candidate.searchParams.get('download') === '1';
}

function safeFilename(filename, title) {
  const fallback = `数据明细（${title}）.xls`;
  const clean = value => basename(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim();
  let name = clean(filename || fallback) || clean(fallback) || 'publish-data.xls';
  if (extname(name).toLowerCase() !== '.xls') name += '.xls';
  return name;
}

async function publishExclusively(source, outputDir, filename) {
  const extension = extname(filename);
  const stem = filename.slice(0, -extension.length);
  const temporary = resolve(outputDir, `.bycli-publish-data-${randomUUID()}.tmp`);
  let temporaryCreated = false;

  try {
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL);
      temporaryCreated = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        try {
          await unlink(temporary);
        } catch {
          // COPYFILE_EXCL may fail before creating its destination.
        }
      }
      throw commandError('could not stage the downloaded file');
    }

    for (let index = 0; index <= 9999; index += 1) {
      const candidate = resolve(outputDir, index === 0 ? filename : `${stem}-${index}${extension}`);
      try {
        await link(temporary, candidate);
        return candidate;
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        throw commandError('could not publish the downloaded file');
      }
    }

    throw commandError('could not allocate a destination filename');
  } finally {
    if (temporaryCreated) {
      try {
        await unlink(temporary);
      } catch {
        // The final hard link, once created, remains a complete valid file.
      }
    }
  }
}

export async function downloadPublishData(page, options) {
  if (typeof page?.waitForDownload !== 'function') {
    throw commandError('requires browser download support');
  }

  await page.goto(options.detailUrl);
  const detail = await page.evaluate(() => ({
    title: document.querySelector('#js_mp_main_content')?.textContent ?? '',
    link: document.querySelector('a.target_part[href*="download=1"]')?.href ?? '',
  }));

  if (typeof detail?.title !== 'string' || !detail.title.includes(options.title)) {
    throw commandError('opened an unexpected article detail page');
  }
  if (!trustedDownloadLink(detail?.link, options.detailUrl)) {
    throw commandError('rejected an untrusted download link');
  }
  const trustedUrl = new URL(detail.link);
  const msgid = trustedUrl.searchParams.get('msgid');
  const publishDate = trustedUrl.searchParams.get('publish_date');
  if (!msgid) {
    throw commandError('rejected a download link without a message id');
  }
  if (!publishDate) {
    throw commandError('rejected a download link without a publish date');
  }

  const startedAfterMs = Date.now();
  await page.goto(detail.link, { waitUntil: 'none' });
  const downloaded = await page.waitForDownload(
    `&msgid=${encodeURIComponent(msgid)}&publish_date=${encodeURIComponent(publishDate)}&`,
    options.timeoutSeconds * 1000,
    { includeRecent: true, startedAfterMs },
  );

  if (!downloaded || downloaded.downloaded !== true) {
    throw new TimeoutError('Weixin publish-data download', options.timeoutSeconds);
  }
  if (typeof downloaded.filename !== 'string'
    || downloaded.filename.length === 0
    || downloaded.state !== 'complete'
    || !['safe', 'accepted'].includes(downloaded.danger)) {
    throw commandError('returned incomplete or unsafe download metadata');
  }
  if (![downloaded.url, downloaded.finalUrl]
    .some(url => trustedDownloadLink(url, options.detailUrl))) {
    throw commandError('rejected an unrelated downloaded file');
  }

  let sourceStat;
  try {
    sourceStat = await stat(downloaded.filename);
  } catch {
    throw commandError('could not read the downloaded file');
  }
  if (!sourceStat.isFile() || sourceStat.size <= 0) {
    throw commandError('returned an empty downloaded file');
  }

  const outputDir = resolve(options.outputDir);
  try {
    await mkdir(outputDir, { recursive: true });
  } catch {
    throw commandError('could not create the output directory');
  }

  const target = await publishExclusively(
    downloaded.filename,
    outputDir,
    safeFilename(downloaded.filename, options.title),
  );
  try {
    await unlink(downloaded.filename);
  } catch {
    // The destination was atomically published; source cleanup is best effort.
  }

  return { status: 'downloaded', path: target, size: sourceStat.size };
}
