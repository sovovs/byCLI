import { ArgumentError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';

const DOMAIN = 'mp.weixin.qq.com';
const ENDPOINT = `https://${DOMAIN}/misc/useranalysis`;

const SOURCE_ENTRIES = [
  ['all', 99999999],
  ['search', 1],
  ['qr', 30],
  ['article', 57],
  ['card', 17],
  ['mini-program', 149],
  ['reprint', 161],
  ['ad', 100],
  ['channels-live', 201],
  ['channels', 200],
  ['other', 0],
];

const SOURCE_CODES = new Map(SOURCE_ENTRIES);
const SOURCE_NAMES = new Map(SOURCE_ENTRIES.map(([name, code]) => [code, name]));
const DIMENSIONS = ['gender', 'age', 'language', 'region', 'platform', 'brand'];

function argument(condition, message) {
  if (!condition) throw new ArgumentError(message);
}

function execution(condition, message) {
  if (!condition) throw new CommandExecutionError(message);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function calendarDate(value, name) {
  argument(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), `${name} must use YYYY-MM-DD`);
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  argument(
    parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day,
    `${name} must be a valid calendar date`,
  );
  return value;
}

function yesterday(now) {
  const date = new Date(now());
  argument(Number.isFinite(date.getTime()), 'current time must be valid');
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - 1);
  return date;
}

export function resolveGrowthRange(args = {}, options = {}) {
  const now = options.now ?? Date.now;
  const defaultEnd = yesterday(now);
  const end = calendarDate(args.end ?? formatLocalDate(defaultEnd), 'end');
  const [endYear, endMonth, endDay] = end.split('-').map(Number);
  const defaultBegin = new Date(endYear, endMonth - 1, endDay, 12);
  defaultBegin.setDate(defaultBegin.getDate() - 29);
  const begin = calendarDate(args.begin ?? formatLocalDate(defaultBegin), 'begin');
  argument(begin <= end, 'begin must not be after end');
  return { begin, end };
}

export function resolveAttributeDate(value, options = {}) {
  const now = options.now ?? Date.now;
  return calendarDate(value ?? formatLocalDate(yesterday(now)), 'date');
}

export function parseGrowthSources(value = 'all') {
  if (String(value).trim() === 'all-sources') {
    return SOURCE_ENTRIES.map(([name, code]) => ({ name, code }));
  }
  const rawItems = String(value).split(',').map(item => item.trim()).filter(Boolean);
  argument(rawItems.length > 0, 'source must not be empty');
  const seen = new Set();
  return rawItems.map(raw => {
    let code;
    if (SOURCE_CODES.has(raw)) {
      code = SOURCE_CODES.get(raw);
    } else if (/^\d+$/.test(raw)) {
      code = Number(raw);
      argument(Number.isSafeInteger(code), `source code is too large: ${raw}`);
    } else {
      throw new ArgumentError(`unknown source: ${raw}`);
    }
    argument(!seen.has(code), `duplicate source: ${raw}`);
    seen.add(code);
    return { code, name: SOURCE_NAMES.get(code) ?? `source:${code}` };
  });
}

export function parseAttributeDimension(value = 'all') {
  const dimension = String(value).trim();
  argument(dimension === 'all' || DIMENSIONS.includes(dimension),
    `dimension must be one of: all, ${DIMENSIONS.join(', ')}`);
  return dimension;
}

function tokenValue(token) {
  argument(typeof token === 'string' && token.trim().length > 0, 'token is required');
  return token;
}

export function buildGrowthUrl({ token, begin, end, sourceCodes }) {
  argument(Array.isArray(sourceCodes) && sourceCodes.length > 0, 'sourceCodes must not be empty');
  sourceCodes.forEach(code => argument(Number.isSafeInteger(code) && code >= 0, 'sourceCodes must contain non-negative safe integers'));
  const params = new URLSearchParams({
    begin_date: calendarDate(begin, 'begin'),
    end_date: calendarDate(end, 'end'),
    source: sourceCodes.join(','),
    token: tokenValue(token),
    lang: 'zh_CN',
    f: 'json',
    ajax: '1',
  });
  return `${ENDPOINT}?${params}`;
}

export function buildAttributesUrl({ token, date }) {
  const validDate = calendarDate(date, 'date');
  const params = new URLSearchParams({
    action: 'attr',
    begin_date: validDate,
    end_date: validDate,
    token: tokenValue(token),
    lang: 'zh_CN',
  });
  return `${ENDPOINT}?${params}`;
}

function integer(value, message, { nonnegative = false } = {}) {
  execution(Number.isSafeInteger(value) && (!nonnegative || value >= 0), message);
  return value;
}

function response(payload, label) {
  execution(object(payload), `WeChat ${label} returned an unreadable response`);
  execution(payload.base_resp?.ret === 0,
    `WeChat ${label} failed (ret=${String(payload.base_resp?.ret ?? 'unknown')})`);
  return payload;
}

