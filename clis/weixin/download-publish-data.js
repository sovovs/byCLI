import { ArgumentError } from '@sovovs/bycli/errors';
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
} from './_wechat/publish-records.js';

const COLUMNS = [
  'title', 'publishedAt', 'url', 'status',
  'markdownPath', 'markdownSize', 'dataPath', 'dataSize', 'error',
];

function sanitizedError(error, secrets, fallback) {
  const message = error instanceof Error ? error.message : fallback;
  return redactText(message, secrets)
    .replace(/https?:\/\/mp\.weixin\.qq\.com\/\S*/giu, '[REDACTED]');
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
    const record = matchPublishedRecord(rows, query, validatedDate);
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
      dataResult = await downloadPublishData(page, commonOptions);
    } catch (error) {
      errors.push(`Excel download failed: ${sanitizedError(error, secrets, 'Excel download failed')}`);
    }
    try {
      markdownResult = await collectPublishAnalysis(page, {
        ...commonOptions,
        publishedAt: record.publishedAt,
      });
    } catch (error) {
      errors.push(`Markdown analysis failed: ${sanitizedError(error, secrets, 'Markdown analysis failed')}`);
    }

    const status = dataResult && markdownResult ? 'downloaded'
      : dataResult || markdownResult ? 'partial' : 'failed';
    return [{
      title: record.title,
      publishedAt: record.publishedAt,
      url: record.url,
      status,
      markdownPath: markdownResult?.path ?? null,
      markdownSize: markdownResult?.size ?? null,
      dataPath: dataResult?.path ?? null,
      dataSize: dataResult?.size ?? null,
      error: errors.length > 0 ? errors.join('; ') : null,
    }];
  },
});
