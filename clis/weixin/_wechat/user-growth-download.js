import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, stat, unlink } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { ArgumentError, CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';
import { buildGrowthUrl } from './user-analysis.js';

const DOWNLOAD_TIMEOUT_MS = 60_000;

function commandError(message) {
  return new CommandExecutionError(`WeChat user-growth XLS download ${message}`);
}

export function buildUserGrowthDownloadUrl({ token, begin, end }) {
  const url = new URL(buildGrowthUrl({
    token,
    begin,
    end,
    sourceCodes: [99999999],
  }));
  url.searchParams.delete('f');
  url.searchParams.delete('ajax');
  url.searchParams.set('download', '1');
  return url.toString();
}

export function isTrustedUserGrowthDownloadUrl(candidateValue, expectedValue) {
  let candidate;
  let expected;
  try {
    candidate = new URL(candidateValue);
    expected = new URL(expectedValue);
  } catch {
    return false;
  }
  const exactParams = ['download', 'begin_date', 'end_date', 'source', 'token'];
  return candidate.protocol === 'https:'
    && candidate.hostname === 'mp.weixin.qq.com'
    && candidate.port === ''
    && candidate.pathname === '/misc/useranalysis'
    && exactParams.every(name => candidate.searchParams.get(name) === expected.searchParams.get(name))
    && candidate.searchParams.get('download') === '1'
    && candidate.searchParams.get('source') === '99999999';
}

async function publishExclusively(source, outputDir, filename, beforePublish) {
  const extension = extname(filename);
  const stem = filename.slice(0, -extension.length);
  const staged = resolve(outputDir, `.bycli-user-growth-${randomUUID()}.tmp`);
  let stagedCreated = false;
  try {
    try {
      await copyFile(source, staged, constants.COPYFILE_EXCL);
      stagedCreated = true;
    } catch {
      try {
        await unlink(staged);
      } catch {
        // COPYFILE_EXCL may fail before creating its destination.
      }
      throw commandError('could not stage the downloaded file');
    }
    for (let index = 0; index <= 9999; index += 1) {
      const candidate = resolve(outputDir, index === 0 ? filename : `${stem}-${index}${extension}`);
      try {
        await beforePublish?.();
        await link(staged, candidate);
        return candidate;
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        throw commandError('could not publish the downloaded file');
      }
    }
    throw commandError('could not allocate a destination filename');
  } finally {
    if (stagedCreated) {
      try {
        await unlink(staged);
      } catch {
        // The final hard link remains a complete file.
      }
    }
  }
}

export async function downloadUserGrowthXls(page, options) {
  if (typeof options?.outputDir !== 'string' || !options.outputDir.trim()) {
    throw new ArgumentError('output must be a non-empty directory');
  }
  if (typeof page?.waitForDownload !== 'function') {
    throw commandError('requires browser download support');
  }

  const expectedUrl = buildUserGrowthDownloadUrl(options);
  const startedAfterMs = Date.now();
  let downloaded;
  try {
    await page.goto(expectedUrl, { waitUntil: 'none' });
    downloaded = await page.waitForDownload('download=1', DOWNLOAD_TIMEOUT_MS, {
      includeRecent: true,
      startedAfterMs,
    });
  } catch (error) {
    if (error instanceof TimeoutError) throw error;
    throw commandError('could not complete the browser download');
  }

  if (!downloaded || downloaded.downloaded !== true) {
    throw new TimeoutError('Weixin user-growth XLS download', DOWNLOAD_TIMEOUT_MS / 1000);
  }
  if (typeof downloaded.filename !== 'string'
    || !downloaded.filename
    || extname(downloaded.filename).toLowerCase() !== '.xls'
    || downloaded.state !== 'complete'
    || !['safe', 'accepted'].includes(downloaded.danger)) {
    throw commandError('returned incomplete or unsafe download metadata');
  }
  if (![downloaded.url, downloaded.finalUrl]
    .some(value => isTrustedUserGrowthDownloadUrl(value, expectedUrl))) {
    throw commandError('rejected an unrelated downloaded file');
  }

  let sourceInfo;
  try {
    sourceInfo = await stat(downloaded.filename);
  } catch {
    throw commandError('could not read the downloaded file');
  }
  if (!sourceInfo.isFile() || sourceInfo.size <= 0) {
    throw commandError('returned an empty downloaded file');
  }

  const outputDir = resolve(options.outputDir);
  try {
    await mkdir(outputDir, { recursive: true });
  } catch {
    throw commandError('could not create the output directory');
  }
  const filename = `weixin-user-growth-${options.begin}-${options.end}-all.xls`;
  const target = await publishExclusively(
    downloaded.filename,
    outputDir,
    filename,
    options.beforePublish,
  );
  try {
    await unlink(downloaded.filename);
  } catch {
    // Destination publication succeeded; browser temporary cleanup is best effort.
  }
  return { status: 'downloaded', path: target, size: sourceInfo.size };
}
