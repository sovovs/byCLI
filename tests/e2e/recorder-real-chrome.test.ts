// Tier B-2 端到端(真 Chrome):真 daemon 子进程(dist,19825) + 真 Chrome+真扩展 → verify-runner 子进程
// connect-back 真驱动浏览器出真行(rows:1)。这补的是 scripts/m6b-connect-back-spike.sh 缺的「manual gate
// (连真扩展)」——m6b 在无扩展的 daemon 上只能拿到 extension_not_connected;这里扩展真连着,同样的子进程
// 出真行。不经 be(be→daemon 的 verify 转发由 dashboard-be Tier A 覆盖);证明的是 verify-runner→真浏览器
// 这条 Tier A 桩掉、browser-public e2e 也不覆盖的线。
//
// 门控:仅 BYCLI_AX_E2E=1 纳入(见 vitest.config.ts,与 browser-ax-chrome 同档);需先 npm run build + 扩展
// build;Chrome 缺失 / dist 未构建 / 19825 被占(已有 daemon)→ 本地 skip、CI 报错。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const DAEMON_JS = path.join(ROOT, 'dist/src/daemon.js');
const MAIN_JS = path.join(ROOT, 'dist/src/main.js');
// 浏览器适配器 fixture(browser:true,func 里 page.evaluate('1+1') + return [{ok:1}])。在仓库内,故
// @sovovs/bycli/registry 经 workspace 自解析,无需软链。见 src/recorder/runner/__fixtures__/browser-adapter.mjs。
const FIXTURE = path.join(ROOT, 'src/recorder/runner/__fixtures__/browser-adapter.mjs');
const DAEMON_PORT = 19825; // 扩展硬编码 ws://localhost:19825/ext,真扩展只连这个口

// ── 真 Chrome harness(对照 tests/e2e/browser-ax-chrome.test.ts;此处自含,不改那个本地跑不动的 AX 测试) ──
function findChromeExecutable(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((e): e is string => !!e);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [bin], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

function launchChrome(chromePath: string, userDataDir: string): ChildProcess {
  return spawn(chromePath, [
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--no-sandbox',
    '--window-size=1024,720',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function killProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((r) => child.once('exit', () => r())),
    new Promise<void>((r) => setTimeout(r, 3000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function portInUse(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const srv = createNetServer();
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE'));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(false)));
  });
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${String(lastErr)}` : ''}`);
}

describe('Tier B-2 真 Chrome:verify-runner 接真扩展 connect-back 出真行', () => {
  let daemon: ChildProcess | null = null;
  let chrome: ChildProcess | null = null;
  let tmpHome = '';
  let userDataDir = '';
  let skipReason = '';
  let daemonLog = '';
  let chromeStderr = '';

  beforeAll(async () => {
    if (!fs.existsSync(DAEMON_JS) || !fs.existsSync(MAIN_JS)) {
      skipReason = `dist 未构建(缺 ${DAEMON_JS}/${MAIN_JS});先 npm run build`;
      return;
    }
    const chromePath = findChromeExecutable();
    if (!chromePath) { skipReason = 'Chrome executable not found'; return; }
    if (await portInUse(DAEMON_PORT)) {
      skipReason = `端口 ${DAEMON_PORT} 被占(可能已有 daemon);先 bycli daemon stop 再跑此 e2e`;
      return;
    }

    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-b2-home-'));
    // 真 daemon 子进程(19825,HOME 隔离)。detached → afterAll 用 process.kill(-pid) 收整组(含 runner 孙进程)。
    daemon = spawn(process.execPath, [DAEMON_JS], {
      detached: true,
      env: { ...process.env, HOME: tmpHome, BYCLI_DAEMON_PORT: String(DAEMON_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemon.stdout?.on('data', (d) => { daemonLog += d.toString(); });
    daemon.stderr?.on('data', (d) => { daemonLog += d.toString(); });
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${DAEMON_PORT}/ping`).catch(() => null);
      return !!r && r.ok;
    }, 15_000, `daemon /ping${daemonLog ? `\n[daemon] ${daemonLog.slice(-1500)}` : ''}`);

    // 真 Chrome + 扩展(扩展自动连 19825 的真 daemon)
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-b2-chrome-'));
    chrome = launchChrome(chromePath, userDataDir);
    chrome.stderr?.on('data', (c) => { chromeStderr += c.toString(); if (chromeStderr.length > 20_000) chromeStderr = chromeStderr.slice(-20_000); });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${DAEMON_PORT}/status`, { headers: { 'X-byCLI': '1' } }).catch(() => null);
        if (!r || !r.ok) return false;
        const s = (await r.json()) as { extensionConnected?: boolean };
        return s.extensionConnected === true;
      }, 20_000, 'extension connect to real daemon');
    } catch (err) {
      const tail = chromeStderr.split('\n').slice(-25).join('\n').trim();
      const msg = `${err instanceof Error ? err.message : String(err)}${tail ? `\nChrome stderr:\n${tail}` : ''}`;
      if (process.env.CI) throw new Error(msg);
      skipReason = msg;
    }
  }, 45_000);

  afterAll(async () => {
    await killProcess(chrome);
    if (daemon?.pid) { try { process.kill(-daemon.pid, 'SIGTERM'); } catch { /* 已退出 */ } }
    for (const dir of [tmpHome, userDataDir]) {
      if (!dir) continue;
      for (let i = 0; i < 3; i++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); break; }
        catch { await new Promise((r) => setTimeout(r, 250)); }
      }
    }
  });

  it('verify-runner 子进程 connect-back 到真扩展,执行 browser 适配器出 rows:1', async () => {
    if (skipReason) {
      if (process.env.CI) throw new Error(skipReason);
      console.warn(`skipped — ${skipReason}`);
      return;
    }

    const inputPath = path.join(tmpHome, 'b2-input.json');
    fs.writeFileSync(inputPath, JSON.stringify({
      requestId: 'req_b2_e2e', name: 'm6bsmoke/probe', adapterPath: FIXTURE, executionSeedArgs: {},
    }));

    // 直接跑真 verify-runner 子进程(同 m6b spike),connect-back 到 19825 daemon(env BYCLI_DAEMON_PORT)。
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [
        MAIN_JS, 'internal', 'verify-runner', '--jsonl',
        '--request-id', 'req_b2_e2e', '--name', 'm6bsmoke/probe', '--input', inputPath,
      ], { env: { ...process.env, BYCLI_DAEMON_PORT: String(DAEMON_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { out += d.toString(); });
      child.on('error', reject);
      child.on('close', () => resolve(out));
    });

    // 解析 JSONL,取 result 行。期望 started(stage:load) → result ok:true,stage:execute,rows:1。
    const lines = stdout.trim().split('\n').filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
    const result = lines.find((l) => l.type === 'result');
    expect(result, `no JSONL result line in:\n${stdout}`).toBeTruthy();
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    // connect-back 真驱动浏览器:browser-adapter 的 page.evaluate('1+1') 必须经真扩展才成功 → return [{ok:1}]。
    // 对照:无扩展时此处是 extension_not_connected(m6b spike 的预期)。
    expect(result.data.stage).toBe('execute');
    expect(result.data.rows).toBe(1);
  }, 60_000);
});
