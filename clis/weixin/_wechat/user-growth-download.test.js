import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';
import {
  buildUserGrowthDownloadUrl,
  downloadUserGrowthXls,
  isTrustedUserGrowthDownloadUrl,
} from './user-growth-download.js';

const BEGIN = '2026-07-30';
const END = '2026-08-28';
let root;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bycli-user-growth-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function requestUrl(token = 'secret') {
  return buildUserGrowthDownloadUrl({ token, begin: BEGIN, end: END });
}

function pageFor(filename, overrides = {}) {
  const url = requestUrl();
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForDownload: vi.fn().mockResolvedValue({
      downloaded: true,
      filename,
      state: 'complete',
      danger: 'safe',
      url,
      finalUrl: url,
    }),
    ...overrides,
  };
}

describe('official user-growth download URL', () => {
  it('always requests the aggregate WeChat workbook', () => {
    const url = new URL(requestUrl('a b'));
    expect(url.origin + url.pathname).toBe('https://mp.weixin.qq.com/misc/useranalysis');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      download: '1', begin_date: BEGIN, end_date: END,
      source: '99999999', token: 'a b', lang: 'zh_CN',
    });
  });

  it('accepts only the exact HTTPS aggregate download context', () => {
    const expected = requestUrl();
    expect(isTrustedUserGrowthDownloadUrl(expected, expected)).toBe(true);
    expect(isTrustedUserGrowthDownloadUrl(expected.replace('source=99999999', 'source=1'), expected)).toBe(false);
    expect(isTrustedUserGrowthDownloadUrl(expected.replace('https:', 'http:'), expected)).toBe(false);
    expect(isTrustedUserGrowthDownloadUrl('https://evil.example/misc/useranalysis?download=1', expected)).toBe(false);
  });
});

describe('official user-growth XLS publication', () => {
  it('publishes a completed non-empty XLS and removes the browser temporary file', async () => {
    const temporary = join(root, 'browser-download.xls');
    await writeFile(temporary, 'xls-content');
    const outputDir = join(root, 'exports');
    const page = pageFor(temporary);

    const result = await downloadUserGrowthXls(page, {
      token: 'secret', begin: BEGIN, end: END, outputDir,
    });

    expect(result).toEqual({
      status: 'downloaded',
      path: join(outputDir, `weixin-user-growth-${BEGIN}-${END}-all.xls`),
      size: 11,
    });
    expect(await readFile(result.path, 'utf8')).toBe('xls-content');
    await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(page.goto).toHaveBeenCalledWith(requestUrl(), { waitUntil: 'none' });
    expect(page.waitForDownload).toHaveBeenCalledWith(
      expect.stringContaining('download=1'),
      60_000,
      expect.objectContaining({ includeRecent: true, startedAfterMs: expect.any(Number) }),
    );
  });

  it('preserves an existing workbook with a numeric suffix', async () => {
    const outputDir = join(root, 'exports');
    const firstTemporary = join(root, 'first.xls');
    await writeFile(firstTemporary, 'first');
    const first = await downloadUserGrowthXls(pageFor(firstTemporary), {
      token: 'secret', begin: BEGIN, end: END, outputDir,
    });
    const secondTemporary = join(root, 'second.xls');
    await writeFile(secondTemporary, 'second');
    const second = await downloadUserGrowthXls(pageFor(secondTemporary), {
      token: 'secret', begin: BEGIN, end: END, outputDir,
    });
    expect(first.path).toMatch(/-all\.xls$/);
    expect(second.path).toMatch(/-all-1\.xls$/);
    expect(await readFile(first.path, 'utf8')).toBe('first');
    expect(await readFile(second.path, 'utf8')).toBe('second');
  });

  it('uses typed errors for unsupported, timed out, unsafe, and empty downloads', async () => {
    await expect(downloadUserGrowthXls({}, {
      token: 'secret', begin: BEGIN, end: END, outputDir: root,
    })).rejects.toBeInstanceOf(CommandExecutionError);

    const timedOut = pageFor(join(root, 'missing.xls'), {
      waitForDownload: vi.fn().mockResolvedValue({ downloaded: false }),
    });
    await expect(downloadUserGrowthXls(timedOut, {
      token: 'secret', begin: BEGIN, end: END, outputDir: root,
    })).rejects.toBeInstanceOf(TimeoutError);

    const empty = join(root, 'empty.xls');
    await writeFile(empty, '');
    await expect(downloadUserGrowthXls(pageFor(empty), {
      token: 'secret', begin: BEGIN, end: END, outputDir: root,
    })).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('does not expose the token or temporary path in transport and metadata errors', async () => {
    const temporary = join(root, 'private.xls');
    await writeFile(temporary, 'private');
    const page = pageFor(temporary, {
      waitForDownload: vi.fn().mockResolvedValue({
        downloaded: true, filename: temporary, state: 'complete', danger: 'safe',
        url: 'https://evil.example/file.xls?token=secret', finalUrl: '',
      }),
    });
    const error = await downloadUserGrowthXls(page, {
      token: 'secret', begin: BEGIN, end: END, outputDir: root,
    }).catch(value => value);
    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(error.message).not.toContain('secret');
    expect(error.message).not.toContain(temporary);
  });
});
