import { cli, Strategy } from '@sovovs/bycli/registry';
import { resolveBrowserCredentials } from './_wechat/auth-session.js';
import {
  SETTINGS_SESSION_SCRIPT,
  assertSettingsSessionState,
  buildSettingsUrl,
  collectUserInfoTabs,
} from './_wechat/user-info.js';

const DEFAULT_SETTLE_SECONDS = 2;

function settleSeconds(value) {
  const parsed = Number(value ?? DEFAULT_SETTLE_SECONDS);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SETTLE_SECONDS;
}

export const userInfoCommand = cli({
  site: 'weixin',
  name: 'user-info',
  aliases: ['userInfo'],
  access: 'read',
  domain: 'mp.weixin.qq.com',
  description: '按账号详情、功能设置和授权管理 TAB 读取公众号账号设置',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    {
      name: 'settle',
      type: 'int',
      default: DEFAULT_SETTLE_SECONDS,
      help: '切换账号设置 TAB 后等待渲染的秒数',
    },
  ],
  columns: ['tab', 'data_json'],
  func: async (page, args) => {
    const { token } = await resolveBrowserCredentials(page);
    const settle = settleSeconds(args.settle);
    await page.goto(buildSettingsUrl(token));
    await page.wait(settle);
    assertSettingsSessionState(await page.evaluate(SETTINGS_SESSION_SCRIPT));
    const tabs = await collectUserInfoTabs(page, { settle });
    return tabs.map(tab => ({
      tab: tab.id,
      data_json: JSON.stringify(tab.data),
    }));
  },
});