export function normalizeGrowthPayload(payload, requestedSources) {
  const data = response(payload, 'user growth');
  execution(Array.isArray(data.category_list), 'WeChat user growth returned an invalid category list');
  const requestedOrder = new Map(requestedSources.map((source, index) => [source.code, index]));
  const requestedNames = new Map(requestedSources.map(source => [source.code, source.name]));
  const rows = [];
  for (const [categoryIndex, category] of data.category_list.entries()) {
    execution(object(category), `WeChat user growth returned an invalid category at index ${categoryIndex}`);
    const sourceCode = integer(category.user_source, `WeChat user growth returned an invalid source at index ${categoryIndex}`, { nonnegative: true });
    execution(Array.isArray(category.list), `WeChat user growth returned an invalid list for source ${sourceCode}`);
    for (const [rowIndex, item] of category.list.entries()) {
      const prefix = `WeChat user growth returned an invalid row at source ${sourceCode} index ${rowIndex}`;
      execution(object(item), prefix);
      const date = typeof item.date === 'string' ? item.date : '';
      try {
        calendarDate(date, 'date');
      } catch {
        throw new CommandExecutionError(prefix);
      }
      rows.push({
        date,
        source: requestedNames.get(sourceCode) ?? SOURCE_NAMES.get(sourceCode) ?? `source:${sourceCode}`,
        sourceCode,
        newFollowers: integer(item.new_user, prefix, { nonnegative: true }),
        unfollows: integer(item.cancel_user, prefix, { nonnegative: true }),
        netNewFollowers: integer(item.netgain_user, prefix),
        cumulativeFollowers: integer(item.cumulate_user, prefix, { nonnegative: true }),
      });
    }
  }
  return rows.sort((left, right) => left.date.localeCompare(right.date)
    || (requestedOrder.get(left.sourceCode) ?? Number.MAX_SAFE_INTEGER)
      - (requestedOrder.get(right.sourceCode) ?? Number.MAX_SAFE_INTEGER));
}

function percentage(count, total) {
  if (total === 0) return 0;
  return Number(((count * 100) / total).toFixed(2));
}

function displayName(value) {
  if (value === '' || value === '0' || value === null || value === undefined) return '未知';
  execution(typeof value === 'string', 'WeChat user attributes returned an invalid name');
  return value;
}

function flatDimension(snapshot, dimension, field) {
  const items = snapshot[field] ?? [];
  execution(Array.isArray(items), `WeChat user attributes returned an invalid ${dimension} list`);
  const total = items.reduce((sum, item) => {
    execution(object(item), `WeChat user attributes returned an invalid ${dimension} row`);
    return sum + integer(item.count, `WeChat user attributes returned an invalid ${dimension} count`, { nonnegative: true });
  }, 0);
  return items.map(item => ({
    date: snapshot.date,
    dimension,
    name: displayName(item.name),
    code: null,
    parentCode: null,
    count: item.count,
    percent: percentage(item.count, total),
  }));
}

function flatRegions(snapshot) {
  const items = snapshot.regions ?? [];
  execution(Array.isArray(items), 'WeChat user attributes returned an invalid region list');
  return items.map(item => {
    execution(object(item) && object(item.region), 'WeChat user attributes returned an invalid region row');
    const code = item.region.region_id;
    const parentCode = item.region.parent_region_id;
    execution(typeof code === 'string' && typeof parentCode === 'string', 'WeChat user attributes returned invalid region identifiers');
    return {
      date: snapshot.date,
      dimension: 'region',
      name: displayName(item.region.region_name),
      code,
      parentCode,
      count: integer(item.count, 'WeChat user attributes returned an invalid region count', { nonnegative: true }),
      percent: null,
    };
  });
}

export function normalizeAttributeSnapshot(snapshot, dimension = 'all') {
  execution(object(snapshot), 'WeChat user attributes returned an unreadable snapshot');
  try {
    calendarDate(snapshot.date, 'date');
  } catch {
    throw new CommandExecutionError('WeChat user attributes returned an invalid snapshot date');
  }
  const selected = parseAttributeDimension(dimension);
  const builders = {
    gender: () => flatDimension(snapshot, 'gender', 'genders'),
    age: () => flatDimension(snapshot, 'age', 'ages'),
    language: () => flatDimension(snapshot, 'language', 'langs'),
    region: () => flatRegions(snapshot),
    platform: () => flatDimension(snapshot, 'platform', 'platforms'),
    brand: () => flatDimension(snapshot, 'brand', 'devices'),
  };
  const dimensions = selected === 'all' ? DIMENSIONS : [selected];
  return dimensions.flatMap(key => builders[key]());
}

export async function collectGrowth({ page, token, begin, end, sources }) {
  const requestUrl = buildGrowthUrl({ token, begin, end, sourceCodes: sources.map(source => source.code) });
  const landing = new URL(ENDPOINT);
  landing.searchParams.set('token', tokenValue(token));
  landing.searchParams.set('lang', 'zh_CN');
  let payload;
  try {
    await page.goto(landing.toString());
    await page.wait(1);
    payload = await page.evaluate(async url => {
      const result = await fetch(url, { credentials: 'include' });
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      return result.json();
    }, requestUrl);
  } catch {
    throw new CommandExecutionError('Unable to read WeChat user growth from the authenticated browser session');
  }
  return normalizeGrowthPayload(payload, sources);
}

export async function collectAttributes({ page, token, date, dimension }) {
  let snapshot;
  try {
    await page.goto(buildAttributesUrl({ token, date }));
    await page.wait(1);
    snapshot = await page.evaluate(() => window.cgiData?.list?.[0] ?? null);
  } catch {
    throw new CommandExecutionError('Unable to read WeChat user attributes from the authenticated browser session');
  }
  if (snapshot === null) {
    throw new EmptyResultError(
      'weixin user-attributes',
      'No attribute snapshot is available. WeChat publishes it the day after the account reaches 100 followers.',
    );
  }
  const rows = normalizeAttributeSnapshot(snapshot, dimension);
  if (rows.length === 0) {
    throw new EmptyResultError('weixin user-attributes', `No ${dimension} attribute rows are available for ${date}.`);
  }
  return rows;
}
