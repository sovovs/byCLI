// UI 节点录制(第二阶段 M-UI-1):录用户真实交互(click/input/submit/keydown)。
// 经 CDP Runtime.addBinding 暴露 window.__bycli_ui,注入只读监听脚本调它 → Runtime.bindingCalled
// 回传到扩展 → ring-cap buffer → ui-capture-read 读窗冻结(复刻 network-capture 模式)。
//
// 本模块是**纯逻辑**(注入脚本源 + 回传 payload 归一),不碰 chrome.* —— 便于单测。
// 隐私:input 只录值的 shape(长度/类型),password 字段连 shape 都不录;parse 侧再做防御性兜底
// (剥离任何 raw value,只留 valueShape),即便注入脚本被改也不外泄原始输入。

import { maskUrlAuthTokens } from './url-redact';

export const UI_BINDING_NAME = '__bycli_ui';
/** ring cap:防高频 input/scroll 把 buffer 撑爆(Codex F3 背压)。超出丢弃 + 记 dropped。 */
export const MAX_UI_EVENTS = 2000;

// 'navigate' = 页面 URL 变化(整页导航 / SPA pushState·replaceState·popstate·hashchange);
// 种子常藏在地址栏(/search?q=apple),喂 LLM 做 seed→参数映射的强证据。url 已脱敏。
export type UserActionType = 'click' | 'input' | 'submit' | 'keydown' | 'navigate';

export interface ValueShape {
  len: number;
  kind: 'email' | 'url' | 'number' | 'text';
}

export interface UserActionEvent {
  type: UserActionType;
  ts: number;
  /** stable-ish CSS selector(注入脚本就地构建;脆性后续多候选评分,见 12 模块 F3)。 */
  selector: string;
  tag: string;
  role?: string;
  /** 可见文本(截断),仅 click/submit。 */
  text?: string;
  /** input 值的 shape(永不含原始值);password 字段无此字段。 */
  valueShape?: ValueShape;
  /** keydown 的关键键(仅 Enter/Escape 等)。 */
  key?: string;
  /** navigate 事件的页面 URL(已脱敏);其它类型无。 */
  url?: string;
  /** OOPIF:事件来自跨源 iframe 子 session 时的 CDP sessionId(顶层事件无此字段);
   *  用于区分 iframe 内操作与顶层操作,避免 selector 跨 frame 混淆。由扩展分发器注入。 */
  frameSessionId?: string;
  /** OOPIF:事件来自的 iframe 文档 URL(已脱敏,取自 CDP targetInfo.url);顶层事件无此字段。 */
  frameUrl?: string;
}

const ALLOWED_TYPES: UserActionType[] = ['click', 'input', 'submit', 'keydown', 'navigate'];
const clampStr = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length ? v.slice(0, max) : undefined;

/**
 * 把 Runtime.bindingCalled 的 payload(注入脚本 JSON.stringify 的事件)归一成 UserActionEvent。
 * 防御性:校验 type、夹紧字符串长度、**剥离任何 raw value**(只认 valueShape),非法返回 null。
 */
export function parseUiEvent(payload: string): UserActionEvent | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type as UserActionType;
  if (!ALLOWED_TYPES.includes(type)) return null;
  const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : Date.now();
  // navigate:无 selector,改要 url(脱敏后截断);防御性,url 不可解析/为空 → null。
  if (type === 'navigate') {
    const rawUrl = clampStr(raw.url, 2048);
    if (!rawUrl) return null;
    return { type, ts, selector: '', tag: 'document', url: maskUrlAuthTokens(rawUrl).slice(0, 2048) };
  }
  const selector = clampStr(raw.selector, 300);
  if (!selector) return null;
  const ev: UserActionEvent = { type, ts, selector, tag: clampStr(raw.tag, 24) ?? 'unknown' };
  const role = clampStr(raw.role, 40);
  if (role) ev.role = role;
  const text = clampStr(raw.text, 80);
  if (text) ev.text = text;
  const key = clampStr(raw.key, 24);
  if (key) ev.key = key;
  // valueShape:只接受 {len:number, kind:枚举};raw value 一律丢弃(防御性,即便注入脚本被改)。
  const vs = raw.valueShape as Record<string, unknown> | undefined;
  if (vs && typeof vs.len === 'number' && Number.isFinite(vs.len)) {
    const kind = vs.kind;
    const k: ValueShape['kind'] = kind === 'email' || kind === 'url' || kind === 'number' ? kind : 'text';
    ev.valueShape = { len: Math.max(0, Math.min(100000, Math.floor(vs.len))), kind: k };
  }
  return ev;
}

