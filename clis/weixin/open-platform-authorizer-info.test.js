import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';

getRegistry().delete('weixin/open-platform-authorizer-info');
await import('./open-platform-authorizer-info.js');

const command = getRegistry().get('weixin/open-platform-authorizer-info');

function response(payload) {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) };
}

describe('weixin open-platform-authorizer-info command', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterAll(() => getRegistry().delete('weixin/open-platform-authorizer-info'));

  it('registers a browserless read command with a stable contract', () => {
    expect(command).toMatchObject({
      site: 'weixin',
      name: 'open-platform-authorizer-info',
      access: 'read',
      domain: 'api.weixin.qq.com',
      strategy: 'local',
      browser: false,
      columns: ['appid', 'nickname', 'username', 'principal_name'],
    });
    expect(command.args.find(arg => arg.name === 'authorizerAppid')).toMatchObject({
      positional: true,
      required: true,
    });
  });

  it('uses complete environment credentials and returns exactly four fields', async () => {
    vi.stubEnv('WECHAT_COMPONENT_APPID', 'wx-component');
    vi.stubEnv('WECHAT_COMPONENT_APPSECRET', 'component-secret');
    vi.stubEnv('WECHAT_COMPONENT_VERIFY_TICKET', 'verify-ticket');
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ component_access_token: 'component-token', expires_in: 7200 }))
      .mockResolvedValueOnce(response({
        authorizer_info: { nick_name: '笙歌数智录', user_name: 'gh_xxxxxx', principal_name: 'XXX公司' },
        authorization_info: { authorizer_appid: 'wx-authorizer' },
      })));

    await expect(command.func({ authorizerAppid: 'wx-authorizer' })).resolves.toEqual([{
      appid: 'wx-authorizer',
      nickname: '笙歌数智录',
      username: 'gh_xxxxxx',
      principal_name: 'XXX公司',
    }]);
  });

  it('prefers explicit credentials over environment credentials', async () => {
    vi.stubEnv('WECHAT_COMPONENT_APPID', 'wx-env');
    vi.stubEnv('WECHAT_COMPONENT_APPSECRET', 'env-secret');
    vi.stubEnv('WECHAT_COMPONENT_VERIFY_TICKET', 'env-ticket');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ component_access_token: 'component-token' }))
      .mockResolvedValueOnce(response({
        authorizer_info: { nick_name: '名称', user_name: 'gh_x', principal_name: '主体' },
      }));
    vi.stubGlobal('fetch', fetchImpl);

    await command.func({
      authorizerAppid: 'wx-authorizer',
      'component-appid': 'wx-explicit',
      'component-appsecret': 'explicit-secret',
      'component-verify-ticket': 'explicit-ticket',
    });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      component_appid: 'wx-explicit',
      component_appsecret: 'explicit-secret',
      component_verify_ticket: 'explicit-ticket',
    });
  });

  it('rejects partial credentials before making a request', async () => {
    vi.stubEnv('WECHAT_COMPONENT_APPID', 'wx-component');
    vi.stubEnv('WECHAT_COMPONENT_APPSECRET', 'component-secret');
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    await expect(command.func({ authorizerAppid: 'wx-authorizer' }))
      .rejects.toThrow('requires component AppID, AppSecret, and verify ticket');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
