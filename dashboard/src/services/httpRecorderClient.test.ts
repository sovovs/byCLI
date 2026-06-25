// httpRecorderClient 单测:04 门禁 header 注入、sessionId 自动注入/清空、bind mode 映射、
// init/verify 的 202 异步轮询、network_error 映射、Idempotency-Key 开关。
// 仅 mock 全局 fetch(client 不碰 DOM);类型 import 在运行时擦除,故无需 jsdom/alias。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHttpRecorderClient } from './httpRecorderClient';
import type { RecorderBootstrap } from './recorderClient';

const bootstrap: RecorderBootstrap = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:19826',
  token: 'tok-abc',
  csrfToken: 'csrf-xyz',
};

type FetchInit = RequestInit & { headers: Record<string, string>; body?: string };

let fetchMock: ReturnType<typeof vi.fn>;

/** 把任意 envelope 包成 Response-like(httpRecorderClient 只调 res.json())。 */
function res(envelope: unknown): Response {
  return { json: async () => envelope } as unknown as Response;
}

/** 成功 envelope。requestId 默认 r1;poll/callAsync 需要时显式给。 */
const okEnv = (data: unknown, requestId = 'r1') => ({
  ok: true,
  schemaVersion: 'recorder.v1',
  requestId,
  data,
  error: null,
});

