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

  it('normalizes only field labels and values', () => {
    expect(normalizeUserInfoTab('account_details', RAW_ACCOUNT_DETAILS)).toEqual({
      label: '账号详情',
      available: true,
      sections: [{
        label: '公开信息',
        fields: [
          { label: '名称', value: '升sovs' },
          { label: '认证情况', value: '未认证' },
        ],
      }],
    });
  });

  it('preserves boolean field values', () => {
    expect(normalizeUserInfoTab('feature_settings', {
      available: true,
      sections: [{
        label: '功能设置',
        fields: [{ label: '隐私设置', value: true, status: 'ignored' }],
        actions: [{ label: '设置', enabled: true, href: '/ignored' }],
      }],
    })).toEqual({
      label: '功能设置',
      available: true,
      sections: [{
        label: '功能设置',
        fields: [{ label: '隐私设置', value: true }],
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

  it('preserves an explicitly recognized empty section', () => {
    expect(normalizeUserInfoTab('authorization_management', {
      available: true,
      sections: [{ label: '第三方平台', fields: [], actions: [], empty: true }],
    })).toEqual({
      label: '授权管理',
      available: true,
      sections: [{ label: '第三方平台', fields: [] }],
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
        fields: [{ label: '留言', value: null }],
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
      href: null,
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
      href: null,
    });
  });

  it('prefers a navigable anchor over its matching list-item wrapper', () => {
    const dom = new JSDOM(`
      <ul>
        <li id="wrapper">
          <a id="target" href="/cgi-bin/settingpage?t=setting/function&token=42">功能设置</a>
        </li>
      </ul>
    `, {
      runScripts: 'outside-only',
      url: 'https://mp.weixin.qq.com/cgi-bin/settingpage?token=42',
    });
    let wrapperClicks = 0;
    dom.window.document.querySelector('#wrapper').addEventListener('click', event => {
      if (event.target.id === 'wrapper') wrapperClicks += 1;
    });

    expect(dom.window.eval(buildSelectTabScript('功能设置'))).toEqual({
      selected: true,
      disabled: false,
      href: 'https://mp.weixin.qq.com/cgi-bin/settingpage?t=setting/function&token=42',
    });
    expect(wrapperClicks).toBe(0);
  });

  it('ignores a matching tab inside a CSS-hidden ancestor', () => {
    const dom = new JSDOM(`
      <div style="display: none">
        <a href="/cgi-bin/settingpage?t=hidden&token=42">授权管理</a>
      </div>
      <a href="/cgi-bin/settingpage?t=visible&token=42">授权管理</a>
    `, {
      runScripts: 'outside-only',
      url: 'https://mp.weixin.qq.com/cgi-bin/settingpage?token=42',
    });

    expect(dom.window.eval(buildSelectTabScript('授权管理')).href).toBe(
      'https://mp.weixin.qq.com/cgi-bin/settingpage?t=visible&token=42',
    );
  });

  it('clicks a tab whose anchor uses a JavaScript placeholder', () => {
    const dom = new JSDOM('<a id="target" href="javascript:;">功能设置</a>', {
      runScripts: 'outside-only',
      url: 'https://mp.weixin.qq.com/cgi-bin/settingpage?token=42',
    });
    let clicks = 0;
    dom.window.document.querySelector('#target').addEventListener('click', event => {
      event.preventDefault();
      clicks += 1;
    });

    expect(dom.window.eval(buildSelectTabScript('功能设置'))).toEqual({
      selected: true,
      disabled: false,
      href: null,
    });
    expect(clicks).toBe(1);
  });

  it('extracts a legacy main value without right-side actions', () => {
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
        fields: [{ label: '名称', value: '升sovs' }],
      }],
    });
  });

  it('omits button-only actions from WeUI desktop rows', () => {
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
        fields: [{ label: '留言功能', value: '已开启' }],
      }],
    });
  });

  it('extracts class-agnostic field rows from paired visible text blocks', () => {
    const dom = new JSDOM(`
      <section class="setting_area">
        <h3>公开信息</h3>
        <div class="opaque-row">
          <span>名称</span>
          <span>升sovs</span>
          <a href="/cgi-bin/setting?action=edit&token=secret">修改</a>
        </div>
        <div class="opaque-row">
          <span>认证情况</span>
          <span>未认证</span>
          <span>需认证</span>
        </div>
      </section>
    `, { runScripts: 'outside-only', url: 'https://mp.weixin.qq.com/cgi-bin/settingpage' });

    expect(dom.window.eval(USER_INFO_EXTRACT_SCRIPT)).toEqual({
      available: true,
      sections: [{
        label: '公开信息',
        fields: [
          { label: '名称', value: '升sovs' },
          { label: '认证情况', value: '未认证' },
        ],
      }],
    });
  });

  it('removes explanatory tips while preserving the primary field value', () => {
    const dom = new JSDOM(`
      <section class="setting_area">
        <h3>公开信息</h3>
        <div class="setting_item">
          <div class="frm_label">名称</div>
          <div class="frm_controls">
            <span class="setting_value">升sovs</span>
            <p class="frm_tips">个人类账号一个自然年内可主动修改两次名称 <a>查看</a></p>
            <a class="setting_opr">修改</a><span class="icon-question">?</span>
          </div>
        </div>
      </section>
    `, { runScripts: 'outside-only', url: 'https://mp.weixin.qq.com/cgi-bin/settingpage' });

    expect(dom.window.eval(USER_INFO_EXTRACT_SCRIPT).sections[0].fields).toEqual([
      { label: '名称', value: '升sovs' },
    ]);
  });

  it('returns true for an enabled switch field', () => {
    const dom = new JSDOM(`
      <section class="setting_area">
        <h3>功能设置</h3>
        <div class="setting_item">
          <div class="frm_label">隐私设置</div>
          <div class="frm_controls">
            <span>允许通过名称搜索到本账号</span>
            <label class="weui-desktop-switch"><input type="checkbox" checked></label>
          </div>
        </div>
      </section>
    `, { runScripts: 'outside-only', url: 'https://mp.weixin.qq.com/cgi-bin/settingpage' });

    expect(dom.window.eval(USER_INFO_EXTRACT_SCRIPT).sections[0].fields).toEqual([
      { label: '隐私设置', value: true },
    ]);
  });

  it('reads a switch from the current WeChat desktop setting DOM', () => {
    const dom = new JSDOM(`
      <section class="weui-desktop-panel">
        <h3 class="weui-desktop-panel__title">功能设置</h3>
        <li class="weui-desktop-setting__item">
          <label class="weui-desktop-setting__item__label">隐私设置</label>
          <div class="weui-desktop-setting__item__controls">
            <div class="weui-desktop-setting__item__main">
              <strong class="weui-desktop-setting__item__info">
                <span>允许通过名称搜索到本账号</span>
              </strong>
              <div class="weui-desktop-setting__item__extra">
                <label class="weui-desktop-switch">
                  <input class="weui-desktop-switch__input" type="checkbox" checked>
                  <div class="weui-desktop-switch__box"></div>
                </label>
              </div>
            </div>
          </div>
        </li>
      </section>
    `, { runScripts: 'outside-only', url: 'https://mp.weixin.qq.com/cgi-bin/settingpage' });

    expect(dom.window.eval(USER_INFO_EXTRACT_SCRIPT).sections[0].fields).toEqual([
      { label: '隐私设置', value: true },
    ]);
  });

  it('removes a WeChat popover from a field label and value', () => {
    const dom = new JSDOM(`
      <section class="weui-desktop-panel">
        <h3 class="weui-desktop-panel__title">功能设置</h3>
        <li class="weui-desktop-setting__item">
          <label class="weui-desktop-setting__item__label">
            JS接口安全域名
            <span class="weui-desktop-popover__wrp">
              <i class="icon-svg-common-ask"></i>
              <span class="weui-desktop-popover">帮助说明</span>
            </span>
          </label>
          <div class="weui-desktop-setting__item__info">
            <span>未设置</span>
            <span class="weui-desktop-popover">设置后的接口说明</span>
          </div>
        </li>
      </section>
    `, { runScripts: 'outside-only', url: 'https://mp.weixin.qq.com/cgi-bin/settingpage' });

    expect(dom.window.eval(USER_INFO_EXTRACT_SCRIPT).sections[0].fields).toEqual([
      { label: 'JS接口安全域名', value: '未设置' },
    ]);
  });

  it('keeps only the primary paragraph from a current WeChat value container', () => {
    const dom = new JSDOM(`
      <section class="weui-desktop-panel">
        <h3 class="weui-desktop-panel__title">功能设置</h3>
        <li class="weui-desktop-setting__item">
          <label class="weui-desktop-setting__item__label">JS接口安全域名</label>
          <strong class="weui-desktop-setting__item__info js_container">
            <p>未设置</p>
            <p>设置JS接口安全域名后，开发者可在该域名下调用微信开放的JS接口</p>
          </strong>
          <a>设置</a>
        </li>
      </section>
    `, { runScripts: 'outside-only', url: 'https://mp.weixin.qq.com/cgi-bin/settingpage' });

    expect(dom.window.eval(USER_INFO_EXTRACT_SCRIPT).sections[0].fields).toEqual([
      { label: 'JS接口安全域名', value: '未设置' },
    ]);
  });

  it('keeps direct business text together with its inline type', () => {
    const dom = new JSDOM(`
      <section class="weui-desktop-panel">
        <h3 class="weui-desktop-panel__title">公开信息</h3>
        <li class="weui-desktop-setting__item">
          <label class="weui-desktop-setting__item__label">主体信息</label>
          <strong class="weui-desktop-setting__item__info">谢** <span>(个人)</span></strong>
          <a>详情</a>
        </li>
      </section>
    `, { runScripts: 'outside-only', url: 'https://mp.weixin.qq.com/cgi-bin/settingpage' });

    expect(dom.window.eval(USER_INFO_EXTRACT_SCRIPT).sections[0].fields).toEqual([
      { label: '主体信息', value: '谢** (个人)' },
    ]);
  });

  it('returns false for a disabled ARIA switch field', () => {
    const dom = new JSDOM(`
      <section class="setting_area">
        <h3>功能设置</h3>
        <div class="setting_item">
          <div class="frm_label">图片水印</div>
          <div class="frm_controls">
            <span>使用账号名称作为水印</span>
            <span role="switch" aria-checked="false"></span>
          </div>
        </div>
      </section>
    `, { runScripts: 'outside-only', url: 'https://mp.weixin.qq.com/cgi-bin/settingpage' });

    expect(dom.window.eval(USER_INFO_EXTRACT_SCRIPT).sections[0].fields).toEqual([
      { label: '图片水印', value: false },
    ]);
  });

  it('falls back within a known row when label and value classes changed', () => {
    const dom = new JSDOM(`
      <section class="setting_area">
        <h3>公开信息</h3>
        <div class="setting_item">
          <span class="opaque-label">公众号ID</span>
          <span class="opaque-value">gh_123456</span>
          <a href="javascript:;">设置</a>
        </div>
      </section>
    `, { runScripts: 'outside-only', url: 'https://mp.weixin.qq.com/cgi-bin/settingpage' });

    expect(dom.window.eval(USER_INFO_EXTRACT_SCRIPT).sections[0].fields).toEqual([
      { label: '公众号ID', value: 'gh_123456' },
    ]);
  });

  it('uses generic row text when only the known label selector remains', () => {
    const dom = new JSDOM(`
      <section class="setting_area">
        <h3>第三方平台</h3>
        <div class="setting_item">
          <span class="frm_label">第三方平台名称</span>
          <span class="opaque-value">示例平台</span>
        </div>
      </section>
    `, { runScripts: 'outside-only', url: 'https://mp.weixin.qq.com/cgi-bin/settingpage' });

    expect(dom.window.eval(USER_INFO_EXTRACT_SCRIPT).sections[0].fields).toEqual([
      { label: '第三方平台名称', value: '示例平台' },
    ]);
  });

  it('keeps an empty authorization table without treating its header as data', () => {
    const dom = new JSDOM(`
      <section class="setting_area">
        <h3>第三方平台</h3>
        <table>
          <thead>
            <tr>
              <th>第三方平台名称</th>
              <th>已授权权限</th>
              <th>授权时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </section>
    `, { runScripts: 'outside-only', url: 'https://mp.weixin.qq.com/cgi-bin/settingpage' });

    expect(dom.window.eval(USER_INFO_EXTRACT_SCRIPT)).toEqual({
      available: true,
      sections: [{ label: '第三方平台', fields: [], empty: true }],
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
    expect(result[2].data.sections[0].fields[0].value).toBe('0');
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

  it('uses a trusted tab anchor as the navigation source', async () => {
    const page = {
      evaluate: vi.fn()
        .mockResolvedValueOnce({
          selected: true,
          disabled: false,
          href: 'https://mp.weixin.qq.com/cgi-bin/settingpage?t=setting/index&token=42',
        })
        .mockResolvedValueOnce(RAW_ACCOUNT_DETAILS)
        .mockResolvedValueOnce({ selected: false, disabled: true, href: null })
        .mockResolvedValueOnce({ selected: false, disabled: true, href: null }),
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
    };

    await collectUserInfoTabs(page, { settle: 2 });

    expect(page.goto).toHaveBeenCalledWith(
      'https://mp.weixin.qq.com/cgi-bin/settingpage?t=setting/index&token=42',
    );
  });

  it('allows a token-scoped same-origin tab route outside settingpage', async () => {
    const target = 'https://mp.weixin.qq.com/advanced/advanced?action=table&token=42';
    const page = {
      evaluate: vi.fn()
        .mockResolvedValueOnce({ selected: true, disabled: false, href: target })
        .mockResolvedValueOnce(RAW_ACCOUNT_DETAILS)
        .mockResolvedValueOnce({ selected: false, disabled: true, href: null })
        .mockResolvedValueOnce({ selected: false, disabled: true, href: null }),
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
    };

    await collectUserInfoTabs(page, { settle: 2 });

    expect(page.goto).toHaveBeenCalledWith(target);
  });

  it('rejects a foreign tab navigation target', async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue({
        selected: true,
        disabled: false,
        href: 'https://evil.test/cgi-bin/settingpage?token=secret',
      }),
      goto: vi.fn(),
      wait: vi.fn(),
    };

    await expect(collectUserInfoTabs(page, { settle: 2 }))
      .rejects.toThrow(CommandExecutionError);
    expect(page.goto).not.toHaveBeenCalled();
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
