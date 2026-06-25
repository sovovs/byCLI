/**
 * Navigation URL policy — EXTENSION (service-worker) MIRROR, syntax-only.
 *
 * This mirrors the syntax layer of src/browser/url-policy.ts but is RUNTIME-AGNOSTIC:
 * it has no `node:net` / `node:dns` imports (the MV3 service worker has neither), so
 * it ships a self-contained IPv4/IPv6 classifier instead of node's isIP.
 *
 * It deliberately does NOT do DNS resolution. The extension capture form is therefore
 * `ip-observed-only` per ADR-0006: it can reject forbidden protocols, userinfo, and
 * literal-IP hosts (every encoding), and it re-checks every redirected main-frame
 * request before send — but it cannot prove the connection IP of a domain host.
 * DNS-rebinding closure requires the controlled local policy proxy (strict-ip-enforced).
 *
 * KEEP IN SYNC with src/browser/url-policy.ts (same reason codes, same ranges). The
 * two cannot share a file because the extension build is isolated (rootDir: src).
 */

export type UrlPolicyReason =
  | 'forbidden_protocol'
  | 'userinfo_present'
  | 'empty_host'
  | 'literal_ip_host'
  | 'forbidden_ip';

export interface UrlPolicyOk {
  ok: true;
  url: string;
  hostname: string;
  isIpLiteral: boolean;
}
export interface UrlPolicyReject {
  ok: false;
  reason: UrlPolicyReason;
  detail: string;
}
export type UrlPolicyResult = UrlPolicyOk | UrlPolicyReject;

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Self-contained IP classifier (replaces node:net isIP). Returns 4, 6, or 0. */
function classifyIp(s: string): 0 | 4 | 6 {
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s)) {
    if (s.split('.').every((o) => Number(o) <= 255)) return 4;
  }
  // IPv6: hex groups with optional :: and optional embedded IPv4 tail.
  if (s.includes(':') && /^[0-9a-fA-F:.]+$/.test(s) && ipv6Groups(s) !== null) return 6;
  return 0;
}

export function parseIpv4Loose(host: string): string | null {
  if (host.length === 0) return null;
  const parts = host.split('.');
  if (parts.length > 4) return null;
  if (parts.some((p) => p.length === 0)) return null;

  const numbers: number[] = [];
  for (const part of parts) {
    const n = parseRadixPart(part);
    if (n === null) return null;
    numbers.push(n);
  }
  for (let i = 0; i < numbers.length - 1; i++) {
    if (numbers[i] > 255) return null;
  }
  const last = numbers[numbers.length - 1];
  const maxLast = 256 ** (5 - numbers.length);
  if (last >= maxLast) return null;

  let ipv4 = last;
  for (let i = 0; i < numbers.length - 1; i++) ipv4 += numbers[i] * 256 ** (3 - i);
  if (ipv4 > 0xffffffff) return null;

  return [(ipv4 >>> 24) & 0xff, (ipv4 >>> 16) & 0xff, (ipv4 >>> 8) & 0xff, ipv4 & 0xff].join('.');
}

function parseRadixPart(part: string): number | null {
  let radix = 10;
  let digits = part;
  if (/^0[xX]/.test(part)) {
    radix = 16; digits = part.slice(2);
    if (digits.length === 0 || !/^[0-9a-fA-F]+$/.test(digits)) return null;
  } else if (part.length > 1 && part[0] === '0') {
    radix = 8; digits = part.slice(1);
    if (!/^[0-7]+$/.test(digits)) return null;
  } else if (!/^[0-9]+$/.test(part)) {
    return null;
  }
  const n = parseInt(digits, radix);
  return Number.isNaN(n) ? null : n;
}

export function asIpLiteral(host: string): string | null {
  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const v = classifyIp(unbracketed);
  if (v === 4 || v === 6) return unbracketed;
  return parseIpv4Loose(host);
}

const FORBIDDEN_IPV4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map((x) => parseInt(x, 10));
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
function ipv4InForbiddenRange(ip: string): boolean {
  const addr = ipv4ToInt(ip);
  for (const [net, bits] of FORBIDDEN_IPV4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((addr & mask) === (ipv4ToInt(net) & mask)) return true;
  }
  return false;
}

function ipv6Groups(ip: string): number[] | null {
  let addr = ip;
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (classifyIp(tail) !== 4) return null;
    const v4 = ipv4ToInt(tail);
    addr = addr.slice(0, lastColon + 1) + ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16);
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0].length ? halves[0].split(':') : [];
  const back = halves.length === 2 ? (halves[1].length ? halves[1].split(':') : []) : null;
  const parse = (groups: string[]): number[] | null => {
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const headNums = parse(head);
  if (headNums === null) return null;
  if (back === null) return headNums.length === 8 ? headNums : null;
  const backNums = parse(back);
  if (backNums === null) return null;
  const fill = 8 - headNums.length - backNums.length;
  if (fill < 0) return null;
  return [...headNums, ...new Array(fill).fill(0), ...backNums];
}

function ipv6InForbiddenRange(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return false;
  if (g.every((x) => x === 0)) return true;                                   // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;         // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {              // ::ffff:0:0/96
    const v4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
    return ipv4InForbiddenRange(v4);
  }
  const first = g[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8
  return false;
}

export function isForbiddenIp(ip: string): boolean {
  const v = classifyIp(ip);
  if (v === 4) return ipv4InForbiddenRange(ip);
  if (v === 6) return ipv6InForbiddenRange(ip);
  const canon = parseIpv4Loose(ip);
  return canon ? ipv4InForbiddenRange(canon) : false;
}

/**
 * Syntax-only navigation policy. No DNS. Navigation targets must be domain names
 * (literal IP hosts are rejected unless allowLiteralIp) and must not be forbidden.
 */
export function checkUrlSyntax(
  input: string,
  opts: { allowLiteralIp?: boolean } = {},
): UrlPolicyResult {
  let parsed: URL;
  try { parsed = new URL(input); } catch {
    return { ok: false, reason: 'empty_host', detail: 'unparseable URL' };
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: 'forbidden_protocol', detail: `protocol ${parsed.protocol} not allowed` };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'userinfo_present', detail: 'userinfo (user:pass@) not allowed' };
  }
  let hostname = parsed.hostname;
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  if (hostname === '') return { ok: false, reason: 'empty_host', detail: 'empty host' };

  const ipLiteral = asIpLiteral(hostname);
  if (ipLiteral !== null) {
    if (isForbiddenIp(ipLiteral)) {
      return { ok: false, reason: 'forbidden_ip', detail: `literal IP ${ipLiteral} is forbidden` };
    }
    if (!opts.allowLiteralIp) {
      return { ok: false, reason: 'literal_ip_host', detail: `literal IP host ${ipLiteral} not allowed for navigation` };
    }
    return { ok: true, url: parsed.toString(), hostname: ipLiteral, isIpLiteral: true };
  }
  return { ok: true, url: parsed.toString(), hostname, isIpLiteral: false };
}
