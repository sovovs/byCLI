// URL query 里的鉴权 token 脱敏(纯逻辑,无 chrome.*)。在捕获层 mask,token 根本不进 be/前端/LLM。
// 同时被 cdp.ts(network/ws URL)与 ui-capture.ts(导航 URL)复用 —— 抽到独立模块避免循环依赖。
// 现有脱敏只覆盖 header(canonical AUTH_HEADERS)+ query 参数名分类(normalize DYNAMIC_PARAM_RE),
// 不 mask URL 原始 token 值 —— 真机发现 WS 握手把 JWT 放 query(beyond-token=eyJ...)。
// 精度优先:按「分隔符切段后整段命中」判,避免 author 因含 auth 被误杀;再叠加 JWT 值兜底。
const AUTH_PARAM_SEGMENTS = new Set([
  'token', 'tokens', 'jwt', 'secret', 'fingerprint', 'signature', 'sig', 'sign', 'csrf', 'xsrf',
  'session', 'sessionid', 'sid', 'password', 'passwd', 'pwd', 'auth', 'authorization',
  'accesstoken', 'refreshtoken', 'idtoken', 'apikey', 'appkey', 'bearer', 'credential', 'credentials',
]);
const JWT_VALUE_RE = /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+$/;
const MASKED = '***';
function paramNameLooksAuth(name: string): boolean {
  return name.toLowerCase().split(/[-_.]/).some((seg) => AUTH_PARAM_SEGMENTS.has(seg));
}
export function maskUrlAuthTokens(url: string | undefined): string {
  if (!url) return url ?? '';
  try {
    const u = new URL(url);
    let changed = false;
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (paramNameLooksAuth(k) || JWT_VALUE_RE.test(v)) { u.searchParams.set(k, MASKED); changed = true; }
    }
    return changed ? u.toString() : url;
  } catch {
    return url; // 不可解析 → 原样(best-effort,不抛)
  }
}
