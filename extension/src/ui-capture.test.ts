// M-UI-1 纯归一单测:parseUiEvent 校验/夹紧/防御性剥离 raw value。
import { describe, it, expect } from 'vitest';
import { parseUiEvent, UI_LISTENER_SOURCE, UI_BINDING_NAME } from './ui-capture';

describe('parseUiEvent', () => {
  it('正常 click 事件 → 归一', () => {
    const ev = parseUiEvent(JSON.stringify({ type: 'click', ts: 100, selector: '#btn', tag: 'button', role: 'button', text: 'Search' }));
    expect(ev).toMatchObject({ type: 'click', ts: 100, selector: '#btn', tag: 'button', role: 'button', text: 'Search' });
  });

  it('input 只留 valueShape,**剥离任何 raw value**(防御性)', () => {
    const ev = parseUiEvent(JSON.stringify({ type: 'input', selector: '#q', tag: 'input', value: 'secret-password', valueShape: { len: 15, kind: 'text' } }));
    expect(ev).not.toBeNull();
    expect((ev as unknown as Record<string, unknown>).value).toBeUndefined(); // raw value 不入
    expect(ev!.valueShape).toEqual({ len: 15, kind: 'text' });
  });

  it('password 字段(无 valueShape)→ 仍记录但无值信息', () => {
    const ev = parseUiEvent(JSON.stringify({ type: 'input', selector: '#pw', tag: 'input' }));
    expect(ev).not.toBeNull();
    expect(ev!.valueShape).toBeUndefined();
  });

  it('非法 type / 缺 selector / 坏 JSON → null', () => {
    expect(parseUiEvent(JSON.stringify({ type: 'scroll', selector: '#x' }))).toBeNull();
    expect(parseUiEvent(JSON.stringify({ type: 'click' }))).toBeNull();
    expect(parseUiEvent('not json')).toBeNull();
  });

  it('夹紧超长字符串 + valueShape.kind 非法回落 text + len 边界', () => {
    const long = 'a'.repeat(1000);
    const ev = parseUiEvent(JSON.stringify({ type: 'click', selector: '#' + long, tag: long, text: long, valueShape: { len: -5, kind: 'weird' } }));
    expect(ev!.selector.length).toBe(300);
    expect(ev!.tag.length).toBe(24);
    expect(ev!.text!.length).toBe(80);
    expect(ev!.valueShape).toEqual({ len: 0, kind: 'text' });
  });

  it('keydown 保留 key', () => {
    expect(parseUiEvent(JSON.stringify({ type: 'keydown', selector: '#q', tag: 'input', key: 'Enter' }))!.key).toBe('Enter');
  });

  it('注入脚本源含 binding 名 + 防重复装守卫 + password 跳值 + 导航 hook', () => {
    expect(UI_LISTENER_SOURCE).toContain(UI_BINDING_NAME);
    expect(UI_LISTENER_SOURCE).toContain('__bycli_ui_installed');
    expect(UI_LISTENER_SOURCE).toContain("t.type==='password'");
    expect(UI_LISTENER_SOURCE).toContain("type:'navigate'");
    expect(UI_LISTENER_SOURCE).toContain('history.pushState');
    expect(UI_LISTENER_SOURCE).toContain('hashchange');
  });

  it('navigate:无 selector,取 url + 脱敏 token,无 url → null', () => {
    const ev = parseUiEvent(JSON.stringify({ type: 'navigate', ts: 500, url: 'https://x.com/search?q=apple&token=eyJabc.def.ghi' }));
    expect(ev).toMatchObject({ type: 'navigate', ts: 500, selector: '', tag: 'document' });
    expect(ev!.url).toContain('q=apple');     // 种子保留
    expect(ev!.url).toContain('token=***');    // token 脱敏
    expect(ev!.url).not.toContain('eyJabc');
    expect(parseUiEvent(JSON.stringify({ type: 'navigate', ts: 1 }))).toBeNull(); // 无 url
  });
});
