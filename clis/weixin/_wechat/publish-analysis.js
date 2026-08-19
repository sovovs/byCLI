import { link, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CommandExecutionError } from '@sovovs/bycli/errors';
import { articleMetricsSections, collectArticleMetrics } from './article-metrics.js';

const DOMAIN = 'mp.weixin.qq.com';

function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function heading(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function table(headers, rows) {
  return [`| ${headers.map(cell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)];
}

function appendSection(lines, name, value, level = 2) {
  if (value === null || value === undefined) return;
  lines.push(`${'#'.repeat(level)} ${heading(name)}`, '');
  if (Array.isArray(value)) {
    if (value.length === 0) { lines.push('_No data_', ''); return; }
    if (value.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
      const headers = [...new Set(value.flatMap(item => Object.keys(item)))];
      lines.push(...table(headers, value.map(item => headers.map(key => item[key]))), '');
      return;
    }
    lines.push(...table(['Value'], value.map(item => [item])), '');
    return;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    const scalars = entries.filter(([, item]) => item === null || typeof item !== 'object');
    if (scalars.length) lines.push(...table(['Metric', 'Value'], scalars), '');
    for (const [key, item] of entries.filter(([, item]) => item && typeof item === 'object')) appendSection(lines, key, item, level + 1);
    return;
  }
  lines.push(...table(['Metric', 'Value'], [[name, value]]), '');
}

export function formatAnalysisMarkdown({ title, publishedAt, data }) {
  const lines = [`# ${heading(title)}`, '', `Published: ${cell(publishedAt)}`, ''];
  for (const [name, value] of Object.entries(data ?? {})) appendSection(lines, name, value);
  return `${lines.join('\n').trimEnd()}\n`;
}

export function extractAnalysisPayloads(entries) {
  const result = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    try {
      const url = new URL(String(entry?.url ?? ''));
      if (url.protocol !== 'https:' || url.hostname !== DOMAIN || url.port !== ''
        || !['/misc/appmsganalysis', '/misc/videoanalysis'].includes(url.pathname)
        || Number(entry.responseStatus) !== 200) continue;
      const text = entry.responsePreview;
      if (typeof text !== 'string') continue;
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object') continue;
      result.push({ name: url.pathname.split('/').at(-1), data });
    } catch { /* unrelated or malformed response */ }
  }
  return result;
}

function seriesValue(value) {
  if (value && typeof value === 'object' && 'value' in value) return value.value;
  return value;
}

export function normalizeEchartsOptions(charts) {
  const result = {};
  for (const [index, chart] of (Array.isArray(charts) ? charts : []).entries()) {
    const option = chart?.option;
    const series = Array.isArray(option?.series) ? option.series : [];
    if (series.length === 0) continue;
    const axis = Array.isArray(option?.xAxis) ? option.xAxis[0] : option?.xAxis;
    const labels = Array.isArray(axis?.data) ? axis.data : [];
    const rowCount = Math.max(labels.length, ...series.map(item => Array.isArray(item?.data) ? item.data.length : 0));
    if (rowCount === 0) continue;
    const baseName = String(chart?.title || `图表 ${index + 1}`);
    const name = result[baseName] ? `${baseName} ${index + 1}` : baseName;
    result[name] = Array.from({ length: rowCount }, (_, rowIndex) => Object.fromEntries([
      ['数据点', labels[rowIndex] ?? String(rowIndex + 1)],
      ...series.map((item, seriesIndex) => [String(item?.name || `系列 ${seriesIndex + 1}`), seriesValue(item?.data?.[rowIndex])]),
    ]));
  }
  return result;
}

export function normalizeVisibleMetrics(leaves) {
  const result = new Map();
  const excludedLabels = new Set(['人', '次', '元', '条', 'Chart', '数据指标', '未知', '下一页', '搜一搜', '占比']);
  for (const value of (Array.isArray(leaves) ? leaves : [])) {
    const valueText = String(value?.text ?? '').trim();
    if (value?.inSvg || value?.inTable || !/^(?:--|[0-9][0-9,.]*(?:%|人|次|元|分钟|条)?$)/.test(valueText)) continue;
    const candidates = leaves.filter(label => {
      const labelText = String(label?.text ?? '').trim();
      return label !== value && !label?.inSvg && !label?.inTable && labelText.length >= 2 && labelText.length <= 24
        && !excludedLabels.has(labelText)
        && /[\p{L}]/u.test(labelText) && !/[0-9]/.test(labelText)
        && Number(label?.y) <= Number(value?.y) && Number(value?.y) - Number(label?.y) <= 110
        && Math.abs(Number(label?.x) - Number(value?.x)) <= 260;
    });
    candidates.sort((left, right) => {
      const leftDistance = (Number(value.y) - Number(left.y)) * 2 + Math.abs(Number(value.x) - Number(left.x));
      const rightDistance = (Number(value.y) - Number(right.y)) * 2 + Math.abs(Number(value.x) - Number(right.x));
      return leftDistance - rightDistance;
    });
    if (candidates[0]) {
      const label = String(candidates[0].text).trim();
      const score = (Number(value.y) - Number(candidates[0].y)) * 2 + Math.abs(Number(value.x) - Number(candidates[0].x));
      if (!result.has(label) || score < result.get(label).score) result.set(label, { 指标: label, 数值: valueText, score });
    }
  }
  return [...result.values()].map(({ 指标, 数值 }) => ({ 指标, 数值 }));
}

export function normalizeHighchartsAriaCharts(charts) {
  const result = {};
  for (const [index, chart] of (Array.isArray(charts) ? charts : []).entries()) {
    const rows = [];
    for (const label of (Array.isArray(chart?.points) ? chart.points : [])) {
      const match = /^(.+?), (No value|[-+]?\d+(?:\.\d+)?)\.(?: (.+?)\.)?$/.exec(String(label));
      if (!match || match[2] === 'No value') continue;
      rows.push({ 分类: match[1], 数值: Number(match[2]), 系列: match[3] ?? '' });
    }
    if (rows.length === 0) continue;
    const baseName = String(chart?.title || `图表 ${index + 1}`);
    const name = result[baseName] ? `${baseName} ${index + 1}` : baseName;
    result[name] = rows;
  }
  return result;
}

export function isDatePickerCalendarTable(rows) {
  const weekdays = new Set(['一', '二', '三', '四', '五', '六', '日']);
  const [headers, ...dates] = Array.isArray(rows) ? rows : [];
  return Array.isArray(headers) && headers.length === 7 && headers.every(value => weekdays.has(String(value).trim()))
    && dates.length >= 4 && dates.every(row => Array.isArray(row) && row.length === 7
      && row.every(value => /^\d{1,2}$/.test(String(value).trim())));
}

function isPlaceholderCell(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text === '' || text === 'x' || text === '展开内容' || /^>?(?:\s*x)+\s*展开内容$/.test(text);
}

export function filterPlaceholderTableRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (rows[0].every(isPlaceholderCell)) return null;
  return [rows[0], ...rows.slice(1).filter(row => !row.every(isPlaceholderCell))];
}

