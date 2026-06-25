import { describe, it, expect } from 'vitest';
import {
  checkUrlSyntax,
  checkUrlPolicy,
  asIpLiteral,
  parseIpv4Loose,
  isForbiddenIp,
  rawAuthorityOf,
  type DnsResolver,
} from './url-policy.js';

/** Stub resolver returning fixed records per hostname. */
function stubResolver(map: Record<string, { v4?: string[]; v6?: string[] }>): DnsResolver {
  return {
    async resolve4(h) {
      return map[h]?.v4 ?? [];
    },
    async resolve6(h) {
      return map[h]?.v6 ?? [];
    },
  };
}

describe('url-policy · checkUrlSyntax', () => {
  it('accepts a plain https domain', () => {
    const r = checkUrlSyntax('https://example.com/path?q=1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hostname).toBe('example.com');
      expect(r.isIpLiteral).toBe(false);
    }
  });

  it('rejects non-http(s) protocols', () => {
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'about:blank', 'ftp://x.com', 'data:text/html,x', 'javascript:alert(1)']) {
      const r = checkUrlSyntax(url);
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(r.reason).toBe('forbidden_protocol');
    }
  });

  it('rejects userinfo forms', () => {
    const r = checkUrlSyntax('https://user:pass@example.com/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('userinfo_present');
  });

  it('lowercases and strips trailing dot, IDN→punycode', () => {
    const r = checkUrlSyntax('https://EXAMPLE.com./');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hostname).toBe('example.com');
    const idn = checkUrlSyntax('https://bücher.example/');
    expect(idn.ok).toBe(true);
    if (idn.ok) expect(idn.hostname).toBe('xn--bcher-kva.example');
  });

  it('rejects loopback literal hosts in every encoding', () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://127.1/',           // shorthand
      'http://2130706433/',      // decimal
      'http://0177.0.0.1/',      // octal
      'http://0x7f.0.0.1/',      // hex
      'http://[::1]/',           // IPv6 loopback
    ]) {
      const r = checkUrlSyntax(url);
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(['forbidden_ip', 'literal_ip_host']).toContain(r.reason);
    }
  });

  it('blocks forbidden literal IPs even when allowLiteralIp is set', () => {
    for (const url of [
      'http://169.254.169.254/',      // cloud metadata
      'http://10.0.0.5/',             // private
      'http://192.168.1.1/',          // private
      'http://172.16.0.1/',           // private
      'http://100.64.0.1/',           // CGNAT
      'http://198.18.0.1/',           // benchmark
      'http://0.0.0.0/',              // unspecified
      'http://[fd00:ec2::254]/',      // metadata v6 (fc00::/7)
      'http://[fe80::1]/',            // link-local v6
    ]) {
      const r = checkUrlSyntax(url, { allowLiteralIp: true });
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(r.reason).toBe('forbidden_ip');
    }
  });

  it('allows a public literal IP only when allowLiteralIp is set', () => {
    expect(checkUrlSyntax('http://93.184.216.34/').ok).toBe(false); // default: domains only
    const r = checkUrlSyntax('http://93.184.216.34/', { allowLiteralIp: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.isIpLiteral).toBe(true);
  });

  it('preserves raw authority for input-form assertions (P1-4)', () => {
    expect(rawAuthorityOf('http://0177.0.0.1/x')).toBe('0177.0.0.1');
    expect(rawAuthorityOf('http://user:pw@2130706433:8080/')).toBe('2130706433:8080');
    const r = checkUrlSyntax('http://2130706433/');
    if (!r.ok) expect(r.rawAuthority).toBe('2130706433');
  });
});

describe('url-policy · IP helpers', () => {
  it('parseIpv4Loose canonicalizes alternative encodings', () => {
    expect(parseIpv4Loose('2130706433')).toBe('127.0.0.1');
    expect(parseIpv4Loose('0177.0.0.1')).toBe('127.0.0.1');
    expect(parseIpv4Loose('0x7f.0.0.1')).toBe('127.0.0.1');
    expect(parseIpv4Loose('127.1')).toBe('127.0.0.1');
    expect(parseIpv4Loose('example.com')).toBeNull();
  });

  it('asIpLiteral distinguishes domains from literals', () => {
    expect(asIpLiteral('example.com')).toBeNull();
    expect(asIpLiteral('127.0.0.1')).toBe('127.0.0.1');
    expect(asIpLiteral('::1')).toBe('::1');
  });

  it('isForbiddenIp covers the full range set', () => {
    expect(isForbiddenIp('169.254.169.254')).toBe(true);
    expect(isForbiddenIp('100.127.255.255')).toBe(true);
    expect(isForbiddenIp('198.19.0.0')).toBe(true);
    expect(isForbiddenIp('224.0.0.1')).toBe(true);
    expect(isForbiddenIp('::ffff:127.0.0.1')).toBe(true); // IPv4-mapped loopback
    expect(isForbiddenIp('8.8.8.8')).toBe(false);
    expect(isForbiddenIp('93.184.216.34')).toBe(false);
  });
});

describe('url-policy · checkUrlPolicy (DNS precheck)', () => {
  it('passes a domain that resolves to public IPs', async () => {
    const r = await checkUrlPolicy('https://example.com/', stubResolver({ 'example.com': { v4: ['93.184.216.34'] } }));
    expect(r.ok).toBe(true);
  });

  it('rejects a domain that resolves to a forbidden IP (rebinding precheck)', async () => {
    const r = await checkUrlPolicy('https://rebind.evil/', stubResolver({ 'rebind.evil': { v4: ['127.0.0.1'] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('forbidden_ip');
  });

  it('rejects when ANY of multiple records is forbidden', async () => {
    const r = await checkUrlPolicy('https://multi.evil/', stubResolver({ 'multi.evil': { v4: ['93.184.216.34'], v6: ['fd00::1'] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('forbidden_ip');
  });

  it('rejects a host with zero A/AAAA records', async () => {
    const r = await checkUrlPolicy('https://nxdomain.test/', stubResolver({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_dns_records');
  });

  it('skips DNS for vetted literal IP hosts', async () => {
    let called = false;
    const resolver: DnsResolver = {
      async resolve4() { called = true; return []; },
      async resolve6() { called = true; return []; },
    };
    const r = await checkUrlPolicy('http://93.184.216.34/', resolver, { allowLiteralIp: true });
    expect(r.ok).toBe(true);
    expect(called).toBe(false);
  });
});
