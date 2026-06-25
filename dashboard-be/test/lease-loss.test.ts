// lease-loss 错误码识别回归(真栈实测驱动):真 daemon/扩展丢页/断连时产出的实际码,be 必须识别为
// lease-loss 并 markFailed,否则会话卡死(真扩展实测:丢页回 "stale page identity"/request_failed、
// 断连回 command_result_unknown,**都不是** be 曾凭空假设的 page_lost/extension_disconnected)。
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createDaemonBridge } from '../src/transport/daemonBridge.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createHttpRecorderClient } from '../../dashboard/src/services/httpRecorderClient';

const TOKEN = 'e2e-token-1234567890abcdef';

describe('lease-loss 错误码识别(真栈实测回归)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('bridge:真扩展丢页 "stale page identity"(无 errorCode)→ 归一 page_lost', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: false, error: 'Page not found: P — stale page identity' }),
    })));
    const r = await createDaemonBridge(19825).command({ action: 'network-capture-start', page: 'P' });
    expect(r.ok).toBe(false);
    expect((r as { errorCode: string }).errorCode).toBe('page_lost');
  });

  it('handler:daemon lease-loss 码(command_result_unknown)→ markFailed + 映射 page_lost', async () => {
    const cfg = loadConfig({
      RECORDER_TOKEN: TOKEN, LOG_LEVEL: 'error', RECORDER_ALLOWED_ORIGINS: 'http://127.0.0.1:8000',
      BYCLI_DAEMON_PORT: '19825', RECORDER_MAX_ACTIVE_SESSIONS: '10',
    });
    const { server, ctx } = createApp(cfg);
    // 真扩展断连:status 仍在线但 command 回 command_result_unknown(命令结果丢失)
    ctx.daemon.status = async () => ({ extensionConnected: true });
    ctx.daemon.command = async () => ({ ok: false, errorCode: 'command_result_unknown', error: 'extension disconnected mid-flight' });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    const port = (server.address() as AddressInfo).port;
    const client = createHttpRecorderClient({ enabled: true, baseUrl: `http://127.0.0.1:${port}`, token: cfg.TOKEN, csrfToken: ctx.vault.csrfToken });

    const bind = await client.bind('existing');
    const nav = await client.navigate('https://x.com');
    expect(nav.ok).toBe(false);
    expect((nav.error as { code?: string })?.code).toBe('page_lost'); // mapDaemonError 归一
    const sess = (ctx as { registry: { getSession(id: string): { state: string } | undefined } }).registry.getSession(bind.data!.sessionId);
    expect(sess?.state).toBe('failed'); // isLeaseLossCode → markFailed

    await new Promise<void>((res) => server.close(() => res()));
  });
});
