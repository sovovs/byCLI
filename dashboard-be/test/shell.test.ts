// M2 shell 验收:门禁三件套 + 状态机 + 错误映射 + health 降级 + feature gate。
// 用真实 http server + fetch,daemon 不可达走降级路径(不依赖主仓 daemon 在跑)。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { httpStatusFor } from '../src/transport/envelope.js';

const cfg = loadConfig({
  RECORDER_TOKEN: 'test-token-1234567890-abcdef',
  LOG_LEVEL: 'error', // quiet structured-request logs in test output
  RECORDER_ALLOWED_ORIGINS: 'http://127.0.0.1:8000',
  // 指向一个无人监听的端口,使 daemon 不可达 → health 降级
  BYCLI_DAEMON_PORT: '6553',
});

const { server, ctx } = createApp(cfg);
let base = '';

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const auth = {
  'X-Recorder': '1',
  'X-byCLI-Token': cfg.TOKEN,
  'X-CSRF-Token': ctx.vault.csrfToken,
  'Content-Type': 'application/json',
  Origin: 'http://127.0.0.1:8000',
};

describe('错误码 → HTTP status 映射(03 章)', () => {
  it('覆盖关键码', () => {
    expect(httpStatusFor('invalid_state')).toBe(400);
    expect(httpStatusFor('csrf_failed')).toBe(403);
    expect(httpStatusFor('feature_disabled')).toBe(403);
    expect(httpStatusFor('request_not_found')).toBe(404);
    expect(httpStatusFor('idempotency_conflict')).toBe(409);
    expect(httpStatusFor('queue_full')).toBe(429);
    expect(httpStatusFor('daemon_unavailable')).toBe(503);
  });
});

describe('04 章门禁', () => {
  it('缺 X-Recorder header → 403 auth_failed', async () => {
    const res = await fetch(`${base}/recorder/health`, { headers: { 'X-byCLI-Token': cfg.TOKEN } });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('auth_failed');
  });

  it('错误 Origin → 403', async () => {
    const res = await fetch(`${base}/recorder/health`, {
      headers: { 'X-Recorder': '1', 'X-byCLI-Token': cfg.TOKEN, Origin: 'http://evil.com' },
    });
    expect(res.status).toBe(403);
  });

  it('错误 token → 403', async () => {
    const res = await fetch(`${base}/recorder/health`, {
      headers: { 'X-Recorder': '1', 'X-byCLI-Token': 'wrong' },
    });
    expect(res.status).toBe(403);
  });

  it('side-effect POST 缺 CSRF → 403 csrf_failed', async () => {
    const res = await fetch(`${base}/recorder/session/bind`, {
      method: 'POST',
      headers: { 'X-Recorder': '1', 'X-byCLI-Token': cfg.TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'bind_existing_page', contextId: 'default' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('csrf_failed');
  });
});

describe('health 降级', () => {
  it('daemon 不可达 → 200 + daemon:down', async () => {
    const res = await fetch(`${base}/recorder/health`, {
      headers: { 'X-Recorder': '1', 'X-byCLI-Token': cfg.TOKEN, Origin: 'http://127.0.0.1:8000' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.daemon).toBe('down');
  });
});

describe('bind + 状态机 + confirm-auth', () => {
  it('await_login bind → awaiting_user_login,可 confirm 到 auth_confirmed', async () => {
    const bindRes = await fetch(`${base}/recorder/session/bind`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ mode: 'create_page_await_user_login', contextId: 'default' }),
    });
    expect(bindRes.status).toBe(200);
    const bind = (await bindRes.json()).data;
    expect(bind.awaitingLogin).toBe(true);

    const confirmRes = await fetch(`${base}/recorder/session/confirm-auth`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ sessionId: bind.sessionId }),
    });
    expect(confirmRes.status).toBe(200);
    expect((await confirmRes.json()).data.state).toBe('auth_confirmed');
  });

  it('existing bind → session_bound,confirm-auth 非法转移 → 400 invalid_state', async () => {
    const bind = (await (await fetch(`${base}/recorder/session/bind`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ mode: 'bind_existing_page', contextId: 'default' }),
    })).json()).data;
    expect(bind.awaitingLogin).toBe(false);

    const res = await fetch(`${base}/recorder/session/confirm-auth`, {
      method: 'POST', headers: auth, body: JSON.stringify({ sessionId: bind.sessionId }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_state');
  });
});