export function mergePaginatedTables(pages) {
  const merged = new Map();
  for (const tables of (Array.isArray(pages) ? pages : [])) for (const table of (Array.isArray(tables) ? tables : [])) {
    if (!table?.section || !table?.name || !Array.isArray(table.data)) continue;
    const key = `${table.section}\u0000${table.name}`;
    const current = merged.get(key) ?? { ...table, data: [] };
    const existing = new Set(current.data.map(row => JSON.stringify(row)));
    for (const row of table.data) {
      const signature = JSON.stringify(row);
      if (!existing.has(signature)) { existing.add(signature); current.data.push(row); }
    }
    merged.set(key, current);
  }
  return [...merged.values()];
}

const RUNTIME_ANALYSIS_JS = `(() => {
  const ownText = element => [...element.childNodes]
    .filter(node => node.nodeType === Node.TEXT_NODE)
    .map(node => node.textContent || '').join(' ').replace(/\\s+/g, ' ').trim();
  const text = element => String(element?.innerText ?? element?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const selectorFor = element => {
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      const siblings = [...node.parentElement.children].filter(item => item.tagName === node.tagName);
      parts.unshift(tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')');
    }
    return 'body > ' + parts.join(' > ');
  };
  const leaves = [...document.querySelectorAll('body *')].filter(element => {
    const box = element.getBoundingClientRect();
    return element.children.length === 0 && box.width > 0 && box.height > 0 && text(element).length > 0 && text(element).length <= 80;
  }).map(element => {
    const box = element.getBoundingClientRect();
    return {
      text: text(element), x: Math.round(box.x), y: Math.round(box.y),
      inSvg: Boolean(element.closest('svg')), inTable: Boolean(element.closest('table')),
    };
  }).slice(0, 2000);
  const tables = [];
  const publishedSectionFor = element => {
    if (element.closest('.read_part')) return '阅读分析';
    if (element.closest('.trans_part')) return '转化分析';
    if (element.closest('.share_part')) return '分享分析';
    if (element.closest('.user_part')) return '用户画像';
    return '';
  };
  const weekdayNames = new Set(['一', '二', '三', '四', '五', '六', '日']);
  for (const [index, table] of [...document.querySelectorAll('table')].entries()) {
    const rows = [...table.querySelectorAll('tr')].map(row => [...row.querySelectorAll('th,td')].map(text)).filter(row => row.length > 0);
    if (rows.length < 2 || rows[0].length === 0) continue;
    const [calendarHeader, ...calendarDates] = rows;
    const isDatePicker = calendarHeader.length === 7 && calendarHeader.every(value => weekdayNames.has(value))
      && calendarDates.length >= 4 && calendarDates.every(row => row.length === 7 && row.every(value => /^\\d{1,2}$/.test(value)));
    if (isDatePicker) continue;
    const isPlaceholderCell = value => {
      const valueText = String(value || '').replace(/\\s+/g, ' ').trim();
      return valueText === '' || valueText === 'x' || valueText === '展开内容' || /^>?(?:\\s*x)+\\s*展开内容$/.test(valueText);
    };
    if (rows[0].every(isPlaceholderCell)) continue;
    const keptRows = [rows[0], ...rows.slice(1).filter(row => !row.every(isPlaceholderCell))];
    const headers = keptRows[0];
    const data = keptRows.slice(1).map(row => Object.fromEntries(headers.map((key, column) => [key || '列 ' + (column + 1), row[column] ?? ''])));
    tables.push({
      name: text(table.closest('section,article,div')?.querySelector('h1,h2,h3,h4,[role="heading"]')) || '表格 ' + (index + 1),
      data, section: publishedSectionFor(table), videoDetail: Boolean(table.closest('.video-data__panel')),
    });
  }
  const charts = [];
  const echarts = window.echarts;
  if (echarts?.getInstanceByDom) for (const element of document.querySelectorAll('[_echarts_instance_]')) {
    try {
      const chart = echarts.getInstanceByDom(element); const option = chart?.getOption?.();
      if (!option) continue;
      const container = element.closest('section,article,div');
      const title = text(container?.querySelector('h1,h2,h3,h4,[role="heading"]')) || '图表 ' + (charts.length + 1);
      charts.push({ title, option: { xAxis: option.xAxis, series: option.series } });
    } catch { /* a chart may be destroyed while the page is rendering */ }
  }
  const highcharts = window.Highcharts;
  if (Array.isArray(highcharts?.charts)) for (const chart of highcharts.charts) {
    if (!chart?.series?.length) continue;
    charts.push({ title: chart.title?.textStr || '图表 ' + (charts.length + 1), option: {
      xAxis: [{ data: chart.xAxis?.[0]?.categories ?? [] }],
      series: chart.series.map(series => ({ name: series.name, data: series.yData })),
    } });
  }
  const highchartsAriaCharts = [...document.querySelectorAll('svg.highcharts-root')].map((svg, index) => {
    const panel = svg.closest('.weui-desktop-panel') || svg.parentElement?.parentElement?.parentElement;
    const title = String(panel?.innerText ?? '').split(/\\r?\\n/).map(item => item.trim()).find(item => item && item !== 'Chart')
      || svg.parentElement?.parentElement?.id || '图表 ' + (index + 1);
    return { title, points: [...svg.querySelectorAll('.highcharts-point[aria-label]')].map(point => point.getAttribute('aria-label')), section: publishedSectionFor(svg) };
  });
  const reactOptions = [];
  const seenOptions = new Set();
  const addOption = (value, title) => {
    if (!value || typeof value !== 'object' || !Array.isArray(value.series)) return;
    const option = { xAxis: value.xAxis ?? (value.categories ? [{ data: value.categories }] : undefined), series: value.series };
    try {
      const signature = JSON.stringify(option);
      if (!seenOptions.has(signature)) { seenOptions.add(signature); reactOptions.push({ title, option }); }
    } catch { /* ignore circular component props */ }
  };
  const scanProps = (root, title) => {
    const queue = [[root, 0]]; const seen = new Set();
    while (queue.length) {
      const [value, depth] = queue.shift();
      if (!value || typeof value !== 'object' || seen.has(value) || depth > 5) continue;
      seen.add(value); addOption(value, title);
      for (const key of Object.keys(value).slice(0, 80)) {
        if (!/^(?:option|options|data|series|xAxis|categories|config|chart|props|children)$/i.test(key)) continue;
        try { queue.push([value[key], depth + 1]); } catch { /* guarded host property */ }
      }
    }
  };
  for (const element of document.querySelectorAll('[role="img"], svg, canvas')) {
    const container = element.closest('section,article,div');
    const title = text(container?.querySelector('h1,h2,h3,h4,[role="heading"]')) || '图表 ' + (charts.length + reactOptions.length + 1);
    for (const key of Object.keys(element)) if (key.startsWith('__reactProps$')) scanProps(element[key], title);
    for (const key of Object.keys(element)) if (key.startsWith('__reactFiber$')) {
      let fiber = element[key];
      for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
        scanProps(fiber.memoizedProps, title); scanProps(fiber.pendingProps, title);
      }
    }
  }
  charts.push(...reactOptions);
  const controls = [...document.querySelectorAll('button,a,[role="button"],div,span')]
    .filter(element => ['发表后7天', '发表后30天'].includes(ownText(element)))
    .map(element => ({ label: ownText(element), selector: selectorFor(element) }));
  const nextPage = [...document.querySelectorAll('button,a,[role="button"],li')]
    .find(element => element.closest('.user_part') && ownText(element) === '下一页');
  const previousPage = [...document.querySelectorAll('button,a,[role="button"],li')]
    .find(element => element.closest('.user_part') && ownText(element) === '上一页');
  const firstPage = document.querySelector('.user_part .weui-desktop-pagination__num');
  const pagination = nextPage ? {
    selector: selectorFor(nextPage), disabled: nextPage.classList.contains('disabled') || nextPage.getAttribute('aria-disabled') === 'true',
    previousSelector: previousPage ? selectorFor(previousPage) : '',
    previousDisabled: !previousPage || previousPage.classList.contains('disabled') || previousPage.getAttribute('aria-disabled') === 'true',
    firstSelector: firstPage ? selectorFor(firstPage) : '',
    firstCurrent: Boolean(firstPage?.classList.contains('weui-desktop-pagination__num_current')),
  } : null;
  return { leaves, tables, charts, highchartsAriaCharts, controls, pagination };
})()`;

