import { describe, expect, it, vi } from 'vitest';
import {
  fetchAuthorizerProfile,
  getComponentAccessToken,
  normalizeAuthorizerProfile,
} from './open-platform-api.js';

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: vi.fn().mockResolvedValue(payload) };
}

describe('weixin open platform API', () => {
  it('exchanges component credentials for a component access token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      component_access_token: 'component-token',
      expires_in: 7200,
    }));

    await expect(getComponentAccessToken({
      componentAppid: 'wx-component',
      componentAppsecret: 'component-secret',
      componentVerifyTicket: 'verify-ticket',
      fetchImpl,
    })).resolves.toBe('component-token');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.weixin.qq.com/cgi-bin/component/api_component_token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      component_appid: 'wx-component',
      component_appsecret: 'component-secret',
      component_verify_ticket: 'verify-ticket',
    });
  });

  it('queries and normalizes the authorized official account', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      authorizer_info: {
        nick_name: '笙歌数智录',
        user_name: 'gh_xxxxxx',
        principal_name: 'XXX公司',
      },
      authorization_info: { authorizer_appid: 'wx-authorizer' },
    }));

    await expect(fetchAuthorizerProfile({
      componentAppid: 'wx-component',
      componentAccessToken: 'component-token',
      authorizerAppid: 'wx-authorizer',
      fetchImpl,
    })).resolves.toEqual({
      appid: 'wx-authorizer',
      nickname: '笙歌数智录',
      username: 'gh_xxxxxx',
      principal_name: 'XXX公司',
    });

    const [requestUrl, request] = fetchImpl.mock.calls[0];
    expect(new URL(requestUrl).searchParams.get('component_access_token')).toBe('component-token');
    expect(JSON.parse(request.body)).toEqual({
      component_appid: 'wx-component',
      authorizer_appid: 'wx-authorizer',
    });
  });

  it('accepts the historical authorization_appid field', () => {
    expect(normalizeAuthorizerProfile({
      authorizer_info: { nick_name: '名称', user_name: 'gh_old', principal_name: '主体' },
      authorization_info: { authorization_appid: 'wx-authorizer' },
    }, 'wx-authorizer')).toEqual({
      appid: 'wx-authorizer', nickname: '名称', username: 'gh_old', principal_name: '主体',
    });
  });

  it('rejects an authorizer AppID mismatch', () => {
    expect(() => normalizeAuthorizerProfile({
      authorizer_info: { nick_name: '名称', user_name: 'gh_x', principal_name: '主体' },
      authorization_info: { authorizer_appid: 'wx-other' },
    }, 'wx-authorizer')).toThrow('authorizer AppID did not match');
  });

  it.each([
    ['nickname', { user_name: 'gh_x', principal_name: '主体' }],
    ['username', { nick_name: '名称', principal_name: '主体' }],
    ['principal_name', { nick_name: '名称', user_name: 'gh_x' }],
  ])('rejects missing %s', (_field, authorizerInfo) => {
    expect(() => normalizeAuthorizerProfile({ authorizer_info: authorizerInfo }, 'wx-authorizer'))
      .toThrow('incomplete account profile');
  });

  it('redacts component secrets from API failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ errcode: 40001, errmsg: 'bad component-secret verify-ticket' }));

    await expect(getComponentAccessToken({
      componentAppid: 'wx-component',
      componentAppsecret: 'component-secret',
      componentVerifyTicket: 'verify-ticket',
      fetchImpl,
    })).rejects.toSatisfy(error => {
      expect(error.message).not.toContain('component-secret');
      expect(error.message).not.toContain('verify-ticket');
      return true;
    });
  });
});
