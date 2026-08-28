import { createHash } from 'node:crypto';

export function hashResourceValue(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function canonicalWechatArticleIdentity(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = '';
  const host = url.hostname.toLowerCase();
  let canonical;
  if (url.pathname.startsWith('/s/')) {
    canonical = `${host}${url.pathname}`;
  } else {
    const tupleNames = ['__biz', 'mid', 'idx', 'sn'];
    const hasTuple = tupleNames.every(name => url.searchParams.has(name));
    if (url.pathname === '/s' && hasTuple) {
      canonical = `${host}/s?${tupleNames.map(name => `${name}=${url.searchParams.get(name)}`).join('&')}`;
    } else {
      const sorted = [...url.searchParams.entries()]
        .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
      const query = new URLSearchParams(sorted).toString();
      canonical = `${host}${url.pathname}${query ? `?${query}` : ''}`;
    }
  }
  return hashResourceValue(canonical);
}
