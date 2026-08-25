import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';

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
  it('rejects private ima commands before dispatch when the extension lacks ima-reader-v1', async () => {
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
    let extension: WebSocket | undefined;
    try {
      await expect.poll(async () => (await fetch(`http://127.0.0.1:${port}/ping`)).status, {
        timeout: 10_000,
      }).toBe(200);

      extension = new WebSocket(`ws://127.0.0.1:${port}/ext`);
      await once(extension, 'open');
      const extensionMessages: unknown[] = [];
      extension.on('message', (data) => extensionMessages.push(JSON.parse(data.toString())));
      extension.send(JSON.stringify({
        type: 'hello',
        contextId: 'legacy-ima-profile',
        version: '2.1.20',
        capabilities: ['focus-window-v1'],
      }));

      await expect.poll(async () => {
        const status = await fetch(`http://127.0.0.1:${port}/status`, {
          headers: { 'X-byCLI': '1' },
        });
        const body = await status.json() as { profiles?: Array<{ contextId?: string }> };
        return body.profiles?.some((profile) => profile.contextId === 'legacy-ima-profile') ?? false;
      }).toBe(true);

      const response = await fetch(`http://127.0.0.1:${port}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-byCLI': '1' },
        body: JSON.stringify({
          id: 'ima-capability-command',
          action: 'ima-auth-start',
          contextId: 'legacy-ima-profile',
          session: 'ima',
          surface: 'adapter',
        }),
      });

      expect(response.status).toBe(412);
      await expect(response.json()).resolves.toMatchObject({
        id: 'ima-capability-command',
        ok: false,
        errorCode: 'extension_capability_missing',
        error: expect.stringContaining('ima-reader-v1'),
        errorHint: expect.stringMatching(/update.*reload/i),
      });
      expect(extensionMessages).not.toContainEqual(
        expect.objectContaining({ id: 'ima-capability-command' }),
      );
    } finally {
      extension?.close();
      daemon.kill('SIGTERM');
      await once(daemon, 'exit');
    }
  });

  it('starts the configured browser recovery command through the restricted recovery endpoint', async () => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    if (address === null || typeof address === 'string') throw new Error('failed to reserve daemon port');
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const daemon: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/daemon.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BYCLI_DAEMON_HOST: '127.0.0.1',
        BYCLI_DAEMON_PORT: String(port),
        BYCLI_BROWSER_RECOVERY_COMMAND: process.execPath,
      },
      stdio: 'ignore',
    });
    try {
      await expect.poll(async () => (await fetch(`http://127.0.0.1:${port}/ping`)).status, {
        timeout: 10_000,
      }).toBe(200);

      const response = await fetch(`http://127.0.0.1:${port}/v1/browser/recover`, {
        method: 'POST',
        headers: { 'X-byCLI': '1' },
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ ok: true, data: { started: true } });
    } finally {
      daemon.kill('SIGTERM');
      await once(daemon, 'exit');
    }
  });

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
