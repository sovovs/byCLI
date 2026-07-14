import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { createWechatApi, parsePublishData, requestHeaders } from './wechat-api.js';

const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

describe('parsePublishData', () => {
  it('parses string publish_page and string/object publish_info values', () => {
    expect(parsePublishData(fixture('articles-page'))).toEqual({
      total: 2,
      publishItemCount: 2,
      articles: [
        {
          title: 'Synthetic article',
          url: 'https://mp.weixin.qq.com/s/synthetic',
          isDeleted: false,
          timestamp: 1767225600,
          publishedAt: '2026-01-01T00:00:00.000Z',
          digest: 'Synthetic digest',
          author: 'Synthetic author',
        },
        {
          title: 'Deleted article',
          url: 'https://mp.weixin.qq.com/s/deleted',
          isDeleted: true,
          timestamp: 1767312000,
          publishedAt: '2026-01-02T00:00:00.000Z',
          digest: '',
          author: '',
        },
      ],
    });
  });

  it('accepts an object publish_page and returns nullable article fields', () => {
    const result = parsePublishData({ base_resp: { ret: 0 }, publish_page: {
      total_count: 1,
      publish_list: [{ publish_info: { appmsg_info: [{}] } }],
    } });
    expect(result.articles[0]).toEqual({
      title: '', url: '', isDeleted: false, timestamp: 0, publishedAt: null, digest: '', author: '',
    });
  });

  it.each([
    { publish_page: '{bad json' },
    { publish_page: { total_count: 1, publish_list: [{ publish_info: '{bad json' }] } },
  ])('maps malformed nested JSON to CommandExecutionError', payload => {
    expect(() => parsePublishData(payload)).toThrow(CommandExecutionError);
  });

  it.each([
    ['Infinity', Infinity],
    ['an out-of-range number', 8_640_000_000_001],
    ['a non-number', 'token=timestamp-secret'],
  ])('maps %s timestamps to a redacted CommandExecutionError', (_name, timestamp) => {
    const payload = { publish_page: {
      total_count: 1,
      publish_list: [{ publish_info: { sent_info: { time: timestamp }, appmsg_info: [{}] } }],
    } };
    const error = (() => {
      try { parsePublishData(payload); }
      catch (value) { return value; }
    })();
    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(error).not.toBeInstanceOf(RangeError);
    expect(error.message).not.toContain('timestamp-secret');
  });

  it('requires the exact known auth ret/message pair', () => {
    expect(() => parsePublishData(fixture('articles-auth-expired'))).toThrow(AuthRequiredError);
    expect(() => parsePublishData({ base_resp: { ret: 200013, err_msg: 'other' } })).toThrow(CommandExecutionError);
    expect(() => parsePublishData({ base_resp: { ret: 99, err_msg: 'invalid credential' } })).toThrow(CommandExecutionError);
  });

  it('redacts unknown business error messages', () => {
    const error = (() => {
      try { parsePublishData({ base_resp: { ret: 99, err_msg: 'failed token=token-secret' } }); }
      catch (value) { return value; }
    })();
    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(error.message).not.toContain('token-secret');
  });
});

describe('createWechatApi', () => {
  it('builds appmsgpublish requests with credentials, paging, headers, and AbortSignal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => fixture('articles-page') });
    const api = createWechatApi({ token: 'token-secret', cookie: 'sid=cookie-secret', timeoutMs: 123, fetchImpl });
    await api.fetchPage({ fakeid: 'fake id', begin: 20, count: 5 });
    const [rawUrl, init] = fetchImpl.mock.calls[0];
    const url = new URL(rawUrl);
    expect(url.origin + url.pathname).toBe('https://mp.weixin.qq.com/cgi-bin/appmsgpublish');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      sub: 'list', begin: '20', count: '5', fakeid: 'fake id', token: 'token-secret',
      lang: 'zh_CN', f: 'json', ajax: '1',
    });
    expect(init.headers).toEqual(requestHeaders('sid=cookie-secret', 'token-secret'));
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['HTTP failure', async () => ({ ok: false, status: 503, statusText: 'Unavailable' })],
    ['JSON failure', async () => ({ ok: true, json: async () => { throw new Error('bad token-secret sid=cookie-secret'); } })],
  ])('wraps and redacts %s', async (_name, implementation) => {
    const api = createWechatApi({ token: 'token-secret', cookie: 'sid=cookie-secret', fetchImpl: implementation });
    const error = await api.fetchPage({ fakeid: 'id' }).catch(value => value);
    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(error.message).not.toMatch(/token-secret|cookie-secret/);
  });
});
