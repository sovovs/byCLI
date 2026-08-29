import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArgumentError } from '@sovovs/bycli/errors';
import { createPinnedDispatcher } from '@sovovs/bycli/node-network';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 5;
const CLOUD_METADATA_HOSTS = new Set([
  'instance-data.ec2.internal',
  'metadata.google.internal',
  'metadata.goog',
]);
const CLOUD_METADATA_ADDRESSES = new Set([
  '100.100.100.200',
  '169.254.169.254',
  '169.254.170.2',
  '169.254.170.23',
  'fd00:ec2::254',
  'fd00:ec2::23',
]);
const IMAGE_FORMATS = new Map([
  ['image/jpeg', { extension: '.jpg', matches: bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff }],
  ['image/png', { extension: '.png', matches: bytes => isPng(bytes) }],
  ['image/gif', { extension: '.gif', matches: bytes => {
    const header = String.fromCharCode(...bytes.slice(0, 6));
    return header === 'GIF87a' || header === 'GIF89a';
  } }],
  ['image/webp', { extension: '.webp', matches: bytes => {
    const riff = String.fromCharCode(...bytes.slice(0, 4));
    const webp = String.fromCharCode(...bytes.slice(8, 12));
    return riff === 'RIFF' && webp === 'WEBP';
  } }],
]);

function isPng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((value, index) => bytes[index] === value);
}

function normalizeHostname(value) {
  return String(value || '').replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
}

function parseIpv4(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/u.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.some(value => value > 255) ? null : numbers;
}