describe('M3:navigate 已接 daemon(不再 feature_disabled)', () => {
  it('POST /recorder/navigate 未知 session → request_not_found(已过 gate)', async () => {
    const res = await fetch(`${base}/recorder/navigate`, {
      method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'x', url: 'https://example.com' }),
    });
    // 不再是 403 feature_disabled:navigate 已接 daemon;未知 session 走业务校验
    expect((await res.json()).error.code).toBe('request_not_found');
  });

  it('POST /recorder/rank 已接 M4 引擎(不再 feature_disabled);未知 session → request_not_found', async () => {
    const res = await fetch(`${base}/recorder/rank`, {
      method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'x' }),
    });
    // M4 已解 gate:rank 经共享包 rankSamples 计算;未知 session 走业务校验
    expect((await res.json()).error.code).toBe('request_not_found');
  });

  it('POST /recorder/analyze 已接 M5a(不再 feature_disabled);未知 session → request_not_found', async () => {
    const res = await fetch(`${base}/recorder/analyze`, {
      method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'x', url: 'https://example.com' }),
    });
    // M5a 已解 gate:analyze 经 /command 收 signals + 纯 analyzeSite;未知 session 走业务校验
    expect((await res.json()).error.code).toBe('request_not_found');
  });

  it('POST /recorder/init 已接 M5b(不再 feature_disabled);select-only:缺 sessionId → validation_failed', async () => {
    const res = await fetch(`${base}/recorder/init`, {
      method: 'POST', headers: auth, body: JSON.stringify({ name: 'hn/top' }),
    });
    // M5b 已解 gate;H-002 select-only:init 需 sessionId + selectedCandidateId,缺则业务校验拦下(不触 daemon)
    expect((await res.json()).error.code).toBe('validation_failed');
  });

  it('POST /recorder/verify 已接 M5c(不再 feature_disabled);缺 sessionId → validation_failed', async () => {
    const res = await fetch(`${base}/recorder/verify`, {
      method: 'POST', headers: auth, body: JSON.stringify({ name: 'hn/top' }),
    });
    // M5c 已解 gate:verify 转发 daemon /v1/verify(M6 起走真实子进程 runner)。
    // 与 init 对称:verify 需 sessionId(canonical requestId + 状态机门禁),缺则业务校验拦下(不触 daemon)。
    expect((await res.json()).error.code).toBe('validation_failed');
  });
});

describe('幂等(03 章)', () => {
  it('同 key 不同 payload → 409 idempotency_conflict', async () => {
    const headers = { ...auth, 'Idempotency-Key': 'k1' };
    await fetch(`${base}/recorder/session/bind`, {
      method: 'POST', headers, body: JSON.stringify({ mode: 'bind_existing_page', contextId: 'a' }),
    });
    const res = await fetch(`${base}/recorder/session/bind`, {
      method: 'POST', headers, body: JSON.stringify({ mode: 'bind_existing_page', contextId: 'b' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('bootstrap 一次性', () => {
  it('nonce 单次换取,二次失败', async () => {
    const nonce = ctx.vault.bootstrapNonce;
    const first = await fetch(`${base}/__bootstrap?nonce=${nonce}`);
    expect(first.status).toBe(200);
    expect((await first.json()).data.token).toBe(cfg.TOKEN);
    const second = await fetch(`${base}/__bootstrap?nonce=${nonce}`);
    expect(second.status).toBe(403);
  });
});