function callAt(i: number): { url: string; init: FetchInit } {
  const c = fetchMock.mock.calls[i];
  return { url: c[0] as string, init: c[1] as FetchInit };
}
const last = () => callAt(fetchMock.mock.calls.length - 1);
const bodyOf = (init: FetchInit) => JSON.parse(init.body ?? '{}');

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('httpRecorderClient — 门禁 header 与 transport 形态', () => {
  it('health 用 GET + 全套门禁 header,不带 Content-Type/Idempotency/body', async () => {
    fetchMock.mockResolvedValueOnce(res(okEnv({ localService: 'ok' })));
    const client = createHttpRecorderClient(bootstrap);

    const r = await client.health();

    expect(r.ok).toBe(true);
    const { url, init } = last();
    expect(url).toBe('http://127.0.0.1:19826/recorder/health');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');
    expect(init.headers['X-Recorder']).toBe('1');
    expect(init.headers['X-byCLI-Token']).toBe('tok-abc');
    expect(init.headers['X-CSRF-Token']).toBe('csrf-xyz');
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.headers['Idempotency-Key']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('side-effect POST 带 Content-Type + Idempotency-Key', async () => {
    fetchMock.mockResolvedValueOnce(res(okEnv({ sessionId: 's', state: 'capture_a', stateVersion: 1, sampleName: 'A', started: true })));
    const client = createHttpRecorderClient(bootstrap);

    await client.captureStart('A');

    const { url, init } = last();
    expect(url).toContain('/recorder/capture/start');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['Idempotency-Key']).toBeTruthy();
    expect(bodyOf(init)).toMatchObject({ sampleName: 'A' });
  });

  it('csrfToken 为空时不下发 X-CSRF-Token', async () => {
    fetchMock.mockResolvedValueOnce(res(okEnv({})));
    const client = createHttpRecorderClient({ ...bootstrap, csrfToken: '' });

    await client.health();

    expect(last().init.headers['X-CSRF-Token']).toBeUndefined();
  });

  it('fetch 抛错统一映射为 network_error,不抛出', async () => {
    fetchMock.mockRejectedValueOnce(new Error('conn refused'));
    const client = createHttpRecorderClient(bootstrap);

    const r = await client.rank();

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('network_error');
  });
});

describe('httpRecorderClient — bind 模式映射与 sessionId 生命周期', () => {
  it("bind('await_login') 映射 create_page_await_user_login,不硬编码 contextId", async () => {
    fetchMock.mockResolvedValueOnce(
      res(okEnv({ sessionId: 'sess-1', contextId: 'default', targetId: 't', awaitingLogin: true })),
    );
    const client = createHttpRecorderClient(bootstrap);

    const r = await client.bind('await_login');

    expect(r.ok).toBe(true);
    // 不再发 contextId:'default'(会致真扩展 profile_disconnected);body 只有 mode,be 留空走单连接回退。
    const body = bodyOf(last().init) as Record<string, unknown>;
    expect(body.mode).toBe('create_page_await_user_login');
    expect('contextId' in body).toBe(false);
  });

  it("bind('existing') 映射 bind_existing_page", async () => {
    fetchMock.mockResolvedValueOnce(
      res(okEnv({ sessionId: 's', contextId: 'default', targetId: 't', awaitingLogin: false })),
    );
    const client = createHttpRecorderClient(bootstrap);

    await client.bind('existing');

    expect(bodyOf(last().init).mode).toBe('bind_existing_page');
  });

  it('bind 后 side-effect 自动注入 bind 返回的 sessionId', async () => {
    fetchMock.mockResolvedValueOnce(
      res(okEnv({ sessionId: 'sess-1', contextId: 'default', targetId: 't', awaitingLogin: false })),
    );
    const client = createHttpRecorderClient(bootstrap);
    await client.bind('existing');

    fetchMock.mockResolvedValueOnce(res(okEnv({ url: 'https://x' })));
    await client.navigate('https://x');

    expect(bodyOf(last().init)).toMatchObject({ sessionId: 'sess-1', url: 'https://x' });
  });

  it('bind 之前 side-effect 不注入 sessionId', async () => {
    fetchMock.mockResolvedValueOnce(res(okEnv({ url: 'https://x' })));
    const client = createHttpRecorderClient(bootstrap);

    await client.navigate('https://x');

    expect(bodyOf(last().init)).not.toHaveProperty('sessionId');
  });

  it('cancel 用非幂等(无 Idempotency-Key)、带当前 sessionId,并在之后清空 sessionId', async () => {
    fetchMock.mockResolvedValueOnce(
      res(okEnv({ sessionId: 'sess-9', contextId: 'default', targetId: 't', awaitingLogin: false })),
    );
    const client = createHttpRecorderClient(bootstrap);
    await client.bind('existing');

    fetchMock.mockResolvedValueOnce(res(okEnv({ cancelled: true })));
    await client.cancel();

    const { url, init } = last();
    expect(url).toContain('/recorder/cancel');
    expect(init.headers['Idempotency-Key']).toBeUndefined(); // idempotent:false
    expect(bodyOf(init)).toMatchObject({ scope: 'session', sessionId: 'sess-9' });

    // cancel 后 sessionId 已清空:下一次 side-effect 不再注入
    fetchMock.mockResolvedValueOnce(res(okEnv({ url: 'u' })));
    await client.navigate('u');
    expect(bodyOf(last().init)).not.toHaveProperty('sessionId');
  });
});

describe('httpRecorderClient — init 同步 / verify 202 轮询', () => {
  const INIT_RESULT = {
    report: {
      adapterPath: '~/.bycli/clis/example-com/search.js',
      reportPath: '~/.bycli/sites/example-com/recorder/search-report.json',
      responsibleUseAcknowledgedAt: 0,
      releaseChannel: 'stable',
      localExperimentProfile: 'off',
      configSnapshotVersion: 1,
    },
    dryRun: { exists: false, changedLines: 5 },
  };

  it('init 是同步 POST,直接回 {report,dryRun}(be 200,不轮询)', async () => {
    fetchMock.mockResolvedValueOnce(res(okEnv(INIT_RESULT)));
    const client = createHttpRecorderClient(bootstrap);

    const r = await client.init('example-com/search', 'cand-1', 'dry-run');

    expect(r.ok).toBe(true);
    expect(r.data).toEqual(INIT_RESULT);
    // 单次 POST,无后续轮询;契约 InitRequest required 字段齐全
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callAt(0).url).toContain('/recorder/init');
    expect(bodyOf(callAt(0).init)).toMatchObject({ name: 'example-com/search', selectedCandidateId: 'cand-1', writePolicy: 'dry-run' });
    // dry-run 不带 responsibleUseAcknowledgedAt
    expect(bodyOf(callAt(0).init)).not.toHaveProperty('responsibleUseAcknowledgedAt');
  });

  it('init write 带 responsibleUseAcknowledgedAt(ADR-0005)', async () => {
    fetchMock.mockResolvedValueOnce(res(okEnv(INIT_RESULT)));
    const client = createHttpRecorderClient(bootstrap);

    await client.init('example-com/search', 'cand-1', 'write', 1234);

    expect(bodyOf(callAt(0).init)).toMatchObject({ writePolicy: 'write', responsibleUseAcknowledgedAt: 1234 });
  });

  it('init 失败 envelope 直接透传', async () => {
    fetchMock.mockResolvedValueOnce(
      res({ ok: false, schemaVersion: 'recorder.v1', requestId: 'r', data: null, error: { code: 'invalid_state', message: 'x' } }),
    );
    const client = createHttpRecorderClient(bootstrap);

    const r = await client.init('s/c', 'c', 'dry-run');

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('invalid_state');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('verify 发 202 后轮询 requests/{id} 到 failed,回传 error envelope', async () => {
    fetchMock.mockResolvedValueOnce(res(okEnv({ accepted: true }, 'req-v')));
    fetchMock.mockResolvedValueOnce(
      res(
        okEnv({
          requestId: 'req-v',
          type: 'verify',
          status: 'failed',
          error: { code: 'runner_protocol_error', message: 'boom' },
        }),
      ),
    );
    const client = createHttpRecorderClient(bootstrap);

    const r = await client.verify('example-com/search');

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('runner_protocol_error');
    // 初始 POST 带 name(契约 VerifyRequest required)
    expect(bodyOf(callAt(0).init)).toMatchObject({ name: 'example-com/search' });
    expect(callAt(1).url).toContain('/recorder/requests/req-v');
  });

  it('verify 202 本身失败时直接透传,不进入轮询', async () => {
    fetchMock.mockResolvedValueOnce(
      res({ ok: false, schemaVersion: 'recorder.v1', requestId: '', data: null, error: { code: 'invalid_state', message: 'x' } }),
    );
    const client = createHttpRecorderClient(bootstrap);

    const r = await client.verify('s/c');

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('invalid_state');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
