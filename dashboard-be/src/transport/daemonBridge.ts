// daemon bridge —— be 与主仓的唯一耦合面:daemon 的线上 HTTP 契约,不 import 主仓 src/。
// GET /status(映射 health);POST /command(navigate/capture 等,M3 接入)。
// 对照主仓 src/browser/daemon-client.ts 的连接约定:127.0.0.1:<port> + header X-byCLI:1。
import { randomUUID } from 'node:crypto';

const BYCLI_HEADER = { 'X-byCLI': '1' } as const;

export interface DaemonStatus {
  extensionConnected?: boolean;
  profileRequired?: boolean;
  profileDisconnected?: boolean;
  [k: string]: unknown;
}

/** be 侧 command 入参(daemon /command body 的子集;id 自动生成)。 */
export interface DaemonCommandInput {
  action: string;
  contextId?: string;
  /** 目标 page identity(targetId);page lease 复用 */
  page?: string | null;
  url?: string;
  pattern?: string;
  /** embedded_iframe 录制:目标 iframe URL,透传给扩展做 capture 噪音过滤(只留该 iframe 子 session)。 */
  targetFrameUrl?: string;
  /** 透传给 daemon 的其他命令字段(如 sampleName 等业务字段不进 daemon,仅 be 侧用) */
  [k: string]: unknown;
}

/** 规整后的 command 结果:bridge 不抛、不重试,统一成判别式结果交调用方决策。
 * `page` = 真扩展在命令结果**顶层**回的 page identity(targetId,data 的兄弟,非 data 内字段);
 * navigate 用它建 page lease(真扩展实测发现:之前只转发 data、丢了顶层 page → capture 全 page_lost)。 */
export type DaemonCommandResult =
  | { ok: true; data: unknown; page?: string }
  | { ok: false; errorCode: string; error: string };

export interface DaemonBridge {
  status(opts?: { contextId?: string; timeoutMs?: number }): Promise<DaemonStatus | null>;
  command(cmd: DaemonCommandInput, opts?: { timeoutMs?: number }): Promise<DaemonCommandResult>;
  /** POST a daemon high-level endpoint (M5b: /v1/init etc). Same fail-fast result shape. */
  highLevel(path: string, body: unknown, opts?: { timeoutMs?: number }): Promise<DaemonCommandResult>;
  /** GET a daemon high-level endpoint (M6: /v1/requests/{id} status poll). Same fail-fast shape. */
  highLevelGet(path: string, opts?: { timeoutMs?: number }): Promise<DaemonCommandResult>;
}

/** 真实 bridge:fetch daemon /status,超时即视为不可达(返回 null,由调用方降级 daemon_unavailable)。
 *  target:number(端口,host 默认 127.0.0.1,本机 daemon)或 {host,port}(VNC 模式指向容器网关)。
 *  默认 host=127.0.0.1 不变 —— tab_projection/embedded_iframe 走本机 daemon,行为完全不变。 */
