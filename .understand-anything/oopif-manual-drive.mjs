#!/usr/bin/env node
// OOPIF 录制真机手动驱动。起真 daemon(19825),等扩展连上,navigate 到测试页,
// 开 network+ui capture,自动触发顶层 fetch,等你手点 iframe,读回 capture 打印 frameSessionId/frameUrl。
//
// 跑法:
//   1. 已停常驻 daemon、扩展(1.0.26)已装、测试页已起在 127.0.0.1:8899
//   2. node .understand-anything/oopif-manual-drive.mjs
//   3. 脚本会等扩展连上 → 自动 navigate + 顶层 fetch;然后【你在弹出的 Chrome tab 里点 iframe 表单】
//   4. 回车继续 → 脚本读回 capture 并打印
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_JS = path.join(ROOT, 'dist/src/daemon.js');
const PORT = 19825;
// 注:不能用 http://127.0.0.1 —— 录制器 url-policy 禁字面环回 IP(M1 SSRF 防护,navigation_blocked_by_policy)。
// localtest.me 是公共 DNS,*.localtest.me 解析到 127.0.0.1;作为「域名」过 syntax 检查(SW 无 DNS 关不掉),
// 浏览器解析后仍命中本地 8899 server。
const TEST_URL = 'http://oopif.localtest.me:8899/oopif-test-page.html';
const H = { 'Content-Type': 'application/json', 'X-byCLI': '1' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (q) => new Promise((res) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); res(a); });
});
let _cmdSeq = 0;
async function cmd(body) {
  // daemon/扩展要求每条命令带唯一 id,否则回 "Missing command id"。
  const withId = { id: `c${Date.now()}-${++_cmdSeq}`, ...body };
  const r = await fetch(`http://127.0.0.1:${PORT}/command`, { method: 'POST', headers: H, body: JSON.stringify(withId) });
  return r.json().catch(() => ({}));
}
async function status() {
  const r = await fetch(`http://127.0.0.1:${PORT}/status`, { headers: { 'X-byCLI': '1' } }).catch(() => null);
  return r && r.ok ? r.json() : null;
}

const daemon = spawn(process.execPath, [DAEMON_JS], { env: { ...process.env, BYCLI_DAEMON_PORT: String(PORT) }, stdio: ['ignore', 'inherit', 'inherit'] });
process.on('exit', () => { try { daemon.kill(); } catch {} });

console.log('等 daemon /ping...');
for (let i = 0; i < 30; i++) { const r = await fetch(`http://127.0.0.1:${PORT}/ping`).catch(() => null); if (r && r.ok) break; await sleep(500); }
console.log('daemon 起来了。现在确认扩展(1.0.26)已装且连上 daemon...');
let st = null;
for (let i = 0; i < 60; i++) { st = await status(); if (st && st.extensionConnected) break; await sleep(500); }
if (!st || !st.extensionConnected) { console.error('扩展没连上 daemon。检查:扩展已装、版本 1.0.26、popup 显示已连接。'); process.exit(1); }
console.log('扩展已连接 ✓');

const session = `oopif-${Date.now()}`;
const ctxId = st.profiles?.[0]?.contextId ?? st.contextId;
console.log('bind...');
const bnd = await cmd({ action: 'bind', session, surface: 'browser', contextId: ctxId });
console.log('bind result:', JSON.stringify(bnd));
console.log(`navigate → ${TEST_URL}`);
const nav = await cmd({ action: 'navigate', session, surface: 'browser', contextId: ctxId, url: TEST_URL });
console.log('navigate FULL result:', JSON.stringify(nav));
const page = nav?.page ?? nav?.data?.page; // page lease 在响应顶层
if (!nav?.ok) {
  console.error('\n❌ navigate 失败,完整响应见上。常见原因:errorCode=navigation_blocked_by_policy(URL 被策略挡)/ 缺 page lease。停。');
  process.exit(1);
}
console.log('navigate ok, page =', page);

console.log('开 network + ui capture...');
await cmd({ action: 'network-capture-start', session, surface: 'browser', contextId: ctxId, page });
await cmd({ action: 'ui-capture-start', session, surface: 'browser', contextId: ctxId, page });

console.log('自动触发顶层 fetch(top-btn)...');
await cmd({ action: 'exec', session, surface: 'browser', contextId: ctxId, page, code: `document.getElementById('top-btn').click()` });
await sleep(2000);

await ask('\n>>> 在打开的测试页里:① 等掘金 iframe 加载完。② 【关键】在 iframe 内点击/输入/滚动\n    (比如点掘金的搜索框打字、点导航、点文章)——这是验 iframe 内 UI 操作录制。\n    顶层也点一下「顶层:发一条 top fetch」按钮做对照。完成后按回车读回 capture...\n');

console.log('读回 network capture...');
const net = await cmd({ action: 'network-capture-read', session, surface: 'browser', contextId: ctxId, page });
console.log('network-capture-read FULL:', JSON.stringify(net).slice(0, 400));
const entries = Array.isArray(net?.data?.entries) ? net.data.entries
  : Array.isArray(net?.entries) ? net.entries
  : Array.isArray(net?.data) ? net.data
  : [];
console.log(`\n=== network entries: ${entries.length} ===`);
const netByFrame = {};
for (const e of entries) { const k = e.frameSessionId ? `OOPIF ${e.frameUrl ?? e.frameSessionId}` : 'top'; netByFrame[k] = (netByFrame[k] ?? 0) + 1; }
console.log('network 按 frame 分布:', JSON.stringify(netByFrame));

console.log('\n读回 UI capture...');
const ui = await cmd({ action: 'ui-capture-read', session, surface: 'browser', contextId: ctxId, page });
console.log('ui-capture-read FULL:', JSON.stringify(ui).slice(0, 400));
const events = Array.isArray(ui?.data?.events) ? ui.data.events
  : Array.isArray(ui?.events) ? ui.events
  : Array.isArray(ui?.data) ? ui.data
  : [];
console.log(`\n=== UI events: ${events.length}（dropped: ${ui?.data?.dropped ?? '?'}）===`);
for (const ev of events) {
  const tag = ev.frameSessionId ? `  [OOPIF sid=${ev.frameSessionId} frameUrl=${ev.frameUrl ?? '?'}]` : '  [top]';
  const detail = ev.url ? ev.url : `${ev.selector ?? ''}${ev.valueShape ? ' valueShape='+JSON.stringify(ev.valueShape) : ''}${ev.key ? ' key='+ev.key : ''}`;
  console.log(`${ev.type} ${detail}${tag}`);
}
const oopifUi = events.filter((e) => e.frameSessionId);
console.log(`\n=== 验收 ===`);
console.log(`OOPIF 网络请求: ${entries.filter((e) => e.frameSessionId).length}`);
console.log(`OOPIF UI 事件: ${oopifUi.length}（iframe 内 click/input/keydown,应带 frameSessionId+frameUrl）`);
console.log(`顶层 UI 事件: ${events.filter((e) => !e.frameSessionId).length}（无 frameSessionId）`);
if (oopifUi.length === 0) console.log('⚠️ iframe 内 UI 事件为 0 —— 你是否在 iframe 内(而非顶层/地址栏)实际点击/输入了?');

console.log('\n完成。Ctrl-C 退出(会关 daemon)。');
await ask('');
