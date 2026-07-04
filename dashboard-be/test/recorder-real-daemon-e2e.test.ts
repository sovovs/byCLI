// 端到端真实联调(Tier A):真前端 httpRecorderClient → 真 be → **真 daemon 子进程(dist)** → 假 WS 扩展。
//
// 与 recorder-e2e-client.test.ts(桩 daemon)的差别:这里 spawn 真 daemon(dist/src/daemon.js),be 的
// ctx.daemon **不被覆盖**、经真实 daemonBridge 打到子进程;于是 init 真写 tmp HOME 下 adapter(真 FS
// 事务)、verify 真 spawn runner 子进程执行渲染出的适配器。假扩展只代浏览器 IO(navigate/capture);
// daemon 的 /v1/init、/v1/verify、/v1/requests 全部真实执行——这正是把「be ↔ 真 daemon」一段从桩转真。
//
// 隔离:子进程 env 设 HOME=<tmp>(init 写 <tmp>/.bycli/...,不污染真 ~/.bycli)+ BYCLI_DAEMON_PORT=<空闲端口>
// (避开 19825,不影响用户自己的 daemon)。门控:仅 BYCLI_RECORDER_E2E=1 运行(见 vitest.config.ts),
// 默认 `npm test` 不触发。需先 `npm run build`(daemon 与 verify runner 子进程都跑 dist,见计划关键事实)。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
// 跨包引用前端真实 client(纯 import type 在运行时擦除;运行时用 createHttpRecorderClient 工厂)
import { createHttpRecorderClient } from '../../dashboard/src/services/httpRecorderClient';
// UI model 的真实派生逻辑(纯模块,跨包复用):把"真候选→派生名→init/verify"路径纳入 Tier A 回归。
import { deriveAdapterName } from '../../dashboard/src/models/adapterName';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DAEMON_JS = path.join(ROOT, 'dist/src/daemon.js');

// rankable 抓包条目(形状对齐 recorder-e2e-client.test.ts;A/B 用不同 keyword 让 rank 有差异)。
// producer-of-record = extension/cdp.ts;字段集中在这里,协议漂移时只改这一处。
const rankableEntry = (kw: string) => ({
  requestId: `net_${kw}`,
  method: 'GET',
  url: `https://x.com/api/search?keyword=${kw}`,
  responseStatus: 200,
  responseContentType: 'application/json',
  responsePreview: JSON.stringify([{ title: 't', url: 'u' }]),
  startedAt: 0,
  durationMs: 50,
});

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${String(lastErr)}` : ''}`);
}

// 假扩展:用 Node 全局 WebSocket(Node 22+)连真 daemon 的 /ext。Node WS client 默认不发 Origin 头,
// 通过 daemon verifyClient(只放行无 origin / chrome-extension://)。
// **忠实于真扩展(否则会掩盖真 bug,真扩展实测踩过)**:
//  - hello 注册在**非 'default'** 的 contextId(真扩展是生成的 profile id)→ 要求 be 别写死 'default',
//    而是留空让 daemon 单连接回退路由(守卫 contextId 缺口)。
//  - navigate 的 page 只放命令结果**顶层**(reply 第 2 参),不放 data 里(守卫 page-lease 形状缺口)。
// 只代 3 个 action;init/verify 不经扩展,由真 daemon 自行执行。
function startFakeExtension(port: number): { close: () => Promise<void> } {
  let reads = 0;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', contextId: 'e2e-profile', version: 'e2e', compatRange: '*' }));
  });
  ws.addEventListener('message', (ev: MessageEvent) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
    if (typeof msg.type === 'string') return; // 非命令帧(log 等)
    const id = msg.id;
    const reply = (data: unknown, page?: string) => ws.send(JSON.stringify({ id, ok: true, data, page }));
    // 回归守卫:真扩展强制每条浏览器命令带非空 session(getSessionName → session_required)。
    // be 若退回不发 session,这里直接回错 → Tier A 变红。见记忆 be-missing-session-breaks-real-extension。
    if (typeof msg.session !== 'string' || !msg.session) {
      return ws.send(JSON.stringify({ id, ok: false, errorCode: 'session_required', error: 'Browser session is required.' }));
    }
    switch (msg.action) {
      case 'navigate':
        // page(targetId)只放结果顶层(reply 第 2 参),data 里**不**带 page —— 忠实于真扩展形状。
        return reply({ url: msg.url, title: 'X' }, 'page-1');
      case 'network-capture-start':
        return reply({}, typeof msg.page === 'string' ? msg.page : 'page-1');
      case 'network-capture-read':
        // data 必须是数组(be 用 Array.isArray 判);A/B 两次读用不同 keyword。
        return reply([rankableEntry(reads++ === 0 ? 'cat' : 'dog')], typeof msg.page === 'string' ? msg.page : 'page-1');
      default:
        return reply({}, typeof msg.page === 'string' ? msg.page : 'page-1');
    }
  });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.addEventListener('close', () => resolve());
        ws.close();
      }),
  };
}