function runtimeToAnalysis(runtime) {
  if (!runtime || typeof runtime !== 'object') return {};
  const result = {};
  const metrics = normalizeVisibleMetrics(runtime.leaves);
  if (metrics.length > 0) result['可见指标'] = metrics;
  if (Array.isArray(runtime.tables)) for (const item of runtime.tables) {
    if (item?.name && Array.isArray(item.data)) result[`表格：${item.name}`] = item.data;
  }
  Object.assign(result, normalizeEchartsOptions(runtime.charts));
  Object.assign(result, normalizeHighchartsAriaCharts(runtime.highchartsAriaCharts));
  return result;
}

function runtimeScopeToAnalysis(runtime, section) {
  const result = {};
  for (const item of runtime?.tables ?? []) {
    if (item?.section === section && item.name && Array.isArray(item.data)) result[`表格：${item.name}`] = item.data;
  }
  Object.assign(result, normalizeHighchartsAriaCharts((runtime?.highchartsAriaCharts ?? []).filter(item => item?.section === section)));
  return result;
}

function publishedRuntimeToAnalysis(runtime) {
  const sections = ['阅读分析', '转化分析', '分享分析', '用户画像'];
  const result = { '图一总的数据': {} };
  const metrics = normalizeVisibleMetrics(runtime?.leaves);
  if (metrics.length > 0) result['图一总的数据']['可见指标'] = metrics;
  for (const section of sections) result[section] = runtimeScopeToAnalysis(runtime, section);
  if (result['转化分析']['分享扩散分析']) {
    result['分享分析']['分享扩散分析'] = result['转化分析']['分享扩散分析'];
    delete result['转化分析']['分享扩散分析'];
  }
  return result;
}

