import { describe, expect, it } from 'vitest';
import { extractAnalysisPayloads, formatAnalysisMarkdown } from './publish-analysis.js';

describe('publish analysis formatting', () => {
  it('renders nested metrics and record arrays as escaped Markdown tables', () => {
    expect(formatAnalysisMarkdown({
      title: 'Example | article', publishedAt: '2026-08-07',
      data: { summary: { reads: 12, note: 'line one\nline two' }, trend: [{ date: '2026-08-07', reads: 3 }] },
    })).toBe([
      '# Example \\| article', '', 'Published: 2026-08-07', '', '## summary', '',
      '| Metric | Value |', '| --- | --- |', '| reads | 12 |', '| note | line one<br>line two |', '',
      '## trend', '', '| date | reads |', '| --- | --- |', '| 2026-08-07 | 3 |', '',
    ].join('\n'));
  });

  it('keeps only successful JSON responses from trusted analysis endpoints', () => {
    expect(extractAnalysisPayloads([
      { url: 'https://mp.weixin.qq.com/misc/appmsganalysis?action=get', responseStatus: 200, responseContentType: 'application/json', responsePreview: '{"reads":12}' },
      { url: 'https://evil.example/misc/appmsganalysis?action=get', responseStatus: 200, responseContentType: 'application/json', responsePreview: '{"no":true}' },
      { url: 'https://mp.weixin.qq.com/misc/appmsganalysis?action=get', responseStatus: 500, responseContentType: 'application/json', responsePreview: '{"no":true}' },
    ])).toEqual([{ name: 'appmsganalysis', data: { reads: 12 } }]);
  });
});
