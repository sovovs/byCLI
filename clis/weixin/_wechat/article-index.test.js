import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { createArticleIndexFetcher, mapArticleIndexPayload } from './article-index.js';

const fixture = name => JSON.parse(
  fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
);
const credentials = { token: 'token-secret', cookie: 'sid=cookie-secret' };

describe('mapArticleIndexPayload', () => {
  it('maps nested and object publish records into the crawler page contract', () => {
    expect(mapArticleIndexPayload(fixture('articles-page'))).toEqual({
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

  it('maps an expired credential response to AuthRequiredError', () => {
    expect(() => mapArticleIndexPayload(fixture('articles-auth-expired'))).toThrow(AuthRequiredError);
  });

  it('distinguishes frequency control and unknown ret=200013 responses from authentication', () => {
    expect(() => mapArticleIndexPayload({ base_resp: { ret: 200013, err_msg: 'freq control' } }))
      .toThrowError(expect.objectContaining({
        name: 'RateLimitedError', code: 'RATE_LIMITED', exitCode: 75,
        message: expect.stringContaining('rate limited'),
      }));
    expect(() => mapArticleIndexPayload({ base_resp: { ret: 200013, err_msg: '' } }))
      .toThrowError(expect.objectContaining({ name: 'CommandExecutionError', code: 'COMMAND_EXEC' }));
  });

  it('preserves RATE_LIMITED through the article-index transport wrapper', async () => {
    const page = {
      fetchJson: vi.fn().mockResolvedValue({ base_resp: { ret: 200013, err_msg: 'freq control' } }),
    };
    const fetchPage = createArticleIndexFetcher({
      page, source: 'browser', credentials,
    });

    await expect(fetchPage({ fakeid: 'fake-id' })).rejects.toMatchObject({
      name: 'RateLimitedError', code: 'RATE_LIMITED', exitCode: 75,
      message: expect.stringContaining('rate limited'),
    });
  });

  it.each([
    [{ base_resp: { ret: 99, err_msg: 'failure' } }, 'ret=99'],
    [{ base_resp: { ret: 0 }, publish_page: '{bad-json' }, 'publish_page JSON'],
    [{ base_resp: { ret: 0 }, publish_page: '{"total_count":1,"publish_list":{}}' }, 'publish_list'],
    [{ base_resp: { ret: 0 }, publish_page: '{"total_count":1,"publish_list":[{}]}' }, 'publish_info'],
  ])('rejects malformed article payloads with a safe diagnostic: %j', (payload, message) => {
    expect(() => mapArticleIndexPayload(payload)).toThrowError(
      expect.objectContaining({ code: 'COMMAND_EXEC', message: expect.stringContaining(message) }),
    );
  });

  it('treats a missing publish page as a valid empty result', () => {
    expect(mapArticleIndexPayload({ base_resp: { ret: 0 }, publish_page: '' }))
      .toEqual({ total: 0, publishItemCount: 0, articles: [] });
  });
});

function assertRequest(url, init, includeCookie) {
  const parsed = new URL(url);
  expect(parsed.origin + parsed.pathname).toBe('https://mp.weixin.qq.com/cgi-bin/appmsgpublish');
  expect(Object.fromEntries(parsed.searchParams)).toEqual({
    sub: 'list', begin: '10', count: '3', fakeid: 'fake-id', token: 'token-secret',
    lang: 'zh_CN', f: 'json', ajax: '1',
  });
  const referer = new URL(init.headers.Referer);
  expect(referer.origin + referer.pathname).toBe('https://mp.weixin.qq.com/cgi-bin/appmsg');
  expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest');
  expect(init.headers.Cookie).toBe(includeCookie ? 'sid=cookie-secret' : undefined);
}

describe('createArticleIndexFetcher', () => {
  it('uses page.fetchJson in browser mode without sending a Cookie header', async () => {
    const page = { fetchJson: vi.fn().mockResolvedValue(fixture('articles-page')) };
    const nodeFetch = vi.fn();
    const fetchPage = createArticleIndexFetcher({
      page, source: 'browser', credentials, fetchImpl: nodeFetch,
    });

    await expect(fetchPage({ fakeid: 'fake-id', begin: 10, count: 3 }))
      .resolves.toMatchObject({ total: 2, publishItemCount: 2 });

    assertRequest(...page.fetchJson.mock.calls[0], false);
    expect(nodeFetch).not.toHaveBeenCalled();
  });

  it('uses environment fetch with Cookie and a bounded signal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => fixture('articles-page'),
    });
    const fetchPage = createArticleIndexFetcher({
      page: null, source: 'env', credentials, fetchImpl,
    });

    await fetchPage({ fakeid: 'fake-id', begin: 10, count: 3 });

    assertRequest(...fetchImpl.mock.calls[0], true);
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['browser', 'env'])('redacts transport errors in %s mode', async source => {
    const failure = new Error('failed token-secret cookie-secret');
    const page = { fetchJson: vi.fn().mockRejectedValue(failure) };
    const fetchImpl = vi.fn().mockRejectedValue(failure);
    const fetchPage = createArticleIndexFetcher({ page, source, credentials, fetchImpl });

    const error = await fetchPage({ fakeid: 'fake-id' }).catch(value => value);

    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(error.message).not.toMatch(/token-secret|cookie-secret/);
    expect(error.message).toContain('[REDACTED]');
  });

  it('reports an environment HTTP status without reading an error body', async () => {
    const json = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, json });
    const fetchPage = createArticleIndexFetcher({
      page: null, source: 'env', credentials, fetchImpl,
    });

    await expect(fetchPage({ fakeid: 'fake-id' })).rejects.toThrow('HTTP 403');
    expect(json).not.toHaveBeenCalled();
  });

  it.each([
    ['环境异常，完成验证后即可继续访问'],
    ['https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha'],
    ['secitptpage/verify.html'],
    ['<div id="js_verify">去验证</div>'],
  ])('classifies a WeChat verification response as authentication required: %s', async marker => {
    const failure = new CommandExecutionError('Response was not JSON', marker);
    const page = { fetchJson: vi.fn().mockRejectedValue(failure) };
    const fetchPage = createArticleIndexFetcher({ page, source: 'browser', credentials });

    const error = await fetchPage({ fakeid: 'fake-id' }).catch(value => value);
    expect(error).toMatchObject({
      name: 'AuthRequiredError', code: 'AUTH_REQUIRED', domain: 'mp.weixin.qq.com',
    });
    expect(error.message).toContain('explicitly confirm completion');
    expect(error.message).not.toContain('run the command again');
  });

  it('keeps an unrelated non-JSON response as a command failure', async () => {
    const failure = new CommandExecutionError(
      'Response was not JSON',
      'The upstream service returned an ordinary HTML error page.',
    );
    const page = { fetchJson: vi.fn().mockRejectedValue(failure) };
    const fetchPage = createArticleIndexFetcher({ page, source: 'browser', credentials });

    await expect(fetchPage({ fakeid: 'fake-id' })).rejects.toMatchObject({
      name: 'CommandExecutionError', code: 'COMMAND_EXEC',
    });
  });

  it('preserves typed authentication errors from the response mapper', async () => {
    const page = { fetchJson: vi.fn().mockResolvedValue(fixture('articles-auth-expired')) };
    const fetchPage = createArticleIndexFetcher({ page, source: 'browser', credentials });

    await expect(fetchPage({ fakeid: 'fake-id' })).rejects.toMatchObject({
      name: 'AuthRequiredError', code: 'AUTH_REQUIRED', exitCode: 77,
    });
  });
});
