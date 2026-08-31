import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import {
  TAB_DEFINITIONS,
  USER_INFO_EXTRACT_SCRIPT,
  assertSettingsSessionState,
  buildSelectTabScript,
  buildSettingsUrl,
  collectUserInfoTabs,
  normalizeUserInfoTab,
  sanitizeActionPath,
} from './user-info.js';

const RAW_ACCOUNT_DETAILS = {
  available: true,
  sections: [{
    label: ' 公开信息 ',
    fields: [
      { label: ' 名称 ', value: ' 升sovs ', status: undefined },
      { label: '认证情况', value: '未认证', status: ' 需认证 ' },
    ],
    actions: [
      {
        label: ' 修改 ',
        enabled: true,
        href: '/cgi-bin/setting?action=edit&token=secret#top',
      },
      { label: '下载二维码', enabled: false, href: 'javascript:void(0)' },
    ],
  }],
};

describe('weixin account settings helpers', () => {
  it('defines the three account-settings tabs in page order', () => {
    expect(TAB_DEFINITIONS).toEqual([
      { id: 'account_details', label: '账号详情' },
      { id: 'feature_settings', label: '功能设置' },
      { id: 'authorization_management', label: '授权管理' },
    ]);
  });

  it('builds a token-scoped settings URL', () => {
    expect(buildSettingsUrl('1824897392')).toBe(
      'https://mp.weixin.qq.com/cgi-bin/settingpage?t=setting%2Findex&action=index&token=1824897392&lang=zh_CN',
    );
  });

  it.each([undefined, null, '', '   ', 42])('rejects an invalid settings token: %s', token => {
    expect(() => buildSettingsUrl(token)).toThrow(ArgumentError);
  });

  it.each([
    ['/cgi-bin/setting?action=edit&token=secret#top', '/cgi-bin/setting'],
    ['https://mp.weixin.qq.com/cgi-bin/setting?action=edit', '/cgi-bin/setting'],
    ['https://evil.test/cgi-bin/setting', null],
    ['http://mp.weixin.qq.com/cgi-bin/setting', null],
    ['javascript:void(0)', null],
    ['not a valid path', '/not%20a%20valid%20path'],
    ['', null],
    [null, null],
  ])('sanitizes action destination %j', (input, expected) => {
    expect(sanitizeActionPath(input)).toBe(expected);
  });

  it('normalizes fields and actions without exposing query parameters', () => {
    expect(normalizeUserInfoTab('account_details', RAW_ACCOUNT_DETAILS)).toEqual({
      label: '账号详情',
      available: true,
      sections: [{
        label: '公开信息',
        fields: [
          { label: '名称', value: '升sovs', status: null },
          { label: '认证情况', value: '未认证', status: '需认证' },
        ],
        actions: [
          { label: '修改', enabled: true, path: '/cgi-bin/setting' },
          { label: '下载二维码', enabled: false, path: null },
        ],
      }],
    });
  });

  it('returns an explicit empty unavailable tab', () => {
    expect(normalizeUserInfoTab('authorization_management', {
      available: false,
      sections: [{ label: 'ignored', fields: [], actions: [] }],
    })).toEqual({
      label: '授权管理',
      available: false,
      sections: [],
    });
  });

  it('classifies a redirected login page as an authentication failure', () => {
    expect(() => assertSettingsSessionState({
      href: 'https://mp.weixin.qq.com/',
      hasLoginUi: true,
    })).toThrow(AuthRequiredError);
  });

  it('rejects an authenticated redirect away from account settings', () => {
    expect(() => assertSettingsSessionState({
      href: 'https://mp.weixin.qq.com/cgi-bin/home?token=42',
      hasLoginUi: false,
    })).toThrow(CommandExecutionError);
  });

  it('accepts the token-scoped account settings page', () => {
    expect(assertSettingsSessionState({
      href: 'https://mp.weixin.qq.com/cgi-bin/settingpage?token=42',
      hasLoginUi: false,
    })).toBeUndefined();
  });

  it('omits empty sections and null-normalizes missing field values', () => {
    expect(normalizeUserInfoTab('feature_settings', {
      available: true,
      sections: [
        { label: '空分区', fields: [], actions: [] },
        { label: '功能', fields: [{ label: '留言', value: null }], actions: [] },
      ],
    })).toEqual({
      label: '功能设置',
      available: true,
      sections: [{
        label: '功能',
        fields: [{ label: '留言', value: null, status: null }],
        actions: [],
      }],
    });
  });

  it('rejects unknown tabs and unreadable available payloads', () => {
    expect(() => normalizeUserInfoTab('unknown', RAW_ACCOUNT_DETAILS))
      .toThrow(CommandExecutionError);
    expect(() => normalizeUserInfoTab('account_details', null))
      .toThrow(CommandExecutionError);
    expect(() => normalizeUserInfoTab('account_details', { available: true, sections: [] }))
      .toThrow(CommandExecutionError);
  });
});

