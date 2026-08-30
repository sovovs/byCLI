import { ArgumentError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { fetchAuthorizerProfile, getComponentAccessToken } from './_wechat/open-platform-api.js';

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function readOpenPlatformCredentials(args = {}, env = process.env) {
  const componentAppid = text(args['component-appid']) ?? text(env.WECHAT_COMPONENT_APPID);
  const componentAppsecret = text(args['component-appsecret']) ?? text(env.WECHAT_COMPONENT_APPSECRET);
  const componentVerifyTicket = text(args['component-verify-ticket']) ?? text(env.WECHAT_COMPONENT_VERIFY_TICKET);
  if (!componentAppid || !componentAppsecret || !componentVerifyTicket) {
    throw new ArgumentError('Weixin Open Platform requires component AppID, AppSecret, and verify ticket');
  }
  return { componentAppid, componentAppsecret, componentVerifyTicket };
}

export const openPlatformAuthorizerInfoCommand = cli({
  site: 'weixin',
  name: 'open-platform-authorizer-info',
  access: 'read',
  domain: 'api.weixin.qq.com',
  description: 'Get an authorized Official Account profile through a Weixin third-party platform',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    {
      name: 'authorizerAppid',
      positional: true,
      required: true,
      help: 'Authorized Official Account AppID',
    },
    {
      name: 'component-appid',
      help: 'Third-party platform AppID; falls back to WECHAT_COMPONENT_APPID',
    },
    {
      name: 'component-appsecret',
      help: 'Third-party platform AppSecret; prefer WECHAT_COMPONENT_APPSECRET',
    },
    {
      name: 'component-verify-ticket',
      help: 'Latest pushed verify ticket; prefer WECHAT_COMPONENT_VERIFY_TICKET',
    },
  ],
  columns: ['appid', 'nickname', 'username', 'principal_name'],
  func: async args => {
    const authorizerAppid = text(args.authorizerAppid);
    if (!authorizerAppid) throw new ArgumentError('authorizerAppid is required');
    const credentials = readOpenPlatformCredentials(args);
    const componentAccessToken = await getComponentAccessToken(credentials);
    const profile = await fetchAuthorizerProfile({
      componentAppid: credentials.componentAppid,
      componentAccessToken,
      authorizerAppid,
    });
    return [profile];
  },
});
