import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  COMMAND_RESULT_UNKNOWN_CODE,
  COMMAND_RESULT_UNKNOWN_HINT,
  buildCommandDispatchFailure,
  buildExtensionDisconnectFailure,
  commandResultUnknownMessage,
  getResponseCorsHeaders,
} from './daemon-utils.js';

describe('getResponseCorsHeaders', () => {
  it('allows the Browser Bridge extension origin to read /ping', () => {
    expect(getResponseCorsHeaders('/ping', 'chrome-extension://abc123')).toEqual({
      'Access-Control-Allow-Origin': 'chrome-extension://abc123',
      Vary: 'Origin',
    });
  });

  it('does not add CORS headers for ordinary web origins', () => {
    expect(getResponseCorsHeaders('/ping', 'https://example.com')).toBeUndefined();
  });

  it('does not add CORS headers when origin is absent', () => {
    expect(getResponseCorsHeaders('/ping')).toBeUndefined();
  });

  it('does not add CORS headers for command endpoints even from the extension origin', () => {
    expect(getResponseCorsHeaders('/command', 'chrome-extension://abc123')).toBeUndefined();
  });
});

describe('daemon command dispatch', () => {
  it('routes command requests with proxy query parameters to the command handler', async () => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    if (address === null || typeof address === 'string') throw new Error('failed to reserve daemon port');
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const daemon: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/daemon.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, BYCLI_DAEMON_HOST: '127.0.0.1', BYCLI_DAEMON_PORT: String(port) },
      stdio: 'ignore',
    });
    try {
      await expect.poll(async () => (await fetch(`http://127.0.0.1:${port}/ping`)).status, {
        timeout: 10_000,
      }).toBe(200);

      const response = await fetch(`http://127.0.0.1:${port}/command?token=proxy-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-byCLI': '1' },
        body: JSON.stringify({ id: 'query-command', action: 'navigate' }),
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        id: 'query-command',
        ok: false,
        errorCode: 'extension_not_connected',
      });
    } finally {
      daemon.kill('SIGTERM');
      await once(daemon, 'exit');
    }
  });

  it('uses a distinct command_result_unknown contract for ambiguous dispatched commands', () => {
    expect(COMMAND_RESULT_UNKNOWN_CODE).toBe('command_result_unknown');
    expect(commandResultUnknownMessage('navigate')).toContain('navigate command was dispatched');
    expect(COMMAND_RESULT_UNKNOWN_HINT).toContain('Inspect the browser/session state');
    expect(COMMAND_RESULT_UNKNOWN_HINT).toContain('Do not blindly retry write commands');
  });

  it('classifies dispatched extension disconnects as command_result_unknown', () => {
    expect(buildExtensionDisconnectFailure({
      contextId: 'work',
      action: 'navigate',
      dispatched: true,
    })).toEqual({
      message: 'Browser connection dropped after the navigate command was dispatched; it may have completed.',
      errorCode: 'command_result_unknown',
      errorHint: COMMAND_RESULT_UNKNOWN_HINT,
      status: 503,
      countAsCommandResultUnknown: true,
    });
  });

  it('classifies pre-dispatch extension disconnects as profile_disconnected', () => {
    expect(buildExtensionDisconnectFailure({
      contextId: 'work',
      action: 'navigate',
      dispatched: false,
    })).toMatchObject({
      message: 'Browser profile "work" disconnected before command dispatch',
      errorCode: 'profile_disconnected',
      status: 503,
      countAsCommandResultUnknown: false,
    });
  });

  it('classifies ws.send dispatch failures as profile_disconnected', () => {
    expect(buildCommandDispatchFailure('work')).toMatchObject({
      message: 'Browser profile "work" disconnected before command dispatch',
      errorCode: 'profile_disconnected',
      status: 503,
      countAsCommandResultUnknown: false,
    });
  });
});