const cfg = loadConfig({
  RECORDER_TOKEN: 'e2e-token-1234567890abcdef',
  LOG_LEVEL: 'error',
  RECORDER_ALLOWED_ORIGINS: 'http://127.0.0.1:8000',
  BYCLI_DAEMON_PORT: '19825', // 仅占位过校验;beforeAll 取空闲端口后用 {...cfg, DAEMON_PORT} 注入真值
  RECORDER_MAX_ACTIVE_SESSIONS: '10',
});

const distMissing = !fs.existsSync(DAEMON_JS);

let daemonProc: ChildProcess | null = null;
let daemonLog = '';
let daemonPort = 0; // hoisted so the LLM-synthesis test can spin a 2nd be app against the same daemon
let tmpHome = '';
let fakeExt: { close: () => Promise<void> } | null = null;
let server: ReturnType<typeof createApp>['server'] | null = null;
let client: ReturnType<typeof createHttpRecorderClient>;

beforeAll(async () => {
  if (distMissing) return; // it() 会 skip 并给出明确原因
  daemonPort = await getFreePort();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-recorder-e2e-'));

  // 渲染出的适配器 `import '@sovovs/bycli/registry'`,但被写到 tmpHome 下、从那里向上走 node_modules
  // 找不到包。软链 tmpHome/node_modules/@sovovs/bycli → 仓库根,模拟生产里包已安装的解析环境,
  // 让 verify runner 子进程能真加载并执行适配器(否则停在 stage:load adapter_runtime_error)。
  const scope = path.join(tmpHome, 'node_modules', '@sovovs');
  fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(ROOT, path.join(scope, 'bycli'), 'dir');

  // 1) spawn 真 daemon(dist),自定义 HOME + 端口。detached 便于 afterAll 杀整个进程组(含 runner 孙进程)。
  daemonProc = spawn(process.execPath, [DAEMON_JS], {
    detached: true,
    env: { ...process.env, HOME: tmpHome, BYCLI_DAEMON_PORT: String(daemonPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemonProc.stdout?.on('data', (d) => { daemonLog += d.toString(); });
  daemonProc.stderr?.on('data', (d) => { daemonLog += d.toString(); });

  // 2) 等 daemon /ping 就绪(/ping 不需要 X-byCLI 头)
  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/ping`).catch(() => null);
    return !!res && res.ok;
  }, 15_000, `daemon /ping${daemonLog ? `\n[daemon] ${daemonLog.slice(-2000)}` : ''}`);

  // 3) 连假扩展,等 daemon /status 报 extensionConnected:true
  fakeExt = startFakeExtension(daemonPort);
  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/status`, { headers: { 'X-byCLI': '1' } }).catch(() => null);
    if (!res || !res.ok) return false;
    const s = (await res.json()) as { extensionConnected?: boolean };
    return s.extensionConnected === true;
  }, 15_000, 'extension connected to real daemon');

  // 4) 起真 be(DAEMON_PORT 指向子进程;**不覆盖 ctx.daemon**)
  const liveCfg = { ...cfg, DAEMON_PORT: daemonPort };
  const app = createApp(liveCfg);
  server = app.server;
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const bePort = (server!.address() as AddressInfo).port;

  // 5) 真前端 client
  client = createHttpRecorderClient({
    enabled: true,
    baseUrl: `http://127.0.0.1:${bePort}`,
    token: cfg.TOKEN,
    csrfToken: app.ctx.vault.csrfToken,
  });
}, 40_000);

afterAll(async () => {
  await fakeExt?.close().catch(() => {});
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  // 杀整个进程组(daemon + verify runner 孙进程)。detached spawn 才能用 -pid。
  if (daemonProc?.pid) {
    try { process.kill(-daemonProc.pid, 'SIGTERM'); } catch { /* 已退出 */ }
  }
  if (tmpHome) {
    for (let i = 0; i < 3; i++) {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  }
});

describe('Tier A 端到端:真 client → 真 be → 真 daemon 子进程 → 假扩展(全 8 步,无 Chrome)', () => {
  it('health → bind → navigate → captureA/B → rank → init(预览+写入,真写 FS) → verify(真 spawn runner)', async () => {
    if (distMissing) {
      const msg = `dist 未构建(缺 ${DAEMON_JS});先 npm run build`;
      if (process.env.CI) throw new Error(msg);
      console.warn(`skipped — ${msg}`);
      return;
    }

    // health:真 daemon /status 在线 + 假扩展已连
    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.data?.daemon).toBe('ok');
    expect(health.data?.extension).toBe('ok');

    // bind existing → session_bound
    const bind = await client.bind('existing');
    expect(bind.ok, JSON.stringify(bind.error)).toBe(true);
    expect(bind.data?.sessionId).toMatch(/^rec_/);

    // navigate → page_ready(假扩展回 page lease,真 daemon 透传)
    const nav = await client.navigate('https://x.com');
    expect(nav.ok, JSON.stringify(nav.error)).toBe(true);

    // capture A/B:start(带 trigger 过 be 校验)+ read(be 冻结样本)
    expect((await client.captureStart('A')).ok, 'captureStart A').toBe(true);
    const capA = await client.captureRead('A');
    expect(capA.ok, JSON.stringify(capA.error)).toBe(true);
    expect(capA.data?.entries.length).toBeGreaterThan(0);
    // B 录制:先重新 navigate 开页面 b(B 每次新开全新页面;capture_a→page_ready),再 start+read
    expect((await client.navigate('https://x.com')).ok, 'navigate B').toBe(true);
    expect((await client.captureStart('B')).ok, 'captureStart B').toBe(true);
    expect((await client.captureRead('B')).ok).toBe(true);

    // rank → {candidates, scorePrompt}
    const rank = await client.rank();
    expect(rank.ok, JSON.stringify(rank.error)).toBe(true);
    expect(Array.isArray(rank.data?.candidates)).toBe(true);
    expect(rank.data!.candidates.length).toBeGreaterThan(0);
    const candidate = rank.data!.candidates[0];
    const candidateId = candidate.id;
    // 用 UI model 的真实派生逻辑从真候选派生名(而非传死名),把"派生名→init/verify"路径纳入回归。
    // 抓包 url 是 x.com/api/search → 候选 endpoint host=x.com/pathname=/api/search → 派生 'x-com/search'。
    const name = deriveAdapterName(candidate);
    expect(name).toBe('x-com/search');
    const [site, command] = name.split('/');

    // init dry-run 预览(真 daemon /v1/init,writePolicy=dry-run 不写盘)
    const preview = await client.init(name, candidateId, 'dry-run');
    expect(preview.ok, JSON.stringify(preview.error)).toBe(true);
    expect(preview.data?.report.adapterPath).toContain(command);
    expect(preview.data?.dryRun).toBeDefined();

    // init write(ADR-0005 责任声明)→ 真 daemon 真写 FS 事务到 tmp HOME
    const write = await client.init(name, candidateId, 'write', Date.now());
    expect(write.ok, JSON.stringify(write.error)).toBe(true);
    // 真断言 FS:适配器文件真的落到了 <tmpHome>/.bycli/clis/<site>/<command>.js(证明 daemon /v1/init 真事务)
    const adapterFile = path.join(tmpHome, '.bycli', 'clis', site, `${command}.js`);
    expect(fs.existsSync(adapterFile), `adapter 未写到 ${adapterFile}`).toBe(true);
    expect(fs.readFileSync(adapterFile, 'utf-8')).toContain('@generated-by adapter-recorder');

    // verify → 202 + 轮询;真 daemon 真 spawn verify-runner 子进程执行渲染出的适配器。
    // PUBLIC 适配器(候选无 authRequired)→ browser:false → runner 直接执行 func(体为 return [])
    // → 终态 rows:0。rows>0/matched 需真适配器实现(Tier B),不在 Tier A 范围。
    const verify = await client.verify(name);
    expect(verify.ok, JSON.stringify(verify.error)).toBe(true);
    // 真实终态(已观测):runner 子进程真加载并执行了渲染出的适配器。
    // stage:'execute' + rows:0 是 PUBLIC 适配器的预期终态(func 体为 `return []`)——证明全链跑通;
    // rows>0/matched 需真适配器实现 + 真浏览器抓数,属 Tier B,不是 bug。
    expect(verify.data?.ok).toBe(true);
    expect(verify.data?.stage).toBe('execute');
    expect(verify.data?.rows).toBe(0);
  }, 60_000);

  // LLM 合成 on(注入 fake 合成器,返回静态 return 的 func):验证「funcBody → 真 daemon 渲染 →
  // 真 adapter 文件含 func → 真 verify-runner 执行 → rows>0」整条端到端。与上面的空模板用例互不干扰
  // (第二个 be app 启用 LLM;适配器名相同 x-com/search,write 覆盖上面的——上面断言已先跑完)。
  it('LLM 合成 on → dry-run 出含 func 的 generatedSource、write 写入真 func、verify 真执行得 rows>0', async () => {
    if (distMissing) {
      const msg = `dist 未构建(缺 ${DAEMON_JS});先 npm run build`;
      if (process.env.CI) throw new Error(msg);
      console.warn(`skipped — ${msg}`);
      return;
    }
    // 第二个 be app:启用 LLM,指向同一个真 daemon;注入 fake 合成器(verify 能真执行的静态 func)。
    const llmCfg = loadConfig({
      RECORDER_TOKEN: 'e2e-token-llm-1234567890ab',
      LOG_LEVEL: 'error',
      RECORDER_ALLOWED_ORIGINS: 'http://127.0.0.1:8000',
      BYCLI_DAEMON_PORT: '19825',
      RECORDER_MAX_ACTIVE_SESSIONS: '10',
      FEATURE_LLM_SYNTHESIS: '1',
      RECORDER_LLM_API_KEY: 'test-key',
    });
    const app2 = createApp({ ...llmCfg, DAEMON_PORT: daemonPort });
    app2.ctx.synthesizer = {
      async synthesize() {
        return {
          funcBody: '    return [{ title: "x", url: "u" }];',
          columns: [{ name: 'title', path: '$[].title', type: 'string' }],
          description: 'gen', access: 'read',
        };
      },
    };
    await new Promise<void>((r) => app2.server.listen(0, '127.0.0.1', () => r()));
    const port2 = (app2.server.address() as AddressInfo).port;
    const client2 = createHttpRecorderClient({ enabled: true, baseUrl: `http://127.0.0.1:${port2}`, token: llmCfg.TOKEN, csrfToken: app2.ctx.vault.csrfToken });
    try {
      await client2.bind('existing');
      await client2.navigate('https://x.com');
      await client2.captureStart('A'); await client2.captureRead('A');
      await client2.navigate('https://x.com');
      await client2.captureStart('B'); await client2.captureRead('B');
      const rank = await client2.rank();
      const cand = rank.data!.candidates[0];
      const name = deriveAdapterName(cand);
      const [site, command] = name.split('/');

      // dry-run 带 egress 同意(P0-2):generatedSource 含 LLM provenance + 生成的 func
      const preview = await client2.init(name, cand.id, 'dry-run', undefined, Date.now());
      expect(preview.ok, JSON.stringify(preview.error)).toBe(true);
      expect(preview.data?.generatedSource).toContain('@generated-by adapter-recorder-llm');
      expect(preview.data?.generatedSource).toContain('return [{ title: "x", url: "u" }];');

      // write:真 adapter 文件含 func(非空骨架);复用已同意的合成
      const write = await client2.init(name, cand.id, 'write', Date.now(), Date.now());
      expect(write.ok, JSON.stringify(write.error)).toBe(true);
      const adapterFile = path.join(tmpHome, '.bycli', 'clis', site, `${command}.js`);
      const src = fs.readFileSync(adapterFile, 'utf-8');
      expect(src).toContain('@generated-by adapter-recorder-llm');
      expect(src).toContain('return [{ title: "x", url: "u" }];');
      expect(src).not.toContain('// TODO: implement data fetching');

      // verify:真 spawn runner 执行 LLM func → rows>0(证明生成的代码真能跑)
      const verify = await client2.verify(name);
      expect(verify.ok, JSON.stringify(verify.error)).toBe(true);
      expect(verify.data?.stage).toBe('execute');
      expect(verify.data?.rows).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((r) => app2.server.close(() => r()));
    }
  }, 60_000);
});
