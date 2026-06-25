/**
 * M1 extension-form live spike (#1): prove that in a REAL extension runtime with
 * the `debugger` permission, `chrome.debugger` can arm Fetch before-send
 * interception and block a 302 redirect to a forbidden target (0 hits).
 *
 * APPROACH (after empirically ruling out two dead ends — see HISTORY):
 *   Launch Chrome with a pinned-id probe extension, open its extension PAGE, attach
 *   to that page target over CDP, and run the arm logic via Runtime.evaluate inside
 *   the extension page context (which has full chrome.debugger / chrome.tabs access,
 *   the same APIs byCLI's service worker uses). Results come back as the eval return
 *   value; the "0 hits" assertion is measured by the local Node HTTP servers the
 *   browser really navigates against — it does NOT depend on the extension
 *   reporting anything back.
 *
 * WHAT THIS PROVES:
 *   chrome.debugger (real extension runtime, `debugger` permission) arms Fetch on
 *   Document/Request stage, intercepts the redirected main-frame request before
 *   send, and failRequest keeps the forbidden target at 0 hits (Codex P1-2 core
 *   capability question — answered).
 * WHAT THIS DOES NOT PROVE:
 *   - byCLI's own MV3 service worker arming this (its SW is daemon-woken; an
 *     --load-extension'd SW stays dormant — confirmed: top-level SW code does not
 *     run without a waker). SW-lifecycle survival mid-navigation is tracked
 *     separately as the remaining extension-form risk.
 *   - DNS-rebinding enforcement (ip-observed-only per ADR-0006).
 *
 * Self-contained regression script. Run with:
 *   node scripts/m1-extension-spike.mjs            # headful (default; most reliable)
 *   node scripts/m1-extension-spike.mjs --headless # try headless=new
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEADLESS = process.argv.includes('--headless');
const log = (...a) => console.log('[ext-spike]', ...a);

let forbiddenHits = 0;
let redirectHits = 0;

const forbidden = http.createServer((req, res) => {
  forbiddenHits++;
  log(`!!! FORBIDDEN target HIT: ${req.method} ${req.url}`);
  res.end('forbidden-body');
});
const redirector = http.createServer((req, res) => {
  redirectHits++;
  res.writeHead(302, { Location: `http://127.0.0.1:${forbidden.address().port}/secret` });
  res.end();
});
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r()));

/** Derive the Chrome extension id (a-p mapping of first 16 bytes of SHA256(DER pubkey)). */
function deriveExtensionId(derPublicKey) {
  const hash = createHash('sha256').update(derPublicKey).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode('a'.charCodeAt(0) + (hash[i] >> 4));
    id += String.fromCharCode('a'.charCodeAt(0) + (hash[i] & 0x0f));
  }
  return id;
}

/** Generate a minimal probe extension with a pinned id and a loadable page. */
function writeProbeExtension(dir) {
  mkdirSync(dir, { recursive: true });
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  const extId = deriveExtensionId(publicKey);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'M1 Fetch Probe',
    version: '1.0.0',
    key: publicKey.toString('base64'),
    permissions: ['debugger', 'tabs'],
    host_permissions: ['<all_urls>'],
    background: { service_worker: 'sw.js', type: 'module' },
  }, null, 2));
  // The page only needs to exist and load; all arm logic is injected via CDP eval.
  writeFileSync(join(dir, 'probe.html'), '<!doctype html><meta charset=utf-8><title>probe</title>');
  writeFileSync(join(dir, 'sw.js'), '// dormant by design; probe runs in probe.html via CDP eval\n');
  return extId;
}

/** Minimal CDP client (optionally session-scoped via sessionId). */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params = {}, sessionId) => {
    const id = Math.floor(Math.random() * 1e9);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 15000);
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data.toString());
        if (msg.id === id) {
          clearTimeout(t);
          ws.removeEventListener('message', onMsg);
          msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify(sessionId ? { id, sessionId, method, params } : { id, method, params }));
    });
  };
  return { ws, ready, send };
}