/**
 * 注入页面的只读监听脚本源(main world)。在 Page.addScriptToEvaluateOnNewDocument(覆盖后续导航)
 * + 当前文档 Runtime.evaluate(覆盖已打开页)各注入一次;window.__bycli_ui_installed 防重复装。
 * 监听 capture 阶段 + passive,不改页面行为;password input 不录值;text 截断;Enter/Escape 才记 keydown。
 */
export const UI_LISTENER_SOURCE = `(function(){
  if (window.__bycli_ui_installed) return; window.__bycli_ui_installed = true;
  var B = ${JSON.stringify(UI_BINDING_NAME)};
  function esc(s){ try { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&'); } catch(e){ return String(s); } }
  function sel(el){
    if(!el||el.nodeType!==1) return '';
    if(el.id) return '#'+esc(el.id);
    var dt = el.getAttribute && el.getAttribute('data-testid'); if(dt) return '[data-testid="'+dt+'"]';
    var parts=[], n=el, depth=0;
    while(n && n.nodeType===1 && depth<5){
      if(n.id){ parts.unshift('#'+esc(n.id)); break; }
      var part=n.tagName.toLowerCase(), p=n.parentElement;
      if(p){ var same=[]; for(var i=0;i<p.children.length;i++){ if(p.children[i].tagName===n.tagName) same.push(p.children[i]); }
        if(same.length>1) part+=':nth-of-type('+(same.indexOf(n)+1)+')'; }
      parts.unshift(part); n=n.parentElement; depth++;
    }
    return parts.join(' > ');
  }
  function tag(el){ return el && el.tagName ? el.tagName.toLowerCase() : 'unknown'; }
  function txt(el){ try { var t=(el.innerText||el.textContent||'').trim(); return t ? t.slice(0,80) : undefined; } catch(e){ return undefined; } }
  function shape(v){ v=String(v==null?'':v); var kind='text';
    if(/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v)) kind='email';
    else if(/^https?:\\/\\//.test(v)) kind='url';
    else if(v!=='' && !isNaN(Number(v))) kind='number';
    return { len: v.length, kind: kind }; }
  function emit(o){ try { o.ts=Date.now(); if(typeof window[B]==='function') window[B](JSON.stringify(o)); } catch(e){} }
  document.addEventListener('click', function(e){ var t=e.target; emit({ type:'click', selector:sel(t), tag:tag(t), role:(t.getAttribute&&t.getAttribute('role'))||undefined, text:txt(t) }); }, { capture:true, passive:true });
  document.addEventListener('change', function(e){ var t=e.target; if(!t||!('value' in t)) return;
    if(t.type==='password'){ emit({ type:'input', selector:sel(t), tag:tag(t) }); return; }
    emit({ type:'input', selector:sel(t), tag:tag(t), valueShape:shape(t.value) }); }, { capture:true, passive:true });
  document.addEventListener('submit', function(e){ emit({ type:'submit', selector:sel(e.target), tag:'form' }); }, { capture:true, passive:true });
  document.addEventListener('keydown', function(e){ if(e.key==='Enter'||e.key==='Escape'){ emit({ type:'keydown', selector:sel(e.target), tag:tag(e.target), key:e.key }); } }, { capture:true, passive:true });
  // 导航录制:整页导航(脚本随新文档重注入,init 即发当前 URL)+ SPA 路由(history/popstate/hashchange)。
  // dedupe 连续相同 URL,避免 replaceState 刷参噪音;脱敏在扩展 parse 侧再做一道,这里只发原始 location.href。
  var lastUrl='';
  function navEmit(){ try { var u=location.href; if(u&&u!==lastUrl){ lastUrl=u; emit({ type:'navigate', url:u }); } } catch(e){} }
  navEmit();
  try { var _ps=history.pushState; history.pushState=function(){ var r=_ps.apply(this,arguments); navEmit(); return r; }; } catch(e){}
  try { var _rs=history.replaceState; history.replaceState=function(){ var r=_rs.apply(this,arguments); navEmit(); return r; }; } catch(e){}
  window.addEventListener('popstate', navEmit, { passive:true });
  window.addEventListener('hashchange', navEmit, { passive:true });
})();`;
