// N2 · 生成脚本静态白名单检查(Codex P0-3 缓解)。LLM 生成的 adapter 是「代码注入」,写盘/verify 前
// 必须过这道静态闸:① 只允许 import @sovovs/bycli/{registry,errors};② 禁 require/eval/Function/动态import;
// ③ 禁引用 process/child_process/module 等危险全局;④ 字符串里的 http(s) origin 必须 ⊆ allowedOrigins。
// 用 @babel/parser 解析 + 手写遍历(无 @babel/traverse)。解析失败本身即视为不通过。
// 注:静态检查非强沙箱(08 章),与 verify-runner 子进程隔离 + 人工保存确认共同兜底。
import { parse } from '@babel/parser';

const ALLOWED_IMPORTS = new Set(['@sovovs/bycli/registry', '@sovovs/bycli/errors']);
// 作为「被引用的全局」禁止(经成员/对象键过滤,避免误伤 foo.process / {process:1})
const FORBIDDEN_GLOBALS = new Set(['process', 'globalThis', '__dirname', '__filename', 'module', 'exports', 'require']);
const FORBIDDEN_CALLS = new Set(['eval', 'Function', 'require']);

export interface StaticCheck {
  ok: boolean;
  violations: string[];
}

type Node = Record<string, unknown> & { type?: string };

/** 递归遍历 AST;visit 返回的子键里,跳过非 computed 的成员属性 / 对象键(避免把 x.process 误判)。 */
function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) walk(c, visit); return; }
  const n = node as Node;
  if (typeof n.type !== 'string') return;
  visit(n);
  for (const key of Object.keys(n)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range' || key === 'leadingComments' || key === 'trailingComments') continue;
    // 跳过非 computed 成员属性 / 对象/类键(它们是名字,不是全局引用)
    if (!n.computed && (key === 'property' || key === 'key')) continue;
    walk(n[key], visit);
  }
}

const ORIGIN_RE = /\bhttps?:\/\/[^/"'\s)]+/gi;

/** 取 hostname(小写,去端口);不可解析返回 null。 */
function hostOf(originOrUrl: string): string | null {
  try { return new URL(originOrUrl).hostname.toLowerCase(); } catch { return null; }
}

/**
 * 引用到的 origin 是否被允许:与某 allowedOrigin **同站**即放行 —— host 相等,或互为 dot-后缀
 * (子域/父域)。这样脚本既能 fetch `api.juejin.cn`,又能用 `https://juejin.cn` 拼文章展示 url(列值,
 * 非 egress),而 `evil.com` 仍被拦。注:origin 限制只是 sanity 闸,真正隔离靠 verify-runner 子进程 + 人工保存。
 */
function originAllowed(url: string, allowedOrigins: string[]): boolean {
  const h = hostOf(url);
  if (!h) return false;
  return allowedOrigins.some((o) => {
    const a = hostOf(o) ?? o.toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
    return !!a && (h === a || h.endsWith(`.${a}`) || a.endsWith(`.${h}`));
  });
}

/** 静态检查生成脚本源。allowedOrigins 为空则不做 origin 限制(由调用方决定是否传)。 */
export function staticCheckScript(source: string, allowedOrigins: string[] = []): StaticCheck {
  if (typeof source !== 'string' || !source.trim()) return { ok: false, violations: ['empty source'] };
  const violations: string[] = [];
  let ast: unknown;
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['topLevelAwait'] });
  } catch (e) {
    return { ok: false, violations: [`parse_error: ${e instanceof Error ? e.message : String(e)}`] };
  }
  walk(ast, (n) => {
    switch (n.type) {
      case 'ImportDeclaration': {
        const src = (n.source as { value?: unknown } | undefined)?.value;
        if (typeof src === 'string' && !ALLOWED_IMPORTS.has(src)) violations.push(`forbidden import: ${src}`);
        break;
      }
      case 'Import': // 动态 import(...)
        violations.push('dynamic import() not allowed');
        break;
      case 'Identifier': {
        const name = n.name as string;
        if (FORBIDDEN_GLOBALS.has(name)) violations.push(`forbidden reference: ${name}`);
        break;
      }
      case 'CallExpression':
      case 'NewExpression': {
        const callee = n.callee as { type?: string; name?: string } | undefined;
        if (callee?.type === 'Identifier' && callee.name && FORBIDDEN_CALLS.has(callee.name)) {
          violations.push(`forbidden call: ${callee.name}`);
        }
        break;
      }
      case 'StringLiteral':
      case 'TemplateElement': {
        const raw = n.type === 'StringLiteral' ? (n.value as string) : ((n.value as { cooked?: string } | undefined)?.cooked ?? '');
        if (allowedOrigins.length && typeof raw === 'string') {
          const m = raw.match(ORIGIN_RE);
          if (m) for (const url of m) {
            if (!originAllowed(url, allowedOrigins)) violations.push(`disallowed origin: ${url}`);
          }
        }
        break;
      }
    }
  });
  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}