describe('weixin account settings browser extraction', () => {
  it('selects an exact visible tab label without matching a longer label', () => {
    const dom = new JSDOM(`
      <div role="tab">账号详情说明</div>
      <button role="tab" id="target">账号详情</button>
    `, { runScripts: 'outside-only' });
    let clicks = 0;
    dom.window.document.querySelector('#target').addEventListener('click', () => { clicks += 1; });

    expect(dom.window.eval(buildSelectTabScript('账号详情'))).toEqual({
      selected: true,
      disabled: false,
    });
    expect(clicks).toBe(1);
  });

  it('reports a disabled tab without clicking it', () => {
    const dom = new JSDOM('<button role="tab" disabled>授权管理</button>', {
      runScripts: 'outside-only',
    });
    expect(dom.window.eval(buildSelectTabScript('授权管理'))).toEqual({
      selected: false,
      disabled: true,
    });
  });

  it('extracts legacy setting rows while separating actions from values', () => {
    const dom = new JSDOM(`
      <nav><a href="/cgi-bin/home">首页</a></nav>
      <div class="setting_area">
        <div class="setting_area_hd"><h3>公开信息</h3></div>
        <div class="setting_item">
          <div class="frm_label">名称</div>
          <div class="frm_controls">
            <span class="setting_value">升sovs</span>
            <a class="setting_opr" href="/cgi-bin/setting?action=edit&token=secret">修改</a>
          </div>
        </div>
        <div class="setting_item" hidden>
          <div class="frm_label">名称</div><div class="frm_controls">重复值</div>
        </div>
      </div>
    `, { runScripts: 'outside-only', url: 'https://mp.weixin.qq.com/cgi-bin/settingpage' });

    expect(dom.window.eval(USER_INFO_EXTRACT_SCRIPT)).toEqual({
      available: true,
      sections: [{
        label: '公开信息',
        fields: [{ label: '名称', value: '升sovs', status: null }],
        actions: [{
          label: '修改',
          enabled: true,
          href: 'https://mp.weixin.qq.com/cgi-bin/setting?action=edit&token=secret',
        }],
      }],
    });
  });

  it('extracts WeUI desktop rows and button-only actions', () => {
    const dom = new JSDOM(`
      <section class="weui-desktop-panel">
        <h3 class="weui-desktop-panel__title">功能状态</h3>
        <div class="weui-desktop-setting__item">
          <div class="weui-desktop-setting__label">留言功能</div>
          <div class="weui-desktop-setting__value">已开启</div>
          <button disabled>设置</button>
        </div>
      </section>
    `, { runScripts: 'outside-only', url: 'https://mp.weixin.qq.com/cgi-bin/settingpage' });

    expect(dom.window.eval(USER_INFO_EXTRACT_SCRIPT)).toEqual({
      available: true,
      sections: [{
        label: '功能状态',
        fields: [{ label: '留言功能', value: '已开启', status: null }],
        actions: [{ label: '设置', enabled: false, href: null }],
      }],
    });
  });

  it('collects all tabs sequentially in stable order', async () => {
    const featureRaw = {
      available: true,
      sections: [{
        label: '功能状态',
        fields: [{ label: '留言功能', value: '已开启' }],
        actions: [],
      }],
    };
    const authorizationRaw = {
      available: true,
      sections: [{
        label: '第三方授权',
        fields: [{ label: '授权数量', value: '0' }],
        actions: [{ label: '查看', enabled: true, href: '/cgi-bin/component_unauthorize' }],
      }],
    };
    const page = {
      evaluate: vi.fn()
        .mockResolvedValueOnce({ selected: true, disabled: false })
        .mockResolvedValueOnce(RAW_ACCOUNT_DETAILS)
        .mockResolvedValueOnce({ selected: true, disabled: false })
        .mockResolvedValueOnce(featureRaw)
        .mockResolvedValueOnce({ selected: true, disabled: false })
        .mockResolvedValueOnce(authorizationRaw),
      wait: vi.fn().mockResolvedValue(undefined),
    };

    const result = await collectUserInfoTabs(page, { settle: 2 });

    expect(result.map(tab => tab.id)).toEqual([
      'account_details', 'feature_settings', 'authorization_management',
    ]);
    expect(result[0].data.label).toBe('账号详情');
    expect(result[1].data.sections[0].fields[0].value).toBe('已开启');
    expect(result[2].data.sections[0].actions[0].path).toBe('/cgi-bin/component_unauthorize');
    expect(page.wait.mock.calls).toEqual([[2], [2], [2]]);
  });

  it('returns an explicitly disabled tab without attempting extraction', async () => {
    const page = {
      evaluate: vi.fn()
        .mockResolvedValueOnce({ selected: false, disabled: true })
        .mockResolvedValueOnce({ selected: false, disabled: true })
        .mockResolvedValueOnce({ selected: false, disabled: true }),
      wait: vi.fn(),
    };

    const result = await collectUserInfoTabs(page, { settle: 2 });

    expect(result.map(tab => tab.data.available)).toEqual([false, false, false]);
    expect(page.wait).not.toHaveBeenCalled();
  });

  it('marks one absent tab unavailable when other settings tabs are recognized', async () => {
    const page = {
      evaluate: vi.fn()
        .mockResolvedValueOnce({ selected: true, disabled: false })
        .mockResolvedValueOnce(RAW_ACCOUNT_DETAILS)
        .mockResolvedValueOnce({ selected: false, disabled: false })
        .mockResolvedValueOnce({ selected: false, disabled: true }),
      wait: vi.fn().mockResolvedValue(undefined),
    };

    const result = await collectUserInfoTabs(page, { settle: 2 });

    expect(result.map(tab => tab.data.available)).toEqual([true, false, false]);
    expect(page.wait.mock.calls).toEqual([[2]]);
  });

  it('fails when a required tab cannot be identified', async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue({ selected: false, disabled: false }),
      wait: vi.fn(),
    };

    await expect(collectUserInfoTabs(page, { settle: 2 }))
      .rejects.toThrow(CommandExecutionError);
  });
});
