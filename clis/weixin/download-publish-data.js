import { ArgumentError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { resolveBrowserCredentials } from './_wechat/auth-session.js';
import { buildSecretSet, redactText } from './_wechat/redact.js';
import { collectPublishAnalysis } from './_wechat/publish-analysis.js';
import {
  buildDetailUrl,
  collectPublishedRecords,
  matchPublishedRecord,
  positiveSafeInteger,
  validatePublishDate,
} from './_wechat/publish-records.js';

const COLUMNS = ['title', 'publishedAt', 'url', 'status', 'markdownPath', 'size', 'error'];

export const downloadPublishDataCommand = cli({
  site: 'weixin',
  name: 'download-publish-data',
  access: 'write',
  domain: 'mp.weixin.qq.com',
  description: 'Match a Weixin published article and save its content analysis as Markdown',
  strategy: Strategy.INTERCEPT,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'query', positional: true, required: true, help: 'Exact article URL or title text' },
    { name: 'date', help: 'Optional publication date in YYYY-MM-DD' },
    { name: 'output', default: './weixin-publish-data', help: 'Directory for generated Markdown reports' },
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
    try {
      const result = await collectPublishAnalysis(page, {
        detailUrl, title: record.title, publishedAt: record.publishedAt,
        outputDir: args.output ?? './weixin-publish-data', timeoutSeconds,
      });
      return [{ title: record.title, publishedAt: record.publishedAt, url: record.url,
        status: result.status, markdownPath: result.path, size: result.size, error: null }];
    } catch (error) {
      return [{ title: record.title, publishedAt: record.publishedAt, url: record.url,
        status: 'failed', markdownPath: null, size: null,
        error: error instanceof Error
          ? redactText(error.message, buildSecretSet({ token, cookie })).replace(/https?:\/\/mp\.weixin\.qq\.com\/\S*/giu, '[REDACTED]')
          : 'Analysis collection failed' }];
    }
  },
});
