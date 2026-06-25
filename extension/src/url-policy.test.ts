import { describe, it, expect } from 'vitest';
import { checkUrlSyntax, asIpLiteral, parseIpv4Loose, isForbiddenIp } from './url-policy.js';

describe('extension url-policy · checkUrlSyntax (syntax-only, no DNS)', () => {
  it('accepts a plain https domain', () => {
    const r = checkUrlSyntax('https://example.com/path?q=1');
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.hostname).toBe('example.com'); expect(r.isIpLiteral).toBe(false); }
  });

  it('rejects non-http(s) protocols', () => {
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'about:blank', 'data:text/html,x']) {
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

  it('lowercases + strips trailing dot + IDN punycode', () => {
    const r = checkUrlSyntax('https://EXAMPLE.com./');
    if (r.ok) expect(r.hostname).toBe('example.com');
    const idn = checkUrlSyntax('https://bücher.example/');
    if (idn.ok) expect(idn.hostname).toBe('xn--bcher-kva.example');
  });

  it('rejects loopback literal hosts in every encoding', () => {
    for (const url of ['http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f.0.0.1/', 'http://[::1]/']) {
      const r = checkUrlSyntax(url);
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(['forbidden_ip', 'literal_ip_host']).toContain(r.reason);
    }
  });

  it('blocks forbidden literal IPs even with allowLiteralIp', () => {
    for (const url of ['http://169.254.169.254/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://100.64.0.1/', 'http://198.18.0.1/', 'http://0.0.0.0/', 'http://[fd00:ec2::254]/', 'http://[fe80::1]/']) {
      const r = checkUrlSyntax(url, { allowLiteralIp: true });
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(r.reason).toBe('forbidden_ip');
    }
  });

  it('allows a public literal IP only with allowLiteralIp', () => {
    expect(checkUrlSyntax('http://93.184.216.34/').ok).toBe(false);
    expect(checkUrlSyntax('http://93.184.216.34/', { allowLiteralIp: true }).ok).toBe(true);
  });
});

describe('extension url-policy · IP helpers (no node:net)', () => {
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
    expect(isForbiddenIp('::ffff:127.0.0.1')).toBe(true);
    expect(isForbiddenIp('8.8.8.8')).toBe(false);
    expect(isForbiddenIp('93.184.216.34')).toBe(false);
  });
});
