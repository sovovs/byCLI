import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { resolveBrowserCredentials } from './_wechat/auth-session.js';
import { buildSecretSet, redactText } from './_wechat/redact.js';
import { collectPublishAnalysis } from './_wechat/publish-analysis.js';
import { downloadPublishData } from './_wechat/publish-download.js';
import {
  buildDetailUrl,
  collectPublishedRecords,
  matchPublishedRecord,
  positiveSafeInteger,
  validatePublishDate,
  validatePublishedQuery,
} from './_wechat/publish-records.js';

const METRIC_COLUMNS = [
  'readUsers', 'avgReadMinutes', 'finishedReadRatio', 'newFollowers', 'listenUsers',
  'shares', 'zaikan', 'likes', 'rewardYuan', 'comments', 'collections',
];

const COLUMNS = [
  'title', 'publishedAt', 'url', 'status',
  ...METRIC_COLUMNS,
  'markdownPath', 'markdownSize', 'dataPath', 'dataSize', 'error',
];

function sanitizedError(error, secrets, fallback) {
  const message = error instanceof Error ? error.message : fallback;
  return redactText(message, secrets)
    .replace(/https?:\/\/mp\.weixin\.qq\.com\/\S*/giu, '[REDACTED]');
}

async function validateArtifact(result, { label, expectedStatus, expectedExtension }) {
  if (!result || result.status !== expectedStatus) {
    throw new CommandExecutionError(`${label} returned an invalid status`);
  }
  if (typeof result.path !== 'string' || !result.path.trim()) {
    throw new CommandExecutionError(`${label} returned no output path`);
  }
  if (!Number.isSafeInteger(result.size) || result.size <= 0) {
    throw new CommandExecutionError(`${label} returned an invalid size`);
  }
  const path = resolve(result.path);
  if (extname(path).toLowerCase() !== expectedExtension) {
    throw new CommandExecutionError(`${label} returned an unexpected file type`);
  }
  let info;
  try {
    await access(path, constants.R_OK);
    info = await stat(path);
  } catch {
    throw new CommandExecutionError(`${label} returned an unreadable file`);
  }
  if (!info.isFile() || info.size <= 0 || info.size !== result.size) {
    throw new CommandExecutionError(`${label} returned an unreadable or mismatched file`);
  }
  return { ...result, path, size: info.size };
}

export const downloadPublishDataCommand = cli({
  site: 'weixin',
  name: 'download-publish-data',
  access: 'write',
  domain: 'mp.weixin.qq.com',
  description: 'Match a Weixin published article and save its Excel data and Markdown analysis',
  strategy: Strategy.INTERCEPT,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'query', positional: true, required: true, help: 'Exact article URL or title text' },
    { name: 'date', help: 'Optional publication date in YYYY-MM-DD' },
    { name: 'output', default: './weixin-publish-data', help: 'Directory for generated Excel data and Markdown reports' },
    { name: 'max-pages', type: 'int', default: 5, help: 'Maximum published-record pages to scan' },
    { name: 'timeout', type: 'int', default: 60, help: 'Maximum seconds for page capture' },
  ],
  columns: COLUMNS,
  func: async (page, args) => {
    const query = String(args.query ?? '').trim();
    if (!query) throw new ArgumentError('query required');
    const validatedQuery = validatePublishedQuery(query);

    const timeoutSeconds = positiveSafeInteger(args.timeout, 'timeout', 60);
    const maxPages = positiveSafeInteger(args['max-pages'], 'max-pages', 5);
    const validatedDate = validatePublishDate(args.date);
    const scanLimit = maxPages * 10;
    if (!Number.isSafeInteger(scanLimit)) throw new ArgumentError('max-pages is too large');
    const { token, cookie } = await resolveBrowserCredentials(page);
    const rows = await collectPublishedRecords(page, {
      token,
      limit: scanLimit,
      maxPages,
      timeout: timeoutSeconds,
    });
    const record = matchPublishedRecord(rows, validatedQuery, validatedDate);
    const detailUrl = buildDetailUrl(record, token);
    const outputDir = args.output ?? './weixin-publish-data';
    const commonOptions = {
      detailUrl,
      title: record.title,
      outputDir,
      timeoutSeconds,
    };
    const secrets = buildSecretSet({ token, cookie });

    let dataResult = null;
    let markdownResult = null;
    const errors = [];
    try {
      const result = await downloadPublishData(page, commonOptions);
      dataResult = await validateArtifact(result, {
        label: 'Excel artifact',
        expectedStatus: 'downloaded',
        expectedExtension: '.xls',
      });
    } catch (error) {
      errors.push(`Excel download failed: ${sanitizedError(error, secrets, 'Excel download failed')}`);
    }
    try {
      const result = await collectPublishAnalysis(page, {
        ...commonOptions,
        publishedAt: record.publishedAt,
      });
      markdownResult = await validateArtifact(result, {
        label: 'Markdown artifact',
        expectedStatus: 'saved',
        expectedExtension: '.md',
      });
    } catch (error) {
      errors.push(`Markdown analysis failed: ${sanitizedError(error, secrets, 'Markdown analysis failed')}`);
    }

    const status = dataResult && markdownResult ? 'downloaded'
      : dataResult || markdownResult ? 'partial' : 'failed';
    const metrics = markdownResult?.metrics ?? null;

    // Prefer published list data over detail page metrics where they overlap.
    // The list endpoint may be more current or use different aggregation logic.
    const mergedMetrics = {
      readUsers: record.reads ?? metrics?.readUsers ?? null,
      avgReadMinutes: metrics?.avgReadMinutes ?? null,
      finishedReadRatio: metrics?.finishedReadRatio ?? null,
      newFollowers: metrics?.newFollowers ?? null,
      listenUsers: metrics?.listenUsers ?? null,
      shares: record.shares ?? metrics?.shares ?? null,
      zaikan: metrics?.zaikan ?? null,
      likes: record.likes ?? metrics?.likes ?? null,
      rewardYuan: metrics?.rewardYuan ?? null,
      comments: record.comments ?? metrics?.comments ?? null,
      collections: metrics?.collections ?? null,
    };

    return [{
      title: record.title,
      publishedAt: record.publishedAt,
      url: record.url,
      status,
      ...mergedMetrics,
      markdownPath: markdownResult?.path ?? null,
      markdownSize: markdownResult?.size ?? null,
      dataPath: dataResult?.path ?? null,
      dataSize: dataResult?.size ?? null,
      error: errors.length > 0 ? errors.join('; ') : null,
    }];
  },
});
