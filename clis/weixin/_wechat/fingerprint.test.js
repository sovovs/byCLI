import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';
import { captureSearchBizFingerprint } from './fingerprint.js';

function makePage({ submitted = true, fingerprint = 'fp-value', failPoll = false } = {}) {
  let reads = 0;
  return {
    evaluate: vi.fn(async (_callback, argument) => {
      if (argument?.operation === 'install') return { installed: true };
      if (argument?.operation === 'open-picker') return { dialogVisible: true, entryClicked: false };
      if (argument?.operation === 'submit-search') {
        return submitted ? { submitted: true } : { submitted: false, reason: 'input', inputCount: 0 };
      }
      if (argument?.operation === 'read') {
        reads += 1;
        if (failPoll) throw new Error('poll failed');
        return reads > 1 ? fingerprint : null;
      }
      if (argument?.operation === 'cleanup') return undefined;
      throw new Error('unexpected operation');
    }),
    wait: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeRealPage({
  triggerRequest = true,
  trustedContainer = true,
  includeUnrelatedButton = false,
  requestOrigin = 'https://mp.weixin.qq.com',
} = {}) {
  const originalFetch = vi.fn(async () => ({ ok: true }));
  const originalOpen = vi.fn();
  class FakeXHR {}
  FakeXHR.prototype.open = originalOpen;
  const scope = {
    textContent: '插入账号名片',
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
    querySelectorAll: selector => {
      if (selector.includes('input')) return [input];
      return selector.includes('button') ? [button] : [];
    },
  };
  const input = {
    value: '',
    focus: vi.fn(),
    dispatchEvent: vi.fn(event => {
      if (triggerRequest && event.type === 'keydown' && event.key === 'Enter') {
        window.fetch(`${requestOrigin}/cgi-bin/searchbiz?action=search_biz&fingerprint=${encodeURIComponent(input.value)}-fp&token=token-secret`);
      }
    }),
    closest: vi.fn(() => trustedContainer ? scope : null),
    getBoundingClientRect: () => ({ width: 100, height: 24 }),
  };
  const button = {
    textContent: '搜索',
    getBoundingClientRect: () => ({ width: 40, height: 24 }),
    click: vi.fn(() => {
      if (triggerRequest) window.fetch(`${requestOrigin}/cgi-bin/searchbiz?action=search_biz&fingerprint=${encodeURIComponent(input.value)}-fp&token=token-secret`);
    }),
  };
  vi.stubGlobal('window', {
    location: { href: 'https://mp.weixin.qq.com/cgi-bin/appmsg' },
    fetch: originalFetch,
    XMLHttpRequest: FakeXHR,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  });
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('HTMLInputElement', class HTMLInputElement {});
  vi.stubGlobal('Event', class Event { constructor(type, options) { this.type = type; this.options = options; } });
  vi.stubGlobal('KeyboardEvent', class KeyboardEvent {
    constructor(type, options = {}) { this.type = type; this.key = options.key; this.code = options.code; }
  });
  vi.stubGlobal('document', {
    querySelectorAll: selector => {
      if (selector.includes('[role="dialog"]') || selector.includes('.weui-desktop-dialog')) return [scope];
      if (selector.startsWith('input')) return [input];
      return includeUnrelatedButton && selector.includes('button') ? [button] : [];
    },
  });
  const page = {
    evaluate: vi.fn(async (callback, argument) => callback(argument)),
    wait: vi.fn(async () => undefined),
  };
  return { page, originalFetch, originalOpen };
}

function makeAccountCardPage({
  triggerRequest = true,
  requestTrigger = 'enter',
  entryVisible = true,
  directEntryInToolbar = false,
  entryInOverflow = false,
  wechatEditorOverflow = false,
  genericDialog = false,
  nestedDialogMatches = false,
  ambiguousGenericSearchTargets = false,
  networkOnlyCapture = false,
  requestOrigin = 'https://mp.weixin.qq.com',
  requiresNativeInput = false,
  revealEntryAfterWait = false,
  manualDialogAfterFocus = false,
  inputCount = 1,
} = {}) {
  const originalFetch = vi.fn(async () => ({ ok: true }));
  const originalOpen = vi.fn();
  class FakeXHR {}
  FakeXHR.prototype.open = originalOpen;
  let dialogVisible = false;
  let entryIsVisible = entryVisible;
  let entryClicks = 0;
  let insertClicks = 0;
  let searchClicks = 0;
  let insertOverflowClicks = 0;
  let formatOverflowClicks = 0;
  let weixinOverflowClicks = 0;
  let overflowMenuVisible = false;
  let weixinOverflowMenuVisible = false;
  let requestTriggered = false;
  let componentQuery = '';
  const networkEntries = [];
  const operations = [];
  const issueSearchRequest = () => {
    const effectiveQuery = requiresNativeInput ? componentQuery : input.value;
    const url = `${requestOrigin}/cgi-bin/searchbiz?action=search_biz&fingerprint=${encodeURIComponent(effectiveQuery)}-fp`;
    if (networkOnlyCapture) networkEntries.push({ method: 'GET', url });
    else window.fetch(url);
  };
  const input = {
    value: '',
    focus: vi.fn(),
    getBoundingClientRect: () => ({ width: dialogVisible ? 300 : 0, height: dialogVisible ? 32 : 0 }),
    dispatchEvent: vi.fn(event => {
      if (triggerRequest && ['enter', 'enter-after-click'].includes(requestTrigger)
          && !requestTriggered && event.type === 'keydown' && event.key === 'Enter') {
        requestTriggered = true;
        issueSearchRequest();
      }
    }),
    closest: vi.fn(() => dialog),
  };
  const insertButton = {
    textContent: '插入',
    getBoundingClientRect: () => ({ width: dialogVisible ? 60 : 0, height: dialogVisible ? 30 : 0 }),
    click: vi.fn(() => { insertClicks += 1; }),
  };
  const searchButton = {
    textContent: '',
    className: 'weui-desktop-search__btn weui-desktop-icon-button weui-desktop-icon-button_stated',
    getAttribute: name => name === 'aria-label' ? '搜索' : null,
    getBoundingClientRect: () => ({ width: dialogVisible ? 32 : 0, height: dialogVisible ? 32 : 0 }),
    click: vi.fn(() => {
      searchClicks += 1;
      if (triggerRequest && requestTrigger === 'click' && !requestTriggered) {
        requestTriggered = true;
        issueSearchRequest();
      }
    }),
  };
  const dialog = {
    textContent: '插入账号名片',
    getBoundingClientRect: () => ({ width: dialogVisible ? 800 : 0, height: dialogVisible ? 600 : 0 }),
    querySelector: selector => selector === '.weui-desktop-search__btn' && dialogVisible
      ? searchButton
      : null,
    querySelectorAll: selector => {
      if (selector.includes('input')) return dialogVisible ? Array.from({ length: inputCount }, () => input) : [];
      if (selector.includes('search') || selector.includes('aria-label') || selector.includes('title')) {
        if (dialogVisible && ambiguousGenericSearchTargets) return [searchButton, insertButton];
        return dialogVisible && ['click', 'enter-after-click'].includes(requestTrigger) ? [searchButton] : [];
      }
      if (selector.includes('button')) return dialogVisible ? [insertButton] : [];
      return [];
    },
  };
  const dialogTitle = {
    textContent: '插入账号名片',
    parentElement: dialog,
    getBoundingClientRect: () => ({ width: dialogVisible ? 160 : 0, height: dialogVisible ? 32 : 0 }),
  };
  const dialogHeader = {
    textContent: '插入账号名片',
    getBoundingClientRect: () => ({ width: dialogVisible ? 800 : 0, height: dialogVisible ? 64 : 0 }),
  };
  const dialogInner = {
    textContent: '插入账号名片',
    getBoundingClientRect: () => ({ width: dialogVisible ? 800 : 0, height: dialogVisible ? 600 : 0 }),
  };
  const entry = {
    textContent: '账号名片',
    getBoundingClientRect: () => ({
      width: (entryInOverflow ? overflowMenuVisible : entryIsVisible) ? 80 : 0,
      height: (entryInOverflow ? overflowMenuVisible : entryIsVisible) ? 32 : 0,
    }),
    click: vi.fn(() => { entryClicks += 1; dialogVisible = true; }),
    closest: vi.fn(() => entry),
  };
  const insertOverflow = {
    textContent: '…',
    className: 'toolbar-more',
    getAttribute: name => name === 'aria-label' ? '更多' : null,
    getBoundingClientRect: () => ({ width: 32, height: 32, top: 20 }),
    click: vi.fn(() => { insertOverflowClicks += 1; overflowMenuVisible = true; }),
    closest: vi.fn(() => insertOverflow),
  };
  const formatOverflow = {
    textContent: '…',
    className: 'toolbar-more',
    getAttribute: name => name === 'aria-label' ? '更多' : null,
    getBoundingClientRect: () => ({ width: 32, height: 32, top: 90 }),
    click: vi.fn(() => { formatOverflowClicks += 1; }),
    closest: vi.fn(() => formatOverflow),
  };
  const insertToolbar = {
    textContent: `图片 视频 音频 超链接 小程序 ${directEntryInToolbar ? '账号名片' : '…'}`,
    className: 'insert-toolbar',
    getBoundingClientRect: () => ({ width: 900, height: 48, top: 0 }),
    querySelectorAll: () => [insertOverflow],
    contains: element => element === insertOverflow,
  };
  if (directEntryInToolbar) entry.parentElement = insertToolbar;
  const formatToolbar = {
    textContent: '17px B I U …',
    className: 'format-toolbar',
    getBoundingClientRect: () => ({ width: 900, height: 48, top: 70 }),
    querySelectorAll: () => [formatOverflow],
    contains: element => element === formatOverflow,
  };
  const overflowMenu = {
    textContent: '视频号 账号名片 问答 礼物',
    className: 'toolbar-dropdown-menu',
    getBoundingClientRect: () => ({
      width: overflowMenuVisible ? 180 : 0,
      height: overflowMenuVisible ? 240 : 0,
      top: 48,
    }),
    querySelectorAll: () => overflowMenuVisible ? [entry] : [],
    contains: element => element === entry,
  };
  const weixinProfileEntry = {
    id: 'js_editor_insertProfile',
    textContent: '账号名片',
    getBoundingClientRect: () => ({
      width: weixinOverflowMenuVisible ? 80 : 0,
      height: weixinOverflowMenuVisible ? 32 : 0,
      top: 48,
    }),
    click: vi.fn(() => { entryClicks += 1; dialogVisible = true; }),
    closest: vi.fn(() => weixinProfileEntry),
  };
  const weixinOverflowMenu = {
    className: 'tpl_dropdown_menu editor_showmore_dropdown_menu js_more_plugins_menu',
    getBoundingClientRect: () => ({
      width: weixinOverflowMenuVisible ? 180 : 0,
      height: weixinOverflowMenuVisible ? 240 : 0,
      top: 48,
    }),
    querySelectorAll: selector => selector.includes('#js_editor_insertProfile')
      || selector.includes('li') ? [weixinProfileEntry] : [],
    contains: element => element === weixinProfileEntry,
  };
  const weixinOverflow = {
    id: 'editor_showmore',
    className: 'tpl_item tpl_item_dropdown jsInsertIcon more',
    getBoundingClientRect: () => ({ width: 32, height: 32, top: 20 }),
    querySelectorAll: selector => selector.includes('.editor_showmore_dropdown_menu')
      ? [weixinOverflowMenu] : [],
    click: vi.fn(() => { weixinOverflowClicks += 1; weixinOverflowMenuVisible = true; }),
    closest: vi.fn(() => weixinOverflow),
  };
  vi.stubGlobal('window', {
    location: { href: 'https://mp.weixin.qq.com/cgi-bin/appmsg' },
    fetch: originalFetch,
    XMLHttpRequest: FakeXHR,
    getComputedStyle: element => ({
      display: element.getBoundingClientRect().width > 0 ? 'block' : 'none',
      visibility: 'visible', opacity: '1',
    }),
  });
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('HTMLInputElement', class HTMLInputElement {});
  vi.stubGlobal('Event', class Event { constructor(type) { this.type = type; } });
  vi.stubGlobal('KeyboardEvent', class KeyboardEvent {
    constructor(type, options = {}) { this.type = type; this.key = options.key; this.code = options.code; }
  });
  vi.stubGlobal('document', {
    getElementsByClassName: className => className === 'weui-desktop-search__btn weui-desktop-icon-button weui-desktop-icon-button_stated'
      && dialogVisible ? [searchButton] : [],
    querySelectorAll: selector => {
      if (selector === '.weui-desktop-dialog__wrp.profile_dialog') return dialogVisible ? [dialog] : [];
      if (selector === '#editor_showmore') return wechatEditorOverflow ? [weixinOverflow] : [];
      if (selector.includes('[role="dialog"]') || selector.includes('.weui-desktop-dialog')) {
        if (nestedDialogMatches) return dialogVisible ? [dialog, dialogInner, dialogHeader, dialogTitle] : [];
        return genericDialog ? [] : [dialog];
      }
      if (genericDialog && selector.includes('[class*="title"]')) return [dialogTitle];
      if (entryInOverflow && selector.includes('[class*="toolbar"]')) return [insertToolbar, formatToolbar];
      if (directEntryInToolbar && selector.includes('span') && selector.includes('div')) return [entry];
      if (entryInOverflow && (selector.includes('[role="menu"]') || selector.includes('dropdown') || selector.includes('popover'))) {
        return [overflowMenu];
      }
      if (wechatEditorOverflow && (selector.includes('[role="menu"]') || selector.includes('dropdown') || selector.includes('popover'))) {
        return [weixinOverflowMenu];
      }
      if (selector.includes('header') || selector.includes('[role="banner"]')) {
        return entryInOverflow || directEntryInToolbar || wechatEditorOverflow ? [] : [entry];
      }
      if (selector.startsWith('input')) return dialogVisible ? [input] : [];
      return [];
    },
  });
  const page = {
    evaluate: vi.fn(async (callback, argument) => {
      operations.push(argument.operation);
      return callback(argument);
    }),
    wait: vi.fn(async () => { if (revealEntryAfterWait) entryIsVisible = true; }),
    focusWindow: vi.fn(async () => { if (manualDialogAfterFocus) dialogVisible = true; }),
    fillText: vi.fn(async (_selector, text) => {
      if (inputCount !== 1) throw new Error(`selector matched ${inputCount} inputs`);
      input.value = text;
      componentQuery = text;
      return { filled: true, verified: true, actual: text };
    }),
    click: vi.fn(async () => {
      searchButton.click();
      return { matches_n: 1, match_level: 'exact' };
    }),
    focus: vi.fn(async () => {
      input.focus();
      return { focused: true, matches_n: 1, match_level: 'exact' };
    }),
    pressKey: vi.fn(async key => {
      if (triggerRequest && ['enter', 'enter-after-click'].includes(requestTrigger)
          && !requestTriggered && key === 'Enter') {
        requestTriggered = true;
        issueSearchRequest();
      }
    }),
    startNetworkCapture: vi.fn(async () => true),
    readNetworkCapture: vi.fn(async () => networkEntries.splice(0)),
  };
  return {
    page, operations,
    entryClicks: () => entryClicks,
    insertClicks: () => insertClicks,
    searchClicks: () => searchClicks,
    insertOverflowClicks: () => insertOverflowClicks,
    formatOverflowClicks: () => formatOverflowClicks,
    weixinOverflowClicks: () => weixinOverflowClicks,
    submittedQuery: () => input.value,
    originalFetch, originalOpen,
  };
}

describe('captureSearchBizFingerprint', () => {
  it('opens the header account-card picker before submitting its dialog search', async () => {
    const fixture = makeAccountCardPage();
    await expect(captureSearchBizFingerprint(fixture.page, '前端之神', 1_000))
      .resolves.toBe('前端之神-fp');
    expect(fixture.operations.indexOf('install')).toBeLessThan(fixture.operations.indexOf('open-picker'));
    expect(fixture.entryClicks()).toBe(1);
    expect(fixture.submittedQuery()).toBe('前端之神');
    expect(fixture.insertClicks()).toBe(0);
  });

  it('opens a generic account-card element inside the trusted insert toolbar', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({ directEntryInToolbar: true });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });

    await expect(captureSearchBizFingerprint(fixture.page, '前端之神', 1_000))
      .resolves.toBe('前端之神-fp');
    expect(fixture.entryClicks()).toBe(1);
    expect(fixture.insertClicks()).toBe(0);
  });

  it('recognizes the account-card dialog from its title when the container has no dialog semantics', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({ genericDialog: true });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });

    await expect(captureSearchBizFingerprint(fixture.page, '前端之神', 1_000))
      .resolves.toBe('前端之神-fp');
    expect(fixture.submittedQuery()).toBe('前端之神');
    expect(fixture.insertClicks()).toBe(0);
  });

  it('uses the unique profile wrapper when nested dialog elements also contain the title', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({ nestedDialogMatches: true });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });

    await expect(captureSearchBizFingerprint(fixture.page, '前端之神', 1_000))
      .resolves.toBe('前端之神-fp');
    expect(fixture.submittedQuery()).toBe('前端之神');
  });

  it('opens account card from the insert-toolbar overflow without clicking the formatting overflow', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({ entryInOverflow: true });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });

    await expect(captureSearchBizFingerprint(fixture.page, '前端之神', 1_000))
      .resolves.toBe('前端之神-fp');
    expect(fixture.insertOverflowClicks()).toBe(1);
    expect(fixture.formatOverflowClicks()).toBe(0);
    expect(fixture.entryClicks()).toBe(1);
    expect(fixture.insertClicks()).toBe(0);
  });

  it('opens account card through the WeChat editor show-more menu', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({ wechatEditorOverflow: true });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });

    await expect(captureSearchBizFingerprint(fixture.page, '前端之神', 1_000))
      .resolves.toBe('前端之神-fp');
    expect(fixture.weixinOverflowClicks()).toBe(1);
    expect(fixture.entryClicks()).toBe(1);
    expect(fixture.formatOverflowClicks()).toBe(0);
    expect(fixture.insertClicks()).toBe(0);
  });

  it('clicks the dialog search icon when Enter does not submit the account search', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({ requestTrigger: 'click' });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });

    await expect(captureSearchBizFingerprint(fixture.page, '前端之神', 1_000))
      .resolves.toBe('前端之神-fp');
    expect(fixture.searchClicks()).toBe(1);
    expect(fixture.insertClicks()).toBe(0);
  });

  it('falls back to Enter when clicking the search icon does not issue searchbiz', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({ requestTrigger: 'enter-after-click' });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });

    await expect(captureSearchBizFingerprint(fixture.page, '前端之神', 1_000))
      .resolves.toBe('前端之神-fp');
    expect(fixture.searchClicks()).toBe(1);
    expect(fixture.submittedQuery()).toBe('前端之神');
  });

  it('clicks the exact account-card search button when generic search selectors are ambiguous', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({
      requestTrigger: 'click',
      ambiguousGenericSearchTargets: true,
    });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });

    await expect(captureSearchBizFingerprint(fixture.page, '前端之神', 1_000))
      .resolves.toBe('前端之神-fp');
    expect(fixture.page.click).not.toHaveBeenCalled();
    expect(fixture.searchClicks()).toBe(1);
  });

  it('captures fingerprint from the browser network layer when page fetch hooks cannot observe it', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({ requestTrigger: 'click', networkOnlyCapture: true });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });

    await expect(captureSearchBizFingerprint(fixture.page, '前端之神', 1_000))
      .resolves.toBe('前端之神-fp');
    expect(fixture.page.startNetworkCapture).toHaveBeenCalledWith('/cgi-bin/searchbiz');
    expect(fixture.page.readNetworkCapture).toHaveBeenCalled();
  });

  it('ignores matching searchbiz paths captured from a different origin', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({
      requestTrigger: 'click',
      networkOnlyCapture: true,
      requestOrigin: 'https://evil.test',
    });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });

    await expect(captureSearchBizFingerprint(fixture.page, '前端之神', 200))
      .rejects.toBeInstanceOf(TimeoutError);
  });

  it('uses native text input before DOM click when the component ignores synthetic value events', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({
      requestTrigger: 'click',
      networkOnlyCapture: true,
      requiresNativeInput: true,
    });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });

    await expect(captureSearchBizFingerprint(fixture.page, '前端之神', 1_000))
      .resolves.toBe('前端之神-fp');
    expect(fixture.page.fillText).toHaveBeenCalledWith(
      '.profile_dialog input.weui-desktop-form__input[placeholder="请输入账号名称或账号ID"]',
      '前端之神',
    );
    expect(fixture.searchClicks()).toBe(1);
  });

  it('reports non-sensitive click and capture diagnostics on fingerprint timeout', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({ triggerRequest: false, requestTrigger: 'click' });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });

    const error = await captureSearchBizFingerprint(fixture.page, '前端之神', 200).catch(value => value);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.hint).toContain('networkCapture=browser');
    expect(error.hint).toContain('buttonFound=true');
    expect(error.hint).toContain('clickInvoked=true');
    expect(error.hint).not.toContain('前端之神');
  });

  it('focuses the window and continues after the user manually opens the dialog', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({ entryVisible: false, manualDialogAfterFocus: true });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });
    await expect(captureSearchBizFingerprint(fixture.page, '微信派', 6_000)).resolves.toBe('微信派-fp');
    expect(fixture.page.focusWindow).toHaveBeenCalledTimes(1);
    expect(fixture.entryClicks()).toBe(0);
  });

  it('waits for delayed editor rendering before clicking the account-card entry', async () => {
    const fixture = makeAccountCardPage({ entryVisible: false, revealEntryAfterWait: true });
    await expect(captureSearchBizFingerprint(fixture.page, '微信派', 1_000)).resolves.toBe('微信派-fp');
    expect(fixture.page.wait).toHaveBeenCalled();
    expect(fixture.entryClicks()).toBe(1);
  });

  it('rejects an ambiguous account-card dialog input', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fixture = makeAccountCardPage({ inputCount: 2 });
    fixture.page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });
    await expect(captureSearchBizFingerprint(fixture.page, '微信派', 1_000))
      .rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('polls with page.wait seconds and always cleans up after success', async () => {
    const page = makePage();
    await expect(captureSearchBizFingerprint(page, '微信派', 1_000)).resolves.toBe('fp-value');
    expect(page.wait).toHaveBeenCalledWith(0.1);
    expect(page.evaluate.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ operation: 'cleanup' }));
  });

  it('reports a page-change hint when the account-card dialog has no search input', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const page = makePage({ submitted: false });
    page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });
    const error = await captureSearchBizFingerprint(page, '微信派', 200).catch(value => value);
    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(error.hint).toMatch(/page|layout|control/i);
    expect(page.evaluate.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ operation: 'cleanup' }));
  });

  it('maps polling failure to CommandExecutionError and cleans up', async () => {
    const page = makePage({ failPoll: true });
    await expect(captureSearchBizFingerprint(page, '微信派')).rejects.toBeInstanceOf(CommandExecutionError);
    expect(page.evaluate.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ operation: 'cleanup' }));
  });

  it('times out with TimeoutError and cleans up', async () => {
    let now = 0;
    const page = makePage({ fingerprint: null });
    page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await expect(captureSearchBizFingerprint(page, '微信派', 200)).rejects.toBeInstanceOf(TimeoutError);
    expect(page.evaluate.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ operation: 'cleanup' }));
    vi.restoreAllMocks();
  });

  it('captures a matching request in a real page context and restores both wrappers', async () => {
    const { page, originalFetch, originalOpen } = makeRealPage();
    let capturedState;
    page.evaluate.mockImplementation(async (callback, argument) => {
      const result = callback(argument);
      if (argument.operation === 'install') {
        const stateKey = Object.getOwnPropertyNames(window).find(key => key.startsWith('__bycliWechat'));
        capturedState = window[stateKey];
      }
      return result;
    });
    await expect(captureSearchBizFingerprint(page, '微信派', 1_000)).resolves.toBe('微信派-fp');
    expect(capturedState).toEqual({ fingerprint: '微信派-fp' });
    expect(JSON.stringify(capturedState)).not.toMatch(/searchbiz|token-secret|cookie/i);
    expect(window.fetch).toBe(originalFetch);
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(Object.getOwnPropertyNames(window).some(key => key.startsWith('__bycliWechat'))).toBe(false);
  });

  it('ignores matching searchbiz paths from another origin in the page hook', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { page } = makeRealPage({ requestOrigin: 'https://evil.test' });
    page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });

    await expect(captureSearchBizFingerprint(page, '微信派', 200))
      .rejects.toBeInstanceOf(TimeoutError);
  });

  it('restores real wrappers and deletes temporary state after timeout', async () => {
    let now = 0;
    const { page, originalFetch, originalOpen } = makeRealPage({ triggerRequest: false });
    page.wait.mockImplementation(async seconds => { now += seconds * 1_000; });
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await expect(captureSearchBizFingerprint(page, '微信派', 100)).rejects.toBeInstanceOf(TimeoutError);
    expect(window.fetch).toBe(originalFetch);
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(Object.getOwnPropertyNames(window).some(key => key.startsWith('__bycliWechat'))).toBe(false);
  });

  it('executes real cleanup after a polling error without retaining request secrets', async () => {
    const { page, originalFetch, originalOpen } = makeRealPage({ triggerRequest: false });
    page.evaluate.mockImplementation(async (callback, argument) => {
      if (argument.operation === 'read') {
        throw new Error('trigger failed after https://mp.weixin.qq.com/cgi-bin/searchbiz?token=token-secret&fingerprint=fp-secret');
      }
      return callback(argument);
    });

    const error = await captureSearchBizFingerprint(page, '微信派', 1_000).catch(value => value);

    expect(error).toBeInstanceOf(CommandExecutionError);
    expect(window.fetch).toBe(originalFetch);
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(Object.getOwnPropertyNames(window).some(key => key.startsWith('__bycliWechat'))).toBe(false);
    expect(JSON.stringify(window)).not.toMatch(/searchbiz|token-secret|fp-secret|cookie/i);
    expect(page.evaluate.mock.calls.at(-1)[1]).toEqual(expect.objectContaining({ operation: 'cleanup' }));
    expect(`${error.message} ${error.hint ?? ''}`).not.toMatch(/searchbiz|token-secret|fp-secret|cookie/i);
  });

  it('serializes concurrent captures on the same page and releases ownership', async () => {
    const { page, originalFetch, originalOpen } = makeRealPage();
    await expect(Promise.all([
      captureSearchBizFingerprint(page, 'first', 1_000),
      captureSearchBizFingerprint(page, 'second', 1_000),
    ])).resolves.toEqual(['first-fp', 'second-fp']);
    expect(window.fetch).toBe(originalFetch);
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(Object.getOwnPropertyNames(window).some(key => key.startsWith('__bycliWechat'))).toBe(false);
  });

  it('does not let a failed capture block the next capture on the same page', async () => {
    const { page, originalFetch, originalOpen } = makeRealPage();
    let failNextRead = true;
    page.evaluate.mockImplementation(async (callback, argument) => {
      if (argument.operation === 'read' && failNextRead) {
        failNextRead = false;
        throw new Error('bridge failed');
      }
      return callback(argument);
    });
    const failed = captureSearchBizFingerprint(page, 'failed', 1_000);
    const succeeded = captureSearchBizFingerprint(page, 'recovered', 1_000);
    await expect(failed).rejects.toBeInstanceOf(CommandExecutionError);
    await expect(succeeded).resolves.toBe('recovered-fp');
    expect(window.fetch).toBe(originalFetch);
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(Object.getOwnPropertyNames(window).some(key => key.startsWith('__bycliWechat'))).toBe(false);
  });

  it('uses the button in the same trusted picker container, not a global search button', async () => {
    const { page } = makeRealPage({ includeUnrelatedButton: true });
    await expect(captureSearchBizFingerprint(page, 'dialog', 1_000)).resolves.toBe('dialog-fp');
  });

  it('does not depend on an unrelated global search button', async () => {
    const { page } = makeRealPage({ trustedContainer: false, includeUnrelatedButton: true });
    await expect(captureSearchBizFingerprint(page, 'dialog', 1_000)).resolves.toBe('dialog-fp');
  });
});
