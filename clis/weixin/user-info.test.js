import { afterAll, describe, expect, it, vi } from 'vitest';
import { AuthRequiredError } from '@sovovs/bycli/errors';
import { getRegistry } from '@sovovs/bycli/registry';
import { buildSettingsUrl } from './_wechat/user-info.js';

getRegistry().delete('weixin/user-info');
await import('./user-info.js');

const command = getRegistry().get('weixin/user-info');

const RAW_TABS = [
  {
    available: true,
    sections: [{
      label: '公开信息',
      fields: [{ label: '名称', value: '升sovs' }],
      actions: [{ label: '修改', enabled: true, href: '/cgi-bin/setting?token=secret' }],
    }],
  },
  {
    available: true,
    sections: [{
      label: '功能状态',
      fields: [{ label: '留言功能', value: '已开启' }],
      actions: [{ label: '设置', enabled: true, href: null }],
    }],
  },
  {
    available: false,
    sections: [],
  },
];

function loggedInPage() {
  let extracted = 0;
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    getCookies: vi.fn().mockResolvedValue([
      { name: 'slave_sid', value: 'abc', domain: '.mp.weixin.qq.com' },
    ]),
    evaluate: vi.fn(async script => {
      if (typeof script === 'function') {
        return { href: 'https://mp.weixin.qq.com/cgi-bin/home?token=42', hasLoginUi: false };
      }
      if (String(script).includes('hasLoginUi: selectors.some')) {
        return {
          href: 'https://mp.weixin.qq.com/cgi-bin/settingpage?token=42',
          hasLoginUi: false,
        };
      }
      if (String(script).includes("'a[href]'") && String(script).includes('node.click()')) {
        return { selected: true, disabled: false };
      }
      const payload = RAW_TABS[extracted];
      extracted += 1;
      return payload;
    }),
  };
}

describe('weixin user-info command', () => {
  afterAll(() => getRegistry().delete('weixin/user-info'));

  it('registers a read-only browser command with a stable row contract', () => {
    expect(command).toMatchObject({
      site: 'weixin',
      name: 'user-info',
      aliases: ['userInfo'],
      access: 'read',
      domain: 'mp.weixin.qq.com',
      strategy: 'cookie',
      browser: true,
      columns: ['tab', 'data_json'],
      navigateBefore: false,
    });
    expect(command.args).toEqual([
      { name: 'settle', type: 'int', default: 2, help: '切换账号设置 TAB 后等待渲染的秒数' },
    ]);
  });

  it('is reachable through the userInfo alias', () => {
    expect(getRegistry().get('weixin/userInfo')).toBe(command);
  });

  it('navigates to account settings and returns one JSON row per tab', async () => {
    const page = loggedInPage();

    const rows = await command.func(page, { settle: 3 });

    expect(page.goto).toHaveBeenCalledWith(buildSettingsUrl('42'));
    expect(page.wait.mock.calls).toEqual([[3], [3], [3], [3]]);
    expect(rows.map(row => row.tab)).toEqual([
      'account_details', 'feature_settings', 'authorization_management',
    ]);
    expect(rows.map(row => JSON.parse(row.data_json))).toEqual([
      {
        label: '账号详情',
        available: true,
        sections: [{
          label: '公开信息',
          fields: [{ label: '名称', value: '升sovs' }],
        }],
      },
      {
        label: '功能设置',
        available: true,
        sections: [{
          label: '功能状态',
          fields: [{ label: '留言功能', value: '已开启' }],
        }],
      },
      { label: '授权管理', available: false, sections: [] },
    ]);
  });

  it.each([undefined, 0, -1, Number.NaN])('uses a 2 second settle fallback for %s', async settle => {
    const page = loggedInPage();

    await command.func(page, { settle });

    expect(page.wait.mock.calls).toEqual([[2], [2], [2], [2]]);
  });

  it('reports authentication expiry after navigating to account settings', async () => {
    const page = loggedInPage();
    page.evaluate = vi.fn(async script => {
      if (typeof script === 'function') {
        return { href: 'https://mp.weixin.qq.com/cgi-bin/home?token=42', hasLoginUi: false };
      }
      return { href: 'https://mp.weixin.qq.com/', hasLoginUi: true };
    });

    await expect(command.func(page, { settle: 2 })).rejects.toThrow(AuthRequiredError);
  });
});
