import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, CommandExecutionError, TimeoutError, toEnvelope } from '@sovovs/bycli/errors';
import { getRegistry } from '../../src/registry.js';
import { render } from '../../src/output.js';

const secrets = {
  token: 'token+A/B=history-secret',
  cookieValue: 'cookie+A/B=history-secret',
  fingerprint: 'fingerprint+A/B=history-secret',
};
const cookie = `session=${secrets.cookieValue}; editor=secondary-cookie-secret`;
const wechatEnvironmentKeys = ['WECHAT_TOKEN', 'WECHAT_COOKIE', 'WECHAT_FINGERPRINT'] as const;
type WechatEnvironmentSnapshot = Record<(typeof wechatEnvironmentKeys)[number], string | undefined>;

function snapshotWechatEnvironment(): WechatEnvironmentSnapshot {
  return Object.fromEntries(
    wechatEnvironmentKeys.map(key => [key, process.env[key]]),
  ) as WechatEnvironmentSnapshot;
}

const initialWechatEnvironment = snapshotWechatEnvironment();

function restoreWechatEnvironment(snapshot = initialWechatEnvironment) {
  for (const key of wechatEnvironmentKeys) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeAll(async () => {
  await Promise.all([
    import('../../clis/weixin/accounts.js'),
    import('../../clis/weixin/articles.js'),
    import('../../clis/weixin/save-articles.js'),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  restoreWechatEnvironment();
});

afterAll(() => restoreWechatEnvironment());

function command(name: string) {
  const value = getRegistry().get(`weixin/${name}`);
  expect(value, `weixin/${name} must be registered`).toBeDefined();
  expect(value?.func, `weixin/${name} must expose its registered func`).toBeTypeOf('function');
  return value!;
}

function envAuth(withFingerprint = false) {
  process.env.WECHAT_TOKEN = secrets.token;
  process.env.WECHAT_COOKIE = cookie;
  if (withFingerprint) process.env.WECHAT_FINGERPRINT = secrets.fingerprint;
}

function response(payload: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, statusText: ok ? 'OK' : 'Failure', json: async () => payload } as Response;
}

function publishPayload(items: Array<Record<string, unknown>>, total = items.length) {
  return {
    base_resp: { ret: 0 },
    publish_page: JSON.stringify({
      total_count: total,
      publish_list: items.map(item => ({
        publish_info: JSON.stringify({ sent_info: { time: 1_700_000_000 }, appmsg_info: [item] }),
      })),
    }),
  };
}

function assertSecretFree(value: unknown) {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [secrets.token, cookie, secrets.cookieValue, secrets.fingerprint, 'secondary-cookie-secret']) {
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain(encodeURIComponent(secret));
  }
}

async function captureRender(data: unknown, fmt: string, columns?: string[]) {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));
  try { render(data, { fmt, fmtExplicit: true, columns }); } finally { spy.mockRestore(); }
  return lines.join('\n');
}

