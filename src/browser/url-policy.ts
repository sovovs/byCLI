/**
 * Navigation URL policy (M1 spike).
 *
 * Pure, runtime-free validation of a navigation target against the security
 * model in dashboard-docs/system/adapter-recorder-system/04-security-model.md and
 * adr/0006-dns-rebinding-ip-enforcement.md.
 *
 * Two layers, deliberately separated:
 *   1. checkUrlSyntax(url)        — synchronous: protocol / userinfo / literal-IP /
 *                                    forbidden-host checks. No I/O.
 *   2. resolveAndCheckHost(...)   — asynchronous: resolves every A/AAAA record for a
 *                                    *domain* host and rejects if any resolved IP is
 *                                    forbidden. DNS resolver is injected for testing.
 *
 * SECURITY BOUNDARY NOTE (ADR-0006): the DNS precheck in layer 2 filters only the
 * records visible *at check time*. It does NOT prove the IP the browser actually
 * connects to (separate resolver, DNS cache, proxy, Happy Eyeballs, TTL-window
 * rebind). This TOCTOU window is not removable here. Passing this policy is
 * `ip-observed-only`, never `strict-ip-enforced`. Callers must still arm
 * before-send request interception and re-run this policy on every redirected /
 * secondary main-frame request.
 */

import { isIP } from 'node:net';

/** Why a URL was rejected. Stable codes — used by tests and error mapping. */
export type UrlPolicyReason =
  | 'forbidden_protocol'        // not http: / https:
  | 'userinfo_present'          // user:pass@host form
  | 'empty_host'                // no host at all
  | 'literal_ip_host'           // host is an IP literal (any encoding) — domains only for navigation
  | 'forbidden_ip'              // host / resolved IP falls in a forbidden range
  | 'unresolvable_host'         // DNS resolution failed
  | 'no_dns_records';           // DNS returned zero A/AAAA records

export interface UrlPolicyOk {
  ok: true;
  /** Canonicalized URL string after normalization. */
  url: string;
  /** Normalized hostname (lowercased, trailing dot stripped, IDN punycode, IPv6 canonical). */
  hostname: string;
  /** True when the host was an IP literal — only reachable when allowLiteralIp is set. */
  isIpLiteral: boolean;
}

export interface UrlPolicyReject {
  ok: false;
  reason: UrlPolicyReason;
  /** Human detail for logs/errors (never includes secrets). */
  detail: string;
  /** The raw authority (host[:port]) exactly as supplied, for input-form assertions. */
  rawAuthority?: string;
}

export type UrlPolicyResult = UrlPolicyOk | UrlPolicyReject;

/** Injected DNS resolver — node:dns/promises in production, a stub in tests. */
export interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Extract the raw authority (everything between `://` and the first `/?#`) from the
 * input string, before any URL-parser canonicalization. Used to assert on the
 * *input form* — e.g. that `http://0177.0.0.1/` was supplied as an octal literal —
 * since WHATWG URL silently rewrites those into `127.0.0.1` (P1-4).
 */
export function rawAuthorityOf(input: string): string | undefined {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(input.trim());
  if (!m) return undefined;
  // Strip userinfo for the authority-host portion but keep the host[:port].
  const authority = m[1];
  const at = authority.lastIndexOf('@');
  return at >= 0 ? authority.slice(at + 1) : authority;
}

/**
 * Decide whether a hostname (already lowercased, trailing-dot stripped) is an IP
 * literal in ANY encoding the browser would accept: dotted-decimal, IPv6 in
 * brackets, decimal/octal/hex/shorthand IPv4. Returns the canonical IP string when
 * it is a literal, or null when it is a real domain name.
 */
export function asIpLiteral(host: string): string | null {
  // IPv6 literal arrives bracketed from URL.hostname only when constructed from a
  // bracketed form; URL strips the brackets, so test the bare form too.
  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const v = isIP(unbracketed);
  if (v === 4 || v === 6) return unbracketed;

  // IPv4 alternative encodings: decimal (2130706433), octal (0177.0.0.1),
  // hex (0x7f.0.0.1), and shorthand (127.1). WHATWG URL already canonicalizes
  // most of these, but we re-derive defensively in case a caller bypasses it.
  const parsed = parseIpv4Loose(host);
  return parsed;
}

