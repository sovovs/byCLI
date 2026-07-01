// N2 静态白名单单测:放行合法 adapter,挡住 require/eval/Function/动态import/危险全局/越权 origin;
// 成员属性 / 对象键同名不误伤。
import { describe, it, expect } from 'vitest';
import { staticCheckScript } from '../src/llm/sandbox-check.js';

const clean = `import { cli, Strategy } from '@sovovs/bycli/registry';
cli({ site:'x', name:'y', columns:['t'], func: async (k) => { const r = await fetch('https://api.x.com/s?q=' + k.q); const d = await r.json(); return d.map(x => ({ t: x.t })); } });`;

describe('staticCheckScript', () => {
  it('合法 adapter(仅 registry import + 允许 origin)→ ok', () => {
    expect(staticCheckScript(clean, ['https://api.x.com'])).toEqual({ ok: true, violations: [] });
  });
  it('禁止 import fs/child_process', () => {
    expect(staticCheckScript(`import fs from 'fs';`).violations).toContain('forbidden import: fs');
    expect(staticCheckScript(`import { x } from 'child_process';`).violations).toContain('forbidden import: child_process');
  });
  it('禁止 require / eval / new Function / 动态 import', () => {
    expect(staticCheckScript(`const a = require('fs');`).ok).toBe(false);
    expect(staticCheckScript(`eval('1');`).violations).toContain('forbidden call: eval');
    expect(staticCheckScript(`const f = new Function('return 1');`).violations).toContain('forbidden call: Function');
    expect(staticCheckScript(`const m = await import('fs');`).violations).toContain('dynamic import() not allowed');
  });
  it('禁止引用 process 全局', () => {
    expect(staticCheckScript(`const e = process.env.X;`).violations).toContain('forbidden reference: process');
  });
  it('成员属性 / 对象键同名不误伤', () => {
    expect(staticCheckScript(`const o = { a: 1 }; const v = o.process; export default v;`).ok).toBe(true);
    expect(staticCheckScript(`const o = { process: 1, eval: 2 }; export default o;`).ok).toBe(true);
  });
  it('origin 越权(给了 allowlist)→ 拦', () => {
    const r = staticCheckScript(`const x = 'https://evil.com/a';`, ['https://api.x.com']);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes('evil.com'))).toBe(true);
  });
  it('同站 origin(父域/子域)放行:api.juejin.cn 允许时,拼 url 用的 https://juejin.cn 不拦', () => {
    const src = `const base='https://api.juejin.cn'; const u=new URL('/post/1','https://juejin.cn').toString();`;
    const r = staticCheckScript(src, ['https://api.juejin.cn']);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });
  it('同站放行不误放第三方:allowlist=api.juejin.cn 时 evil.com 仍拦', () => {
    const r = staticCheckScript(`const x='https://evil.com/x';`, ['https://api.juejin.cn']);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes('evil.com'))).toBe(true);
  });
  it('解析失败 / 空源 → 不通过', () => {
    expect(staticCheckScript('const x = ;').ok).toBe(false);
    expect(staticCheckScript('   ').ok).toBe(false);
  });
});
