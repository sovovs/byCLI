// 同源 UI 托管(联调形态 ①)。be serve dashboard build 产物 → 消除跨源 CORS。
// 入口 HTML 由 be 注入 bootstrap(token/csrfToken/baseUrl 写 sessionStorage),
// 等价 04 章 loopback handshake:token 不经可 fetch 端点,只随 be 自己 serve 的 HTML 下发。
// 仅监听 127.0.0.1 + same-uid out-of-scope(04 章),故直接注入可接受。
import { readFile, stat } from 'node:fs/promises';
import { resolve, normalize, extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';

/**
 * CSP for the localhost UI (04 章 "XSS in UI" mitigation, M7d). script-src is locked to same-origin
 * bundles + a per-response nonce for the one injected bootstrap script — the only inline script
 * (the dist index.html otherwise has only same-origin <script src>). No 'unsafe-eval': the bundle's
 * lone `new Function("return this")` is a short-circuited, try/catch'd globalThis polyfill that falls
 * back when blocked. style-src keeps 'unsafe-inline' for antd's runtime CSS-in-JS <style> injection
 * (style injection cannot run JS). frame-ancestors 'none' + X-Frame-Options block clickjacking of
 * authorized actions; object-src/base-uri/form-action are locked down.
 */
function buildCsp(nonce: string, frameSrc?: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // embedded_iframe 录制模式才放开(privileged/local mode);默认不含此行 → 回落 default-src 'self' 拦跨源 iframe。
    ...(frameSrc ? [`frame-src ${frameSrc}`] : []),
  ].join('; ');
}

/** embedded_iframe 录制模式的 frame-src 值(B+A 混合,Codex 2026-06-29 裁定):
 *  flag 关 → undefined(无 frame-src,现状零变化);
 *  flag 开 + 未配置 override → 'https:'(填 URL 即录,无需预配置任意公开站);
 *  flag 开 + 配置了 override → 只放这些 https origin(CI/企业 hardened)。
 *  只放 https:,绝不放 http:/data:/blob:/*。
 *  vnc 模式额外放行 loopback http(noVNC iframe 从 http://127.0.0.1:<容器映射端口> 加载;
 *  端口动态,故放 127.0.0.1:* 整段——仅本机回环,不扩到公网)。 */
export function resolveFrameSrc(enabled: boolean, override?: readonly string[], vncEnabled = false): string | undefined {
  const parts: string[] = [];
  if (enabled) parts.push(override && override.length ? override.join(' ') : 'https:');
  if (vncEnabled) parts.push('http://127.0.0.1:* http://localhost:*');
  return parts.length ? parts.join(' ') : undefined;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const BOOTSTRAP_KEY = '__bycli_recorder_bootstrap__';

export interface UiBootstrap {
  baseUrl: string;
  token: string;
  csrfToken: string;
  /** embedded_iframe 录制模式是否可用(FEATURE_EMBEDDED_IFRAME_RECORDING);前端据此显示「页内嵌入」选项。 */
  embeddedIframeRecording?: boolean;
  /** vnc 录制模式是否可用(FEATURE_VNC_RECORDING);前端据此显示「VNC 容器」选项。 */
  vncRecording?: boolean;
}

/** 注入脚本:在 umi.js 之前把 bootstrap 写入 sessionStorage(前端 readBootstrap 据此切 HTTP)。
 * 带 CSP nonce —— 这是 index.html 里唯一的 inline script,nonce 让它在 script-src 'self' 下放行。 */
function injectBootstrap(html: string, b: UiBootstrap, nonce: string): string {
  const payload = JSON.stringify({ enabled: true, ...b });
  // JSON.stringify 两次 → 安全嵌进 <script> 字符串字面量,避免引号/标签注入
  const snippet = `<script nonce="${nonce}">sessionStorage.setItem(${JSON.stringify(BOOTSTRAP_KEY)}, ${JSON.stringify(payload)});</script>`;
  return html.replace('</head>', `${snippet}</head>`);
}

export interface StaticServer {
  /** 处理一个 GET 请求;返回 true 表示已响应(命中静态/SPA),false 表示非 UI 请求交回 API。 */
  handle(pathname: string, res: ServerResponse, bootstrap: UiBootstrap): Promise<boolean>;
}

export function createStaticServer(uiDist: string, frameSrc?: string): StaticServer {
  const root = resolve(uiDist);

  async function sendFile(res: ServerResponse, filePath: string, bootstrap?: UiBootstrap): Promise<void> {
    const ext = extname(filePath);
    let body: Buffer | string = await readFile(filePath);
    const headers: Record<string, string> = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      // 入口 HTML 不缓存(每次重注入 token + 新 nonce);静态资源可缓存
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    };
    // 入口 HTML:每响应一枚 nonce,串起 CSP 与注入的 bootstrap script(04 章 XSS-in-UI,M7d)
    if (ext === '.html') {
      const nonce = randomBytes(16).toString('base64');
      headers['Content-Security-Policy'] = buildCsp(nonce, frameSrc);
      headers['X-Frame-Options'] = 'DENY';
      headers['Referrer-Policy'] = 'no-referrer';
      if (bootstrap) body = injectBootstrap(body.toString('utf8'), bootstrap, nonce);
    }
    res.writeHead(200, headers);
    res.end(body);
  }

  return {
    async handle(pathname, res, bootstrap) {
      // 资源请求(带扩展名):解析真实文件,防路径穿越
      const hasExt = extname(pathname) !== '';
      if (hasExt) {
        const target = resolve(join(root, normalize(pathname)));
        if (!target.startsWith(root + '/') && target !== root) return false; // 越界拒绝
        try {
          const s = await stat(target);
          if (s.isFile()) {
            await sendFile(res, target);
            return true;
          }
        } catch {
          return false; // 文件不存在 → 交回(404 由调用方)
        }
        return false;
      }
      // 无扩展名 → SPA 路由(/、/docs、/workbench…)回 index.html(注入 bootstrap)
      try {
        await sendFile(res, join(root, 'index.html'), bootstrap);
        return true;
      } catch {
        return false;
      }
    },
  };
}