/**
 * Parse the loose IPv4 forms browsers accept (decimal, octal, hex, 1-4 dotted
 * parts with mixed radices). Returns canonical dotted-decimal, or null if not a
 * valid IPv4 literal. Mirrors the "parts" algorithm in the WHATWG URL spec.
 */
export function parseIpv4Loose(host: string): string | null {
  if (host.length === 0) return null;
  const parts = host.split('.');
  // A trailing empty part (from a trailing dot) is tolerated by the spec; reject
  // here since trailing dots are stripped before this is called.
  if (parts.length > 4) return null;
  if (parts.some((p) => p.length === 0)) return null;

  const numbers: number[] = [];
  for (const part of parts) {
    const n = parseRadixPart(part);
    if (n === null) return null;
    numbers.push(n);
  }

  // Each non-final part must fit in a byte; the final part absorbs the remaining bytes.
  for (let i = 0; i < numbers.length - 1; i++) {
    if (numbers[i] > 255) return null;
  }
  const last = numbers[numbers.length - 1];
  const maxLast = 256 ** (5 - numbers.length);
  if (last >= maxLast) return null;

  let ipv4 = last;
  for (let i = 0; i < numbers.length - 1; i++) {
    ipv4 += numbers[i] * 256 ** (3 - i);
  }
  if (ipv4 > 0xffffffff) return null;

  return [
    (ipv4 >>> 24) & 0xff,
    (ipv4 >>> 16) & 0xff,
    (ipv4 >>> 8) & 0xff,
    ipv4 & 0xff,
  ].join('.');
}

function parseRadixPart(part: string): number | null {
  let radix = 10;
  let digits = part;
  if (/^0[xX]/.test(part)) {
    radix = 16;
    digits = part.slice(2);
    if (digits.length === 0) return null;
    if (!/^[0-9a-fA-F]+$/.test(digits)) return null;
  } else if (part.length > 1 && part[0] === '0') {
    radix = 8;
    digits = part.slice(1);
    if (!/^[0-7]+$/.test(digits)) return null;
  } else {
    if (!/^[0-9]+$/.test(part)) return null;
  }
  const n = parseInt(digits, radix);
  return Number.isNaN(n) ? null : n;
}

/** IPv4 forbidden ranges as [network, prefixBits] CIDR pairs. */
const FORBIDDEN_IPV4: Array<[string, number]> = [
  ['0.0.0.0', 8],        // "this" network / unspecified
  ['10.0.0.0', 8],       // RFC1918 private
  ['100.64.0.0', 10],    // RFC6598 CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (incl. 169.254.169.254 cloud metadata)
  ['172.16.0.0', 12],    // RFC1918 private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1 documentation
  ['192.168.0.0', 16],   // RFC1918 private
  ['198.18.0.0', 15],    // RFC2544 benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2 documentation
  ['203.0.113.0', 24],   // TEST-NET-3 documentation
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved (incl. 255.255.255.255 broadcast)
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipv4InForbiddenRange(ip: string): boolean {
  const addr = ipv4ToInt(ip);
  for (const [net, bits] of FORBIDDEN_IPV4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((addr & mask) === (ipv4ToInt(net) & mask)) return true;
  }
  return false;
}

/** Expand an IPv6 address to its 8 16-bit groups (numbers), handling `::` and
 *  embedded IPv4 tails. Returns null when not a valid IPv6 literal. */
function ipv6Groups(ip: string): number[] | null {
  let addr = ip;
  // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1 or 64:ff9b::192.0.2.1).
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
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

  if (back === null) {
    return headNums.length === 8 ? headNums : null;
  }
  const backNums = parse(back);
  if (backNums === null) return null;
  const fill = 8 - headNums.length - backNums.length;
  if (fill < 0) return null;
  return [...headNums, ...new Array(fill).fill(0), ...backNums];
}

function ipv6InForbiddenRange(ip: string): boolean {
  const groups = ipv6Groups(ip);
  if (!groups) return false;

  // Unspecified ::  and loopback ::1
  if (groups.every((g) => g === 0)) return true;                       // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1

  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible — defer to the embedded v4 range check.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const v4 = `${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`;
    return ipv4InForbiddenRange(v4);
  }

  const first = groups[0];
  // fc00::/7 unique-local
  if ((first & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfe80) return true;
  // ff00::/8 multicast
  if ((first & 0xff00) === 0xff00) return true;
  // fd00:ec2::254 cloud metadata is inside fc00::/7, already covered.

  return false;
}

/** True when an IP literal (v4 or v6, any normalized form) is in a forbidden range. */
export function isForbiddenIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ipv4InForbiddenRange(ip);
  if (v === 6) return ipv6InForbiddenRange(ip);
  // Loose IPv4 encodings normalize first.
  const canon = parseIpv4Loose(ip);
  return canon ? ipv4InForbiddenRange(canon) : false;
}

