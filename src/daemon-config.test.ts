import { describe, expect, it } from 'vitest';
import { ConfigError } from './errors.js';
import { resolveDaemonHost } from './daemon-config.js';

describe('resolveDaemonHost', () => {
  it('defaults to loopback', () => {
    expect(resolveDaemonHost({})).toBe('127.0.0.1');
  });

  it('allows an explicit container bind', () => {
    expect(resolveDaemonHost({ BYCLI_DAEMON_HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  it('allows an explicit loopback bind', () => {
    expect(resolveDaemonHost({ BYCLI_DAEMON_HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });

  it('rejects unsupported hosts', () => {
    expect(() => resolveDaemonHost({ BYCLI_DAEMON_HOST: 'example.com' }))
      .toThrow(ConfigError);
  });
});