export function createDaemonBridge(target: number | { host?: string; port: number }): DaemonBridge {
  const { host = '127.0.0.1', port } = typeof target === 'number' ? { port: target } : target;
  const base = `http://${host}:${port}`;
  return {
    async status(opts = {}) {
      const { contextId, timeoutMs = 2000 } = opts;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const qs = contextId ? `?contextId=${encodeURIComponent(contextId)}` : '';
        const res = await fetch(`${base}/status${qs}`, { headers: BYCLI_HEADER, signal: ctrl.signal });
        if (!res.ok) return null;
        return (await res.json()) as DaemonStatus;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },

    // POST /command:透传扩展 Result。bridge 不重试(fail-fast 归调用方);
    // 超时→daemon_timeout、网络/非 2xx→daemon_unavailable、Result.ok=false→透传 errorCode。
    async command(cmd, opts = {}) {
      const { timeoutMs = 30000 } = opts;
      const id = `be_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${base}/command`, {
          method: 'POST',
          headers: { ...BYCLI_HEADER, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, ...cmd }),
          signal: ctrl.signal,
        });
        let payload: Record<string, unknown> = {};
        try { payload = (await res.json()) as Record<string, unknown>; } catch { /* 非 JSON */ }

        if (res.ok && payload.ok === true) {
          // 透传顶层 page(navigate 的 page lease;真扩展放结果顶层而非 data 内)。
          return { ok: true, data: payload.data, page: typeof payload.page === 'string' ? payload.page : undefined };
        }
        // 扩展/ daemon 报错:优先透传 errorCode,缺失则按 HTTP 状态兜底。
        const error = typeof payload.error === 'string' ? payload.error : `daemon command failed (HTTP ${res.status})`;
        // 真扩展丢页时抛**纯 Error(无 errorCode)**,消息含 "stale page identity"(`extension/src/identity.ts`;
        // 主仓 CLI 侧 `src/browser/page.ts` 同样按此消息识别)→ 归一成 `page_lost`,否则 be 当 network_error、
        // 不 markFailed → 会话卡死(真栈实测发现)。
        const errorCode = typeof payload.errorCode === 'string'
          ? payload.errorCode
          : error.includes('stale page identity')
            ? 'page_lost'
            : (res.status === 408 ? 'daemon_timeout' : res.status >= 500 ? 'daemon_unavailable' : 'request_failed');
        return { ok: false, errorCode, error };
      } catch (e) {
        // AbortError(超时)与网络错误都视为 daemon 不可达类;调用方决定是否 lease-loss。
        const aborted = e instanceof Error && e.name === 'AbortError';
        return {
          ok: false,
          errorCode: aborted ? 'daemon_timeout' : 'daemon_unavailable',
          error: e instanceof Error ? e.message : String(e),
        };
      } finally {
        clearTimeout(timer);
      }
    },

    // POST a daemon high-level endpoint (e.g. /v1/init). Mirrors command()'s fail-fast
    // result mapping: 2xx+{ok:true}→data; else透传 errorCode;超时/网络→daemon_timeout/unavailable.
    async highLevel(path, reqBody, opts = {}) {
      const { timeoutMs = 30000 } = opts;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { ...BYCLI_HEADER, 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
          signal: ctrl.signal,
        });
        let payload: Record<string, unknown> = {};
        try { payload = (await res.json()) as Record<string, unknown>; } catch { /* 非 JSON */ }
        if (res.ok && payload.ok === true) {
          return { ok: true, data: payload.data };
        }
        const errorCode = typeof payload.errorCode === 'string'
          ? payload.errorCode
          : (res.status === 408 ? 'daemon_timeout' : res.status >= 500 ? 'daemon_unavailable' : 'request_failed');
        const error = typeof payload.error === 'string' ? payload.error : `daemon high-level ${path} failed (HTTP ${res.status})`;
        return { ok: false, errorCode, error };
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        return { ok: false, errorCode: aborted ? 'daemon_timeout' : 'daemon_unavailable', error: e instanceof Error ? e.message : String(e) };
      } finally {
        clearTimeout(timer);
      }
    },

    // GET a daemon high-level endpoint (e.g. /v1/requests/{id}). Same fail-fast mapping as
    // highLevel: 2xx+{ok:true}→data; 404→request_not_found; else errorCode; timeout/net→daemon_*.
    async highLevelGet(path, opts = {}) {
      const { timeoutMs = 10000 } = opts;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${base}${path}`, { headers: BYCLI_HEADER, signal: ctrl.signal });
        let payload: Record<string, unknown> = {};
        try { payload = (await res.json()) as Record<string, unknown>; } catch { /* 非 JSON */ }
        if (res.ok && payload.ok === true) {
          return { ok: true, data: payload.data };
        }
        const errorCode = typeof payload.errorCode === 'string'
          ? payload.errorCode
          : (res.status === 404 ? 'request_not_found' : res.status === 408 ? 'daemon_timeout' : res.status >= 500 ? 'daemon_unavailable' : 'request_failed');
        const error = typeof payload.error === 'string' ? payload.error : `daemon high-level GET ${path} failed (HTTP ${res.status})`;
        return { ok: false, errorCode, error };
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        return { ok: false, errorCode: aborted ? 'daemon_timeout' : 'daemon_unavailable', error: e instanceof Error ? e.message : String(e) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
