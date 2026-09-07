import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const IMA_RESOURCE_HOSTS = new Set(['res-skb.ima.qq.com']);

export function validateImaOriginUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('IMA originUrl is not a valid URL'); }
  if (url.protocol !== 'https:' || !IMA_RESOURCE_HOSTS.has(url.hostname)) {
    throw new Error(`IMA resource URL is not allowed: ${url.hostname}`);
  }
  return url.toString();
}

export function extractOriginUrl(viewerUrl) {
  let url;
  try { url = new URL(String(viewerUrl)); } catch { throw new Error('viewer URL is invalid'); }
  const origin = url.searchParams.get('originUrl');
  if (!origin) throw new Error('viewer URL does not contain originUrl');
  return validateImaOriginUrl(origin);
}

export function resolveOutputPath(output, title) {
  const target = String(output || '.');
  if (path.extname(target)) return target;
  return path.join(target, path.basename(String(title || 'ima-download')));
}

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
