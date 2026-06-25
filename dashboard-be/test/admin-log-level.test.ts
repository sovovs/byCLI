// #5b admin log-level toggle —— FEATURE_ADMIN_LOG_LEVEL_TOGGLE(restart-only)。flag off 端点真的不存在;
// flag on 时走全套 side-effect 门禁,合法 level 即时调级。注入 logger 断言级别真的变了。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createLogger } from '../src/logger.js';

const TOKEN = 'admin-token-1234567890abcdef';

describe('#5b · flag off(默认):endpoint 不存在', () => {
  const cfg = loadConfig({ RECORDER_TOKEN: TOKEN, LOG_LEVEL: 'error', BYCLI_DAEMON_PORT: '6553' });
  const { server, ctx } = createApp(cfg);
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('POST → 404 request_not_found(即使门禁全过)', async () => {
    const res = await fetch(`${base}/recorder/admin/log-level`, {
      method: 'POST',
      headers: { 'X-Recorder': '1', 'X-byCLI-Token': TOKEN, 'X-CSRF-Token': ctx.vault.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'debug' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('request_not_found');
  });
});

describe('#5b · flag on:gated admin endpoint', () => {
  const logger = createLogger('error');
  const cfg = loadConfig({ RECORDER_TOKEN: TOKEN, LOG_LEVEL: 'error', FEATURE_ADMIN_LOG_LEVEL_TOGGLE: 'true', BYCLI_DAEMON_PORT: '6553' });
  const { server, ctx } = createApp(cfg, logger);
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const auth = { 'X-Recorder': '1', 'X-byCLI-Token': TOKEN, 'X-CSRF-Token': ctx.vault.csrfToken, 'Content-Type': 'application/json' };

  it('缺 CSRF → 403 csrf_failed(走全套门禁)', async () => {
    const res = await fetch(`${base}/recorder/admin/log-level`, {
      method: 'POST',
      headers: { 'X-Recorder': '1', 'X-byCLI-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'debug' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('csrf_failed');
  });

  it('非法 level → 400 validation_failed,级别不变', async () => {
    const res = await fetch(`${base}/recorder/admin/log-level`, { method: 'POST', headers: auth, body: JSON.stringify({ level: 'trace' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(logger.getLevel()).toBe('error');
  });

  it('合法 level → 200 且 logger 级别即时生效', async () => {
    expect(logger.getLevel()).toBe('error');
    const res = await fetch(`${base}/recorder/admin/log-level`, { method: 'POST', headers: auth, body: JSON.stringify({ level: 'debug' }) });
    expect(res.status).toBe(200);
    expect((await res.json()).data.level).toBe('debug');
    expect(logger.getLevel()).toBe('debug');
  });
});