describe('built-in weixin history workflow', () => {
  it('restores pre-existing WeChat environment values exactly', () => {
    process.env.WECHAT_TOKEN = 'pre-existing-token';
    process.env.WECHAT_COOKIE = 'pre-existing-cookie';
    process.env.WECHAT_FINGERPRINT = 'pre-existing-fingerprint';
    const snapshot = snapshotWechatEnvironment();
    process.env.WECHAT_TOKEN = 'temporary-token';
    process.env.WECHAT_COOKIE = 'temporary-cookie';
    delete process.env.WECHAT_FINGERPRINT;

    restoreWechatEnvironment(snapshot);

    expect(process.env.WECHAT_TOKEN).toBe('pre-existing-token');
    expect(process.env.WECHAT_COOKIE).toBe('pre-existing-cookie');
    expect(process.env.WECHAT_FINGERPRINT).toBe('pre-existing-fingerprint');
  });

  it('runs the registered browser accounts command and preserves two similar candidates', async () => {
    let preflightReads = 0;
    let fingerprintReads = 0;
    const page = {
      evaluate: vi.fn(async (_fn: unknown, arg?: { operation?: string }) => {
        if (!arg?.operation) {
          preflightReads += 1;
          return { href: `https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=${encodeURIComponent(secrets.token)}`, hasLoginUi: false };
        }
        if (arg.operation === 'install') return { submitted: true };
        if (arg.operation === 'read') return ++fingerprintReads === 1 ? null : secrets.fingerprint;
        return undefined;
      }),
      getCookies: vi.fn(async () => [{ name: 'session', value: secrets.cookieValue, domain: '.mp.weixin.qq.com' }]),
      goto: vi.fn(async () => undefined), wait: vi.fn(async () => undefined), focusWindow: vi.fn(),
      fetchJson: vi.fn(async () => ({ base_resp: { ret: 0 }, list: [
        { nickname: 'Acme', fakeid: 'same-1', alias: 'acme' },
        { nickname: 'Acme Lab', fakeid: 'same-2', alias: 'acme-lab' },
      ] })),
    };
    const registered = command('accounts');
    expect(registered).toMatchObject({ browser: 'conditional', strategy: 'intercept', columns: ['nickname', 'fakeid', 'alias'] });
    expect(registered.requiresBrowser?.({ 'auth-source': 'browser' })).toBe(true);
    const rows = await registered.func!(page as never, { query: 'Acme', limit: 2, 'auth-source': 'browser' });
    expect(rows).toEqual([
      { nickname: 'Acme', fakeid: 'same-1', alias: 'acme' },
      { nickname: 'Acme Lab', fakeid: 'same-2', alias: 'acme-lab' },
    ]);
    expect(preflightReads).toBe(1);
    assertSecretFree(rows);
    assertSecretFree(await captureRender(rows, 'json', registered.columns));
    assertSecretFree(await captureRender(rows, 'yaml', registered.columns));
  });

  it('runs registered env articles through API parsing and bounded collection', async () => {
    envAuth();
    const fetchImpl = vi.fn(async () => response(publishPayload([
      { title: 'First', content_url: 'https://mp.weixin.qq.com/s/first' },
      { title: 'Second', content_url: 'https://mp.weixin.qq.com/s/second' },
    ], 20)));
    vi.stubGlobal('fetch', fetchImpl);
    const registered = command('articles');
    expect(registered).toMatchObject({ browser: 'conditional', strategy: 'cookie' });
    expect(registered.requiresBrowser?.({ 'auth-source': 'env' })).toBe(false);
    const rows = await registered.func!(null, { fakeid: 'account-1', limit: 1, 'max-pages': 1, 'auth-source': 'env' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'First', url: 'https://mp.weixin.qq.com/s/first' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    assertSecretFree(rows);
  });

  it('runs registered env save with one safe file and one sanitized failure row', async () => {
    envAuth();
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-weixin-e2e-'));
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target.includes('/cgi-bin/appmsgpublish')) return response(publishPayload([
        { title: '../Unsafe First', content_url: 'https://mp.weixin.qq.com/s/save-ok' },
        { title: 'Second', content_url: 'https://mp.weixin.qq.com/s/save-fail' },
      ]));
      if (target.endsWith('/save-ok')) return { ok: true, text: async () => '<div id="js_content"><p>Saved body</p></div>' } as Response;
      throw new Error(`download denied token=${secrets.token} cookie=${cookie}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const registered = command('save-articles');
      expect(registered).toMatchObject({ access: 'write', browser: 'conditional', strategy: 'cookie' });
      const rows = await registered.func!(null, { fakeid: 'account-1', name: 'Account', output, limit: 2, 'auth-source': 'env' }) as Array<Record<string, unknown>>;
      expect(rows.map(row => row.status)).toEqual(['saved', 'failed']);
      expect(rows[1]).toMatchObject({ stage: 'download', path: null, error: 'article download failed' });
      const savedPath = String(rows[0].path);
      expect(path.relative(fs.realpathSync(output), savedPath)).not.toMatch(/^\.\.(?:[/\\]|$)/);
      if (process.platform !== 'win32') expect(fs.statSync(savedPath).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(savedPath, 'utf8')).toContain('Saved body');
      assertSecretFree(rows);
      assertSecretFree(fs.readFileSync(savedPath, 'utf8'));
      assertSecretFree(await captureRender(rows, 'json', registered.columns));
      assertSecretFree(await captureRender(rows, 'csv', registered.columns));
    } finally {
      fs.rmSync(output, { recursive: true, force: true });
    }
  });

  it('surfaces expired credentials as AuthRequiredError without leaking secrets', async () => {
    envAuth();
    vi.stubGlobal('fetch', vi.fn(async () => response({ base_resp: { ret: 200013, err_msg: 'invalid credential' } })));
    const thrown = await command('articles').func!(null, { fakeid: 'account-1', 'auth-source': 'env' }).catch(error => error);
    expect(thrown).toBeInstanceOf(AuthRequiredError);
    assertSecretFree(thrown.message);
    assertSecretFree(toEnvelope(thrown));
  });

  it('surfaces browser login timeout as TimeoutError without leaking page credentials', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const page = {
      evaluate: vi.fn(async () => ({ href: `https://mp.weixin.qq.com/?token=${encodeURIComponent(secrets.token)}`, hasLoginUi: true })),
      getCookies: vi.fn(async () => [{ name: 'session', value: secrets.cookieValue, domain: '.mp.weixin.qq.com' }]),
      goto: vi.fn(async () => undefined), focusWindow: vi.fn(async () => undefined),
      wait: vi.fn(async (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000)),
    };
    const thrown = await command('articles').func!(page as never, { fakeid: 'account-1', 'auth-source': 'browser' }).catch(error => error);
    expect(thrown).toBeInstanceOf(TimeoutError);
    assertSecretFree(toEnvelope(thrown));
  });

  it('surfaces malformed API data as CommandExecutionError and redacts raw and encoded secrets', async () => {
    envAuth();
    const detail = `token=${secrets.token} cookie=${cookie} fingerprint=${secrets.fingerprint} encoded=${encodeURIComponent(secrets.cookieValue)}`;
    vi.stubGlobal('fetch', vi.fn(async () => response({ base_resp: { ret: 0 }, publish_page: `{${JSON.stringify(detail)}` })));
    const thrown = await command('articles').func!(null, { fakeid: 'account-1', 'auth-source': 'env' }).catch(error => error);
    expect(thrown).toBeInstanceOf(CommandExecutionError);
    const serialized = toEnvelope(thrown);
    assertSecretFree(thrown.message);
    assertSecretFree(serialized);
    assertSecretFree(await captureRender(serialized, 'json'));
    assertSecretFree(await captureRender(serialized, 'yaml'));
  });
});