function multimediaRuntimeToAnalysis(runtime, kind) {
  const result = { '昨日关键数据': {} };
  const metrics = normalizeVisibleMetrics(runtime?.leaves);
  if (metrics.length > 0) result['昨日关键数据']['可见指标'] = metrics;
  const tables = runtime?.tables ?? [];
  if (kind === '视频') {
    const yesterday = tables.find(item => Object.keys(item?.data?.[0] ?? {}).includes('视频标题'));
    if (yesterday) result['昨日有播放的视频'] = { [`表格：${yesterday.name}`]: yesterday.data };
    const details = runtimeToAnalysis({ ...runtime, tables: tables.filter(item => item.videoDetail), leaves: [] });
    if (details['数据明细分析']) {
      details['渠道构成'] = details['数据明细分析'];
      delete details['数据明细分析'];
    }
    if (Object.keys(details).length > 0) result['数据明细分析'] = details;
  } else {
    result['收听分析'] = runtimeToAnalysis({ ...runtime, leaves: [] });
  }
  return result;
}

function trustedVideoAnalysisLink(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname === DOMAIN && url.port === ''
      && url.pathname === '/misc/videoanalysis' && url.searchParams.get('action') === 'stat_all_video_page';
  } catch { return false; }
}

function trustedAudioAnalysisLink(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname === DOMAIN && url.port === ''
      && url.pathname === '/misc/audioanalysis' && url.searchParams.get('action') === 'audio_list_page';
  } catch { return false; }
}

