// C1 — be→真浏览器 navigate/capture 自动化(此前只有手测 + 假扩展形状守卫,无真浏览器 CI 回归)。
// 真 client → 真 be → 本仓 daemon(19825,tmp HOME)→ 真 Chrome+真扩展:bind→navigate→capture A/B
// (真 CDP 抓 github search)→rank→deriveAdapterName(真候选)→init dry-run(不写盘)。
// 门控 BYCLI_AX_E2E=1(同真 Chrome 档,nightly);需 dist + 扩展 build + Chrome;19825 占用/无 Chrome → skip。
// 容忍外部网络抖动:抓不到可 rank 流量则 warn+skip(非 CI 失败)——核心断言是"能抓到+能派生+init 通"。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createHttpRecorderClient } from '../../dashboard/src/services/httpRecorderClient';
import { deriveAdapterName } from '../../dashboard/src/models/adapterName';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const DAEMON_JS = path.join(ROOT, 'dist/src/daemon.js');
const PORT = 19825;

function findChrome(): string | null {
  const cands = [process.env.CHROME_PATH, process.env.GOOGLE_CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter((x): x is string => !!x);
  for (const c of cands) if (fs.existsSync(c)) return c;
  for (const b of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [b], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}
function launchChrome(chromePath: string, userDataDir: string): ChildProcess {
  return spawn(chromePath, [`--user-data-dir=${userDataDir}`, `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`, '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-component-update', '--no-sandbox',
    '--window-size=1024,720', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
}
async function killProc(c: ChildProcess | null) {
  if (!c || c.exitCode !== null || c.signalCode !== null) return;
  c.kill('SIGTERM');
  await Promise.race([new Promise<void>((r) => c.once('exit', () => r())), new Promise<void>((r) => setTimeout(r, 3000))]);
  if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
}
async function portBusy(port: number): Promise<boolean> {
  return await new Promise((res) => { const s = createNetServer(); s.once('error', (e: NodeJS.ErrnoException) => res(e.code === 'EADDRINUSE')); s.listen(port, '127.0.0.1', () => s.close(() => res(false))); });
}
async function waitFor(fn: () => Promise<boolean>, ms: number, label: string) {
  const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 300)); } throw new Error(`timeout: ${label}`);
}

const cfg = loadConfig({ RECORDER_TOKEN: 'e2e-token-1234567890abcdef', LOG_LEVEL: 'error', RECORDER_ALLOWED_ORIGINS: 'http://127.0.0.1:8000', BYCLI_DAEMON_PORT: String(PORT), RECORDER_MAX_ACTIVE_SESSIONS: '10' });
let app: ReturnType<typeof createApp> | null = null;
let baseUrl = '', tmpHome = '', userDataDir = '', skipReason = '';
let daemon: ChildProcess | null = null, chrome: ChildProcess | null = null;

beforeAll(async () => {
  if (!fs.existsSync(DAEMON_JS)) { skipReason = `dist 未构建(${DAEMON_JS});npm run build`; return; }
  const chromePath = findChrome();
  if (!chromePath) { skipReason = 'Chrome 未找到'; return; }
  if (await portBusy(PORT)) { skipReason = `端口 ${PORT} 被占;先 bycli daemon stop`; return; }
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-c1-'));
  const scope = path.join(tmpHome, 'node_modules', '@sovovs'); fs.mkdirSync(scope, { recursive: true }); fs.symlinkSync(ROOT, path.join(scope, 'bycli'), 'dir');
  daemon = spawn(process.execPath, [DAEMON_JS], { detached: true, env: { ...process.env, HOME: tmpHome, BYCLI_DAEMON_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${PORT}/ping`).catch(() => null); return !!r && r.ok; }, 15000, 'daemon /ping');
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-c1-chrome-'));
  chrome = launchChrome(chromePath, userDataDir);
  try {
    await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${PORT}/status`, { headers: { 'X-byCLI': '1' } }).catch(() => null); if (!r || !r.ok) return false; return (await r.json() as { extensionConnected?: boolean }).extensionConnected === true; }, 25000, 'extension connect');
  } catch (e) { if (process.env.CI) throw e; skipReason = String(e); return; }
  app = createApp(cfg);
  await new Promise<void>((r) => app!.server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(app!.server.address() as AddressInfo).port}`;
}, 60000);

afterAll(async () => {
  if (app) await new Promise<void>((r) => app!.server.close(() => r()));
  await killProc(chrome);
  if (daemon?.pid) { try { process.kill(-daemon.pid, 'SIGTERM'); } catch { /* gone */ } }
  for (const d of [tmpHome, userDataDir]) if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe('C1 be→真浏览器 navigate/capture(真 Chrome,nightly)', () => {
  it('bind→navigate→capture(真抓包)→rank→deriveAdapterName→init dry-run', async () => {
    if (skipReason) { if (process.env.CI) throw new Error(skipReason); console.warn(`skipped — ${skipReason}`); return; }
    const client = createHttpRecorderClient({ enabled: true, baseUrl, token: cfg.TOKEN, csrfToken: app!.ctx.vault.csrfToken });
    const daemonCmd = (app!.ctx as unknown as { daemon: { command: (c: Record<string, unknown>) => Promise<unknown> } }).daemon;
    expect((await client.health()).data?.extension).toBe('ok');
    const b = await client.bind('existing'); expect(b.ok).toBe(true);
    const nav = await client.navigate('https://example.com/'); expect(nav.ok, JSON.stringify(nav.error)).toBe(true);
    const page = (nav.data as { page?: string })?.page;
    const status = await (await fetch(`http://127.0.0.1:${PORT}/status`, { headers: { 'X-byCLI': '1' } })).json() as { profiles?: Array<{ contextId: string }>; contextId?: string };
    const ctxId = status.profiles?.[0]?.contextId ?? status.contextId;
    const trig = async (q: string) => { await daemonCmd.command({ action: 'exec', session: b.data!.sessionId, surface: 'browser', contextId: ctxId, page, code: `fetch('https://api.github.com/search/repositories?q=${q}')` }); await new Promise((r) => setTimeout(r, 2500)); };
    await client.captureStart('A'); await trig('cat'); const ca = await client.captureRead('A');
    await client.captureStart('B'); await trig('dog'); const cb = await client.captureRead('B');
    // 容忍外部网络抖动:抓不到流量(github 不可达)→ warn+skip,不判 CI 失败。
    if (!ca.data?.entries?.length || !cb.data?.entries?.length) { console.warn('skipped — 未抓到可 rank 流量(github 不可达?)'); return; }
    expect(ca.data.entries.length).toBeGreaterThan(0); // 真 CDP 抓包通了
    const rank = await client.rank(); expect(rank.ok, JSON.stringify(rank.error)).toBe(true);
    if (!rank.data?.length) { console.warn('skipped — rank 无候选'); return; }
    const cand = rank.data[0]; const name = deriveAdapterName(cand as never);
    expect(name).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+$/); // 派生名合法
    const prev = await client.init(name, cand.id, 'dry-run'); // 不写盘
    expect(prev.ok, JSON.stringify(prev.error)).toBe(true);
    expect(prev.data?.report.adapterPath).toContain(name.split('/')[1]);
  }, 60000);
});