async function evalInPage(send, sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

async function main() {
  await listen(forbidden);
  await listen(redirector);
  const forbiddenPort = forbidden.address().port;
  const redirectUrl = `http://127.0.0.1:${redirector.address().port}/start`;
  log(`forbidden=127.0.0.1:${forbiddenPort}  redirector=${redirectUrl}`);

  const extDir = mkdtempSync(join(tmpdir(), 'm1-probe-ext-'));
  const extId = writeProbeExtension(extDir);
  log('probe extension:', extDir, 'id:', extId);

  const userDir = mkdtempSync(join(tmpdir(), 'm1-ext-spike-'));
  const port = 9334;
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDir}`,
    `--load-extension=${extDir}`,
    `--disable-extensions-except=${extDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];
  if (HEADLESS) args.unshift('--headless=new');
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });

  try {
    // 1. Browser-level CDP up?
    let verWs;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { verWs = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; if (verWs) break; } catch {}
    }
    if (!verWs) throw new Error('Chrome CDP endpoint never came up');
    const br = connect(verWs);
    await br.ready;

    // 2. Open the extension page and attach to it.
    const { targetId } = await br.send('Target.createTarget', { url: `chrome-extension://${extId}/probe.html` });
    // poll until the target is attachable
    let sessionId;
    for (let i = 0; i < 20; i++) {
      try { ({ sessionId } = await br.send('Target.attachToTarget', { targetId, flatten: true })); if (sessionId) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!sessionId) throw new Error('could not attach to extension page target');
    await br.send('Runtime.enable', {}, sessionId);

    // 3. Confirm chrome.debugger is present in this extension-page runtime.
    const hasDebugger = await evalInPage(br.send, sessionId,
      `typeof chrome !== 'undefined' && typeof chrome.debugger !== 'undefined' && typeof chrome.debugger.attach === 'function'`);
    log('chrome.debugger available in extension page:', hasDebugger);
    if (!hasDebugger) throw new Error('chrome.debugger missing in extension page runtime');

    // 4. Inside the extension page: create a tab, attach debugger, arm Fetch
    //    before-send, wire failRequest for the forbidden target, then navigate.
    const arm = await evalInPage(br.send, sessionId, `(async () => {
      const FORBIDDEN_PORT = ${forbiddenPort};
      const REDIRECT_URL = ${JSON.stringify(redirectUrl)};
      const state = { attached: false, fetchEnabled: false, blocked: [], continued: [], error: null };
      globalThis.__m1 = state;
      try {
        const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
        const tabId = tab.id;
        await chrome.debugger.attach({ tabId }, '1.3');
        state.attached = true;
        chrome.debugger.onEvent.addListener((src, method, params) => {
          if (src.tabId !== tabId || method !== 'Fetch.requestPaused') return;
          const url = params.request.url;
          if (url.includes(':' + FORBIDDEN_PORT)) {
            state.blocked.push(url);
            chrome.debugger.sendCommand({ tabId }, 'Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' });
          } else {
            state.continued.push(url);
            chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId: params.requestId });
          }
        });
        await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
          patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
        });
        state.fetchEnabled = true;
        await chrome.tabs.update(tabId, { url: REDIRECT_URL });
        return { attached: state.attached, fetchEnabled: state.fetchEnabled, error: null };
      } catch (e) {
        state.error = String((e && e.message) || e);
        return { attached: state.attached, fetchEnabled: state.fetchEnabled, error: state.error };
      }
    })()`);
    log('arm result:', JSON.stringify(arm));
    if (arm.error) throw new Error('extension arm failed: ' + arm.error);

    // 5. Let the navigation + redirect (and any blocked follow-up) play out, then
    //    read the blocked list back out of the page's global.
    await new Promise((r) => setTimeout(r, 3000));
    const state = JSON.parse(await evalInPage(br.send, sessionId, `JSON.stringify(globalThis.__m1 || {})`));
    br.ws.close();

    const blocked = state.blocked ?? [];
    log('--- RESULTS ---');
    log(`ext debugger.attach = ${arm.attached}       (expect true)`);
    log(`ext Fetch.enable    = ${arm.fetchEnabled}   (expect true)`);
    log(`redirector hits     = ${redirectHits}       (expect >=1)`);
    log(`forbidden hits      = ${forbiddenHits}      (expect 0)`);
    log(`ext blocked urls    = ${JSON.stringify(blocked)}`);

    const pass = arm.attached && arm.fetchEnabled && redirectHits >= 1 && forbiddenHits === 0 && blocked.length >= 1;
    log(pass
      ? '✅ PASS: extension runtime armed Fetch before-send via chrome.debugger AND forbidden target got 0 requests'
      : '❌ FAIL: see counts above');
    process.exitCode = pass ? 0 : 1;
  } finally {
    chrome.kill('SIGKILL');
    forbidden.close(); redirector.close();
    try { rmSync(userDir, { recursive: true, force: true }); } catch {}
    try { rmSync(extDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { log('ERROR', e.message); process.exitCode = 1; });
