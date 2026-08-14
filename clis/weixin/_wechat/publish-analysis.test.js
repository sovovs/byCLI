import { describe, expect, it } from 'vitest';
import { extractAnalysisPayloads, filterPlaceholderTableRows, formatAnalysisMarkdown, isDatePickerCalendarTable, mergePaginatedTables, normalizeEchartsOptions, normalizeHighchartsAriaCharts, normalizeVisibleMetrics } from './publish-analysis.js';

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

  it('turns ECharts category series into readable data-point tables', () => {
    expect(normalizeEchartsOptions([{
      title: '阅读趋势',
      option: {
        xAxis: [{ data: ['第 1 天', '第 2 天'] }],
        series: [{ name: '阅读人数', data: [56, 42] }, { name: '分享', data: [2, 1] }],
      },
    }])).toEqual({
      '阅读趋势': [
        { '数据点': '第 1 天', '阅读人数': 56, '分享': 2 },
        { '数据点': '第 2 天', '阅读人数': 42, '分享': 1 },
      ],
    });
  });

  it('pairs visible metric labels with their nearby displayed values', () => {
    expect(normalizeVisibleMetrics([
      { text: '阅读', x: 110, y: 180 }, { text: '56人', x: 110, y: 230 },
      { text: '平均阅读时长', x: 320, y: 180 }, { text: '0.78分钟', x: 320, y: 230 },
      { text: '这是一段说明文字，不是数据标签', x: 0, y: 0 },
    ])).toEqual([{ 指标: '阅读', 数值: '56人' }, { 指标: '平均阅读时长', 数值: '0.78分钟' }]);
  });

  it('turns Highcharts point accessibility labels into chart tables', () => {
    expect(normalizeHighchartsAriaCharts([{ title: '阅读渠道', points: [
      '朋友圈, 62.5.', '公众号消息, 30.357142857142854.', '推荐, 0.',
    ] }])).toEqual({ '阅读渠道': [
      { 分类: '朋友圈', 数值: 62.5, 系列: '' }, { 分类: '公众号消息', 数值: 30.357142857142854, 系列: '' }, { 分类: '推荐', 数值: 0, 系列: '' },
    ] });
  });

  it('recognizes date-picker calendar grids without hiding normal data tables', () => {
    expect(isDatePickerCalendarTable([
      ['一', '二', '三', '四', '五', '六', '日'],
      ['27', '28', '29', '30', '31', '1', '2'],
      ['3', '4', '5', '6', '7', '8', '9'],
      ['10', '11', '12', '13', '14', '15', '16'],
      ['17', '18', '19', '20', '21', '22', '23'],
    ])).toBe(true);
    expect(isDatePickerCalendarTable([
      ['发布时间', '播放次数'], ['2026-08-07', '50'],
    ])).toBe(false);
  });

  it('drops placeholder-only tables and rows while retaining the real video row', () => {
    expect(filterPlaceholderTableRows([
      ['视频', '播放次数', '操作'],
      ['本体知识库', '50', '详细数据'],
      ['x', 'x', '展开内容'], ['', '', '展开内容'],
    ])).toEqual([
      ['视频', '播放次数', '操作'], ['本体知识库', '50', '详细数据'],
    ]);
    expect(filterPlaceholderTableRows([['x'], ['']])).toBeNull();
  });

  it('merges distinct rows from every page of a user-profile table', () => {
    expect(mergePaginatedTables([
      [{ section: '用户画像', data: [{ 地域: '广东省', 占比: '64.29%' }], name: '地域' }],
      [{ section: '用户画像', data: [{ 地域: '上海市', 占比: '10.71%' }], name: '地域' }],
    ])).toEqual([{ section: '用户画像', name: '地域', data: [
      { 地域: '广东省', 占比: '64.29%' }, { 地域: '上海市', 占比: '10.71%' },
    ] }]);
  });
});