async function collectPeriodAnalysis(page) {
  const initialRuntime = await page.evaluate(RUNTIME_ANALYSIS_JS);
  const periods = {};
  const controls = new Map((initialRuntime?.controls ?? []).map(item => [item.label, item.selector]));
  for (const label of ['发表后7天', '发表后30天']) {
    const selector = controls.get(label);
    if (selector && typeof page.click === 'function') {
      await page.click(selector).catch(() => {});
      await page.wait?.(350);
    }
    let runtime = label === '发表后7天' && !selector ? initialRuntime : await page.evaluate(RUNTIME_ANALYSIS_JS);
    if (runtime.pagination?.firstSelector) {
      await page.click('.user_part .weui-desktop-pagination__num__wrp .weui-desktop-pagination__num:nth-of-type(1)');
      await page.wait?.(350);
      runtime = await page.evaluate(RUNTIME_ANALYSIS_JS);
    }
    const profilePages = [runtime.tables.filter(item => item.section === '用户画像')];
    const signatures = new Set(profilePages[0].map(item => JSON.stringify(item.data)));
    for (let pageIndex = 0; pageIndex < 20 && runtime.pagination && !runtime.pagination.disabled; pageIndex += 1) {
      await page.click(runtime.pagination.selector).catch(() => {});
      await page.wait?.(350);
      const nextRuntime = await page.evaluate(RUNTIME_ANALYSIS_JS);
      const nextTables = nextRuntime.tables.filter(item => item.section === '用户画像');
      const signature = nextTables.map(item => JSON.stringify(item.data)).join('\u0000');
      if (signatures.has(signature)) break;
      signatures.add(signature);
      profilePages.push(nextTables);
      runtime = nextRuntime;
    }
    runtime = {
      ...runtime,
      tables: [...runtime.tables.filter(item => item.section !== '用户画像'), ...mergePaginatedTables(profilePages)],
    };
    const analysis = publishedRuntimeToAnalysis(runtime);
    if (Object.keys(analysis).length > 0) periods[label] = analysis;
  }
  if (Object.keys(periods).length === 0) periods['当前可见数据'] = publishedRuntimeToAnalysis(initialRuntime);
  const result = { '已发表内容-已通知内容': { '图一总的数据': publishedRuntimeToAnalysis(initialRuntime)['图一总的数据'] } };
  for (const section of ['阅读分析', '转化分析', '分享分析']) {
    const values = Object.fromEntries(Object.entries(periods)
      .map(([period, analysis]) => [period, analysis[section] ?? {}]));
    if (Object.keys(values).length > 0) result['已发表内容-已通知内容'][section] = values;
  }
  const userProfile = Object.values(periods).map(analysis => analysis['用户画像']).find(analysis => analysis && Object.keys(analysis).length > 0);
  if (userProfile) result['已发表内容-已通知内容']['用户画像'] = userProfile;
  return result;
}

