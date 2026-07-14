import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { executeSearchBiz, mapSearchBizPayload } from './search-biz.js';

const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const credentials = { token: 'token-secret', cookie: 'sid=cookie-secret', fingerprint: 'fp-secret' };

describe('mapSearchBizPayload', () => {
  it('returns every similar account and normalizes a missing alias to null', () => {
    expect(mapSearchBizPayload(fixture('search-success'))).toEqual([
      { nickname: '微信派', fakeid: 'MzA1', alias: 'wx-pai' },
      { nickname: '微信派服务号', fakeid: 'MzA2', alias: null },
    ]);
  });

  it('maps the known expired credential response to AuthRequiredError', () => {
    expect(() => mapSearchBizPayload(fixture('search-auth-expired'))).toThrow(AuthRequiredError);
  });

  it.each([
    [{ base_resp: { ret: 99, err_msg: 'odd failure' }, list: [] }],
    [{ base_resp: { ret: 0 }, list: {} }],
    [{ base_resp: { ret: 0 }, list: [{ nickname: '', fakeid: 'id' }] }],
  ])('rejects unknown errors and malformed success payloads', payload => {
    expect(() => mapSearchBizPayload(payload)).toThrow(CommandExecutionError);
  });
});

function assertRequest(url, init, includeCookie) {
  const parsed = new URL(url);
  expect(parsed.origin + parsed.pathname).toBe('https://mp.weixin.qq.com/cgi-bin/searchbiz');
  expect(Object.fromEntries(parsed.searchParams)).toEqual({
    action: 'search_biz', scene: '1', begin: '0', count: '2', query: '微信 派',
    fingerprint: 'fp-secret', token: 'token-secret', lang: 'zh_CN', f: 'json', ajax: '1',
  });
  expect(init.headers.Referer).toContain('https://mp.weixin.qq.com/cgi-bin/appmsg');
  expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest');
  expect(init.headers.Cookie).toBe(includeCookie ? 'sid=cookie-secret' : undefined);
}

describe('executeSearchBiz', () => {
  it('uses browser page.fetchJson without a Cookie header', async () => {
    const page = { fetchJson: vi.fn().mockResolvedValue(fixture('search-success')) };
    await expect(executeSearchBiz({ page, source: 'browser', credentials, query: '微信 派', limit: 2 }))
      .resolves.toHaveLength(2);
    assertRequest(...page.fetchJson.mock.calls[0], false);
  });

  it('uses environment fetch and sends its Cookie header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => fixture('search-success') });
    await executeSearchBiz({ page: null, source: 'env', credentials, query: '微信 派', limit: 2, fetchImpl });
    assertRequest(...fetchImpl.mock.calls[0], true);
  });

  it.each(['browser', 'env'])('redacts transport errors in %s mode', async source => {
    const failure = new Error('failed token-secret cookie-secret fp-secret');
    const page = { fetchJson: vi.fn().mockRejectedValue(failure) };
    const fetchImpl = vi.fn().mockRejectedValue(failure);
    const promise = executeSearchBiz({ page, source, credentials, query: 'q', limit: 1, fetchImpl });
    const error = await promise.catch(value => value);
    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(error.message).not.toMatch(/token-secret|cookie-secret|fp-secret/);
    expect(error.message).toContain('[REDACTED]');
  });

  it('preserves typed errors thrown by the browser transport', async () => {
    const typed = new AuthRequiredError('mp.weixin.qq.com', 'invalid credential');
    const page = { fetchJson: vi.fn().mockRejectedValue(typed) };
    await expect(executeSearchBiz({ page, source: 'browser', credentials, query: 'q', limit: 1 }))
      .rejects.toBe(typed);
  });

  it('redacts environment JSON parse failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('bad fp-secret'); } });
    const error = await executeSearchBiz({ page: null, source: 'env', credentials, query: 'q', limit: 1, fetchImpl }).catch(value => value);
    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(error.message).not.toContain('fp-secret');
  });
});