function isPrivateIpv4(address) {
  const parts = parseIpv4(address);
  if (!parts) return false;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function parseIpv6Groups(address) {
  let normalized = normalizeHostname(address).split('%')[0];
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const ipv4 = parseIpv4(normalized.slice(lastColon + 1));
    if (!ipv4) return null;
    normalized = `${normalized.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseHalf = half => half
    ? half.split(':').map(part => (/^[0-9a-f]{1,4}$/u.test(part) ? Number.parseInt(part, 16) : NaN))
    : [];
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? '');
  if ([...left, ...right].some(Number.isNaN)) return null;
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || omitted < 0) return null;
  return [...left, ...Array.from({ length: omitted }, () => 0), ...right];
}

function mappedIpv4Address(address) {
  const groups = parseIpv6Groups(address);
  if (!groups || groups.length !== 8) return null;
  if (!groups.slice(0, 5).every(group => group === 0) || groups[5] !== 0xffff) return null;
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
}

function translatedIpv4Address(address) {
  const groups = parseIpv6Groups(address);
  if (!groups || groups.length !== 8) return null;
  const isWellKnownNat64 = groups[0] === 0x0064
    && groups[1] === 0xff9b
    && groups.slice(2, 6).every(group => group === 0);
  const isSixToFour = groups[0] === 0x2002;
  if (!isWellKnownNat64 && !isSixToFour) return null;
  const high = isSixToFour ? groups[1] : groups[6];
  const low = isSixToFour ? groups[2] : groups[7];
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function isPrivateIpv6(address) {
  const normalized = normalizeHostname(address).split('%')[0];
  const mappedIpv4 = mappedIpv4Address(normalized);
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
  const translatedIpv4 = translatedIpv4Address(normalized);
  if (translatedIpv4 && isPrivateIpv4(translatedIpv4)) return true;
  const groups = parseIpv6Groups(normalized);
  if (!groups) return true;
  const [a, b, c, d] = groups;
  const protocolAssignments = a === 0x2001 && b <= 0x01ff;
  const globallyReachableProtocolAssignment = (b === 0x0001
      && groups.slice(2, 7).every(group => group === 0)
      && [1, 2, 3].includes(groups[7]))
    || b === 0x0003
    || (b === 0x0004 && c === 0x0112)
    || (b & 0xfff0) === 0x0020
    || (b & 0xfff0) === 0x0030;
  return groups.slice(0, 6).every(group => group === 0)
    || (a & 0xfe00) === 0xfc00
    || (a & 0xffc0) === 0xfe80
    || (a & 0xffc0) === 0xfec0
    || (a & 0xff00) === 0xff00
    || (a === 0x0064 && b === 0xff9b && c === 0x0001)
    || (a === 0x0100 && b === 0 && c === 0 && (d === 0 || d === 1))
    || (protocolAssignments && !globallyReachableProtocolAssignment)
    || (a === 0x2001 && b === 0x0db8)
    || a === 0x2002
    || (a === 0x3fff && (b & 0xf000) === 0)
    || a === 0x5f00;
}

function isPrivateAddress(address) {
  const normalized = normalizeHostname(address);
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) === 6) return isPrivateIpv6(normalized);
  return false;
}

function isCloudMetadataAddress(address) {
  const normalized = normalizeHostname(address);
  const mappedIpv4 = mappedIpv4Address(normalized);
  const translatedIpv4 = translatedIpv4Address(normalized);
  return CLOUD_METADATA_ADDRESSES.has(normalized)
    || Boolean(mappedIpv4 && CLOUD_METADATA_ADDRESSES.has(mappedIpv4))
    || Boolean(translatedIpv4 && CLOUD_METADATA_ADDRESSES.has(translatedIpv4));
}

async function defaultLookup(hostname) {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function remainingTime(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ArgumentError('Remote image download timed out');
  return remaining;
}

async function lookupBeforeDeadline(lookupImpl, hostname, deadline) {
  const remaining = remainingTime(deadline);
  let timer;
  try {
    return await Promise.race([
      lookupImpl(hostname),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ArgumentError('Remote image download timed out')), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function assertAllowedTarget(url, { allowPrivateHosts, lookupImpl, deadline }) {
  const hostname = normalizeHostname(url.hostname);
  if (CLOUD_METADATA_HOSTS.has(hostname) || isCloudMetadataAddress(hostname)) {
    throw new ArgumentError('Cloud metadata addresses are not allowed');
  }
  let addresses;
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    addresses = [{ address: '127.0.0.1', family: 4 }];
  } else {
    try {
      addresses = await lookupBeforeDeadline(lookupImpl, hostname, deadline);
    } catch (error) {
      if (error instanceof ArgumentError && error.message.includes('timed out')) throw error;
      throw new ArgumentError(`Remote image host lookup failed: ${error?.message ?? error}`);
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new ArgumentError('Remote image host did not resolve to an address');
  }
  if (addresses.some(item => !item || !isIP(normalizeHostname(item.address)))) {
    throw new ArgumentError('Remote image host resolved to an invalid address');
  }
  if (addresses.some(item => isCloudMetadataAddress(item.address))) {
    throw new ArgumentError('Cloud metadata addresses are not allowed');
  }
  if (!allowPrivateHosts && addresses.some(item => isPrivateAddress(item.address))) {
    throw new ArgumentError('Private remote image hosts require --allow-private-image-hosts true');
  }
  return addresses.map(item => ({ address: normalizeHostname(item.address), family: isIP(normalizeHostname(item.address)) }));
}

async function startTimedFetch(fetchImpl, url, timeoutMs, addresses) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const dispatcher = createPinnedDispatcher(addresses);
  try {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: controller.signal,
      dispatcher,
    });
    let disposed = false;
    return {
      response,
      signal: controller.signal,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        await dispatcher.close();
      },
    };
  } catch (error) {
    clearTimeout(timer);
    await dispatcher.close();
    if (controller.signal.aborted) throw new ArgumentError('Remote image download timed out');
    throw new ArgumentError(`Remote image download failed: ${error?.message ?? error}`);
  }
}

async function readWithAbort(reader, signal) {
  if (signal.aborted) throw new ArgumentError('Remote image download timed out');
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new ArgumentError('Remote image download timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function readBoundedBody(response, maxBytes, signal) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new ArgumentError('Remote image response body was empty');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      size += chunk.byteLength;
      if (size > maxBytes) {
        throw new ArgumentError(`Remote image exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function downloadRemoteImage(sourceUrl, {
  allowPrivateHosts = false,
  fetchImpl = globalThis.fetch,
  lookupImpl = defaultLookup,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  mkdtempImpl = mkdtemp,
  writeFileImpl = writeFile,
  rmImpl = rm,
} = {}) {
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new ArgumentError(`Invalid remote image URL: ${sourceUrl}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ArgumentError(`Unsupported remote image protocol: ${url.protocol}`);
  }
  const deadline = Date.now() + timeoutMs;
  let timedFetch;
  for (let redirects = 0; ; redirects += 1) {
    const addresses = await assertAllowedTarget(url, {
      allowPrivateHosts,
      lookupImpl,
      deadline,
    });
    timedFetch = await startTimedFetch(fetchImpl, url.href, remainingTime(deadline), addresses);
    const { response } = timedFetch;
    if (response.status < 300 || response.status >= 400) break;
    await response.body?.cancel().catch(() => {});
    await timedFetch.dispose();
    if (redirects >= maxRedirects) throw new ArgumentError(`Remote image exceeded ${maxRedirects} redirects`);
    const location = response.headers.get('location');
    if (!location) throw new ArgumentError('Remote image redirect was missing a destination');
    try {
      url = new URL(location, url);
    } catch {
      throw new ArgumentError('Remote image redirect destination was invalid');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new ArgumentError(`Unsupported remote image protocol: ${url.protocol}`);
    }
  }
  try {
    const { response, signal } = timedFetch;
    if (!response.ok) throw new ArgumentError(`Remote image download failed: HTTP ${response.status}`);
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const format = IMAGE_FORMATS.get(contentType === 'image/jpg' ? 'image/jpeg' : contentType);
    if (!format) throw new ArgumentError(`Unsupported remote image content type: ${contentType || 'missing'}`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new ArgumentError(`Remote image exceeds ${maxBytes} bytes`);
    }
    const bytes = await readBoundedBody(response, maxBytes, signal);
    if (!format.matches(bytes)) throw new ArgumentError(`Remote image content does not match ${contentType}`);
    const directory = await mkdtempImpl(join(tmpdir(), 'bycli-weixin-image-'));
    const path = join(directory, `image${format.extension}`);
    try {
      await writeFileImpl(path, bytes, { mode: 0o600 });
      return {
        path,
        extension: format.extension,
        size: bytes.byteLength,
        resolvedUrl: url.href,
        cleanup: () => rmImpl(directory, { recursive: true, force: true }),
      };
    } catch (error) {
      await rmImpl(directory, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    await timedFetch.response.body?.cancel().catch(() => {});
    throw error;
  } finally {
    await timedFetch.dispose();
  }
}
