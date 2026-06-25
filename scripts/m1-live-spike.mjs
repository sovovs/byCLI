/**
 * M1 live spike (#2 + P0-4 live no-hit): drive REAL Chrome via CDP, prove that
 * Fetch.enable can arm before-send interception and that a 302 redirect to a
 * forbidden target reaches that target ZERO times.
 *
 * Self-contained: no test framework, no repo imports. Run with:
 *   node scripts/m1-live-spike.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const log = (...a) => console.log('[spike]', ...a);

let forbiddenHits = 0;
let redirectHits = 0;

// ── 1. forbidden target server (must receive 0 requests) ──────────────────
const forbidden = http.createServer((req, res) => {
  forbiddenHits++;
  log(`!!! FORBIDDEN target HIT: ${req.method} ${req.url}`);
  res.end('forbidden-body');
});
// ── 2. redirect server: 302 → forbidden target ───────────────────────────
const redirector = http.createServer((req, res) => {
  redirectHits++;
  res.writeHead(302, { Location: `http://127.0.0.1:${forbidden.address().port}/secret` });
  res.end();
});

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r()));

async function cdp(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 10000);
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data.toString());
      if (msg.id === id) {
        clearTimeout(t);
        ws.removeEventListener('message', onMsg);
        msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  await listen(forbidden);
  await listen(redirector);
  log(`forbidden=127.0.0.1:${forbidden.address().port}  redirector=127.0.0.1:${redirector.address().port}`);

  const userDir = mkdtempSync(join(tmpdir(), 'm1-spike-'));
  const port = 9333;
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    // wait for CDP endpoint
    let wsUrl;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        wsUrl = (await r.json()).webSocketDebuggerUrl;
        if (wsUrl) break;
      } catch { /* retry */ }
    }
    if (!wsUrl) throw new Error('Chrome CDP endpoint never came up');
    log('CDP up:', wsUrl);

    const ws = new WebSocket(wsUrl);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

    // Create a fresh page target and attach to it (flat).
    const { targetId } = await cdp(ws, 'Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp(ws, 'Target.attachToTarget', { targetId, flatten: true });

    // session-scoped send
    const sCdp = (method, params = {}) => {
      const id = Math.floor(Math.random() * 1e9);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 10000);
        const onMsg = (ev) => {
          const msg = JSON.parse(ev.data.toString());
          if (msg.id === id) {
            clearTimeout(t);
            ws.removeEventListener('message', onMsg);
            msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result);
          }
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, sessionId, method, params }));
      });
    };

    // ── ARM Fetch interception on Document/Request stage BEFORE navigating ──
    await sCdp('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
    log('Fetch.enable OK — interception armed');

    const forbiddenPort = forbidden.address().port;
    let blockedUrl = null;

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data.toString());
      if (msg.sessionId !== sessionId || msg.method !== 'Fetch.requestPaused') return;
      const { requestId, request, resourceType } = msg.params;
      const isForbidden = request.url.includes(`127.0.0.1:${forbiddenPort}`);
      if (isForbidden) {
        blockedUrl = request.url;
        log(`BLOCK before-send: ${request.url}`);
        ws.send(JSON.stringify({ id: Math.floor(Math.random() * 1e9), sessionId,
          method: 'Fetch.failRequest', params: { requestId, errorReason: 'BlockedByClient' } }));
      } else {
        ws.send(JSON.stringify({ id: Math.floor(Math.random() * 1e9), sessionId,
          method: 'Fetch.continueRequest', params: { requestId } }));
      }
    });

    // Navigate to the redirector → it 302s to the forbidden target.
    await sCdp('Page.enable');
    await sCdp('Page.navigate', { url: `http://127.0.0.1:${redirector.address().port}/start` });

    // give redirect + any (blocked) follow-up time to happen
    await new Promise((r) => setTimeout(r, 2500));

    log('--- RESULTS ---');
    log(`redirector hits = ${redirectHits} (expect >=1)`);
    log(`forbidden hits  = ${forbiddenHits} (expect 0)`);
    log(`blocked url     = ${blockedUrl}`);

    const pass = redirectHits >= 1 && forbiddenHits === 0 && blockedUrl !== null;
    log(pass ? '✅ PASS: Fetch armed before-send AND forbidden target got 0 requests' :
              '❌ FAIL: see counts above');
    ws.close();
    process.exitCode = pass ? 0 : 1;
  } finally {
    chrome.kill('SIGKILL');
    forbidden.close(); redirector.close();
    try { rmSync(userDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { log('ERROR', e.message); process.exitCode = 1;
  try { rmSync; } catch {} });