/**
 * Synchronous URL syntax + literal-host policy. No DNS, no I/O.
 *
 * @param input         raw navigation URL
 * @param opts.allowLiteralIp  when true, an IP-literal host is allowed *if* it is
 *                             not in a forbidden range (used by tooling that
 *                             targets explicit IPs); default false — navigation
 *                             targets must be domain names.
 */
export function checkUrlSyntax(
  input: string,
  opts: { allowLiteralIp?: boolean } = {},
): UrlPolicyResult {
  const rawAuthority = rawAuthorityOf(input);

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, reason: 'empty_host', detail: 'unparseable URL', rawAuthority };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: 'forbidden_protocol', detail: `protocol ${parsed.protocol} not allowed`, rawAuthority };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'userinfo_present', detail: 'userinfo (user:pass@) not allowed', rawAuthority };
  }

  // Normalize hostname: URL already lowercases, IDN-punycodes, and canonicalizes
  // IPv6; strip a trailing dot ourselves.
  let hostname = parsed.hostname;
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  if (hostname === '') {
    return { ok: false, reason: 'empty_host', detail: 'empty host', rawAuthority };
  }

  const ipLiteral = asIpLiteral(hostname);
  if (ipLiteral !== null) {
    if (isForbiddenIp(ipLiteral)) {
      return { ok: false, reason: 'forbidden_ip', detail: `literal IP ${ipLiteral} is forbidden`, rawAuthority };
    }
    if (!opts.allowLiteralIp) {
      return { ok: false, reason: 'literal_ip_host', detail: `literal IP host ${ipLiteral} not allowed for navigation`, rawAuthority };
    }
    return { ok: true, url: parsed.toString(), hostname: ipLiteral, isIpLiteral: true };
  }

  return { ok: true, url: parsed.toString(), hostname, isIpLiteral: false };
}

/**
 * Full policy: syntax check, then resolve every A/AAAA record for a domain host and
 * reject if any resolved IP is forbidden (DNS precheck — see SECURITY BOUNDARY NOTE).
 * IP-literal hosts skip DNS (already vetted by checkUrlSyntax).
 */
export async function checkUrlPolicy(
  input: string,
  resolver: DnsResolver,
  opts: { allowLiteralIp?: boolean } = {},
): Promise<UrlPolicyResult> {
  const syntax = checkUrlSyntax(input, opts);
  if (!syntax.ok) return syntax;
  if (syntax.isIpLiteral) return syntax;

  let records: string[];
  try {
    const [v4, v6] = await Promise.all([
      resolver.resolve4(syntax.hostname).catch(() => [] as string[]),
      resolver.resolve6(syntax.hostname).catch(() => [] as string[]),
    ]);
    records = [...v4, ...v6];
  } catch {
    return { ok: false, reason: 'unresolvable_host', detail: `DNS resolution failed for ${syntax.hostname}` };
  }

  if (records.length === 0) {
    return { ok: false, reason: 'no_dns_records', detail: `no A/AAAA records for ${syntax.hostname}` };
  }
  for (const ip of records) {
    if (isForbiddenIp(ip)) {
      return { ok: false, reason: 'forbidden_ip', detail: `${syntax.hostname} resolves to forbidden IP ${ip}` };
    }
  }
  return syntax;
}