function safeFilename(title) {
  const name = basename(String(title)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'weixin-publish-analysis';
  return `${name}.md`;
}

async function publishMarkdown(outputDir, filename, content) {
  await mkdir(outputDir, { recursive: true });
  const temporary = resolve(outputDir, `.bycli-publish-analysis-${randomUUID()}.tmp`);
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  try {
    const extension = '.md';
    const stem = filename.slice(0, -extension.length);
    for (let index = 0; index <= 9999; index += 1) {
      const path = resolve(outputDir, index === 0 ? filename : `${stem}-${index}${extension}`);
      try { await link(temporary, path); return path; } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    throw new CommandExecutionError('WeChat publish analysis could not allocate a report filename');
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function collectPublishAnalysis(page, { detailUrl, title, publishedAt, outputDir }) {
  if (typeof page?.goto !== 'function' || typeof page?.readNetworkCapture !== 'function') {
    throw new CommandExecutionError('WeChat publish analysis requires browser network capture support');
  }
  const captureStarted = await page.startNetworkCapture?.('mp.weixin.qq.com');
  if (captureStarted === false) throw new CommandExecutionError('WeChat publish analysis requires supported browser network capture');
  await page.goto(detailUrl);
  await page.wait?.(1000);
  const metrics = await collectArticleMetrics(page);
  const capturedEntries = await page.readNetworkCapture();
  const payloads = extractAnalysisPayloads(capturedEntries);
  let data = Object.fromEntries(payloads.map(({ name, data: value }, index) => [index === 0 ? name : `${name}-${index + 1}`, value]));
  if (metrics) Object.assign(data, articleMetricsSections(metrics));
  if (typeof page.evaluate === 'function') {
    Object.assign(data, await collectPeriodAnalysis(page));
    const videoUrl = await page.evaluate(`(() => [...document.querySelectorAll('a[href]')]
      .find(link => String(link.textContent || '').trim() === '视频数据')?.href || '')()`);
    if (trustedVideoAnalysisLink(videoUrl)) {
      await page.goto(videoUrl);
      await page.wait?.(1000);
      const videoRuntime = await page.evaluate(RUNTIME_ANALYSIS_JS);
      const videoAnalysis = multimediaRuntimeToAnalysis(videoRuntime, '视频');
      if (Object.keys(videoAnalysis).length > 0) data['多媒体'] = { 视频: videoAnalysis };
      const audioUrl = await page.evaluate(`(() => [...document.querySelectorAll('a[href]')]
        .find(link => String(link.textContent || '').trim() === '音频')?.href || '')()`);
      if (trustedAudioAnalysisLink(audioUrl)) {
        await page.goto(audioUrl);
        await page.wait?.(1000);
        const audioAnalysis = multimediaRuntimeToAnalysis(await page.evaluate(RUNTIME_ANALYSIS_JS), '音频');
        if (Object.keys(audioAnalysis).length > 0) {
          data['多媒体'] ??= {};
          data['多媒体'].音频 = audioAnalysis;
        }
      }
    }
  }
  if (Object.keys(data).length === 0) throw new CommandExecutionError('WeChat publish analysis returned no readable analysis data');
  const content = formatAnalysisMarkdown({ title, publishedAt, data });
  const path = await publishMarkdown(resolve(outputDir), safeFilename(title), content);
  const info = await stat(path);
  return { status: 'saved', path, size: info.size, metrics };
}
