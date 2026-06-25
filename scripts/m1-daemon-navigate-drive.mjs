/**
 * M1 P0-1 semi-auto live driver (#1, extension form, full chain).
 *
 * Drives a REAL daemon → byCLI extension → chrome.debugger Fetch interception and
 * asserts a 302 redirect to a forbidden target reaches it ZERO times. This is the
 * extension-form counterpart to scripts/m1-live-spike.mjs (direct CDP).
 *
 * MANUAL PREREQUISITES (this script does NOT automate them):
 *   1. Build + load the extension:  (cd extension && npm run build)  then load
 *      extension/ as an unpacked extension at chrome://extensions (Developer Mode).
 *   2. Start the daemon:  bycli daemon start   (or run any bycli browser command
 *      once so the daemon auto-spawns and the extension connects).
 *   3. Make sure the extension shows "connected" (bycli doctor / daemon status).
 *
 * Then run:  node scripts/m1-daemon-navigate-drive.mjs
 *
 * HOW THE NO-HIT TEST IS CONSTRUCTED (and what it proves):
 *   - Navigate target = http://<sub>.localtest.me:<R>/start. localtest.me publicly
 *     resolves to 127.0.0.1, so it passes the extension's syntax-only policy (a
 *     domain, not a literal) and the browser connects to our local redirector.
 *   - The redirector 302s to http://127.0.0.1:<F>/secret — a LITERAL loopback.
 *   - The extension's armed Fetch guard re-checks that redirected main-frame request
 *     and failRequest's it before send → the forbidden server gets 0 requests.
 *   This proves before-send interception in the real extension runtime + daemon chain.
 *   It does NOT prove DNS-rebinding closure: a redirect to a DOMAIN that resolves to
 *   loopback would NOT be caught (ip-observed-only, ADR-0006) — that needs the proxy.
 *
 * Requires DNS resolution of *.localtest.me (needs network). If offline, add a hosts
 * entry mapping a test host to 127.0.0.1 and pass it via PROBE_HOST.
 */
import http from 'node:http';

const DAEMON = process.env.BYCLI_DAEMON || 'http://127.0.0.1:19825';
const PROBE_HOST = process.env.PROBE_HOST || 'probe.localtest.me';
const SESSION = process.env.SESSION || 'm1-drive';
const log = (...a) => console.log('[m1-drive]', ...a);

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

async function daemonCommand(cmd) {
  const res = await fetch(`${DAEMON}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-byCLI': '1' },
    body: JSON.stringify(cmd),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function main() {
  // 0. Daemon reachable + extension connected?
  let status;
  try {
    const r = await fetch(`${DAEMON}/status`, { headers: { 'X-byCLI': '1' } });
    status = await r.json();
  } catch (e) {
    log(`ERROR: daemon not reachable at ${DAEMON}. Start it first (see header comment).`);
    process.exitCode = 1;
    return;
  }
  log('daemon status:', JSON.stringify(status));
  if (status.state && status.state !== 'ready') {
    log(`WARNING: daemon state is "${status.state}" (need "ready" with the extension connected).`);
  }

  await listen(forbidden);
  await listen(redirector);
  const R = redirector.address().port;
  const F = forbidden.address().port;
  const target = `http://${PROBE_HOST}:${R}/start`;
  log(`forbidden=127.0.0.1:${F}  redirector=127.0.0.1:${R}  navigate target=${target}`);

  try {
    // 1. Drive a guarded navigation through the daemon → extension chain.
    const { status: httpStatus, json } = await daemonCommand({
      id: `m1-${Date.now()}`,
      action: 'navigate',
      surface: 'browser',
      session: SESSION,
      url: target,
      timeout: 30,
    });
    log(`navigate HTTP ${httpStatus}, result:`, JSON.stringify(json));

    // 2. Settle for redirect + any blocked follow-up.
    await new Promise((r) => setTimeout(r, 2000));

    // A blocked redirect can surface two equally-correct ways:
    //  (a) ok:false with errorCode 'navigation_blocked_by_policy' (the redirect was
    //      blocked, so the navigation as a whole failed) — the deterministic path; or
    //  (b) ok:true with data.interception.blocked listing the forbidden URL (the page
    //      still settled, e.g. on an error/blank page, but the request was blocked).
    const interception = json?.data?.interception;
    const blockedList = interception?.blocked ?? [];
    const errBlockedForbidden = json?.errorCode === 'navigation_blocked_by_policy'
      && typeof json?.error === 'string' && json.error.includes(`127.0.0.1:${F}`);
    const dataBlockedForbidden = blockedList.some((u) => u.includes(`127.0.0.1:${F}`));
    const blockedForbidden = errBlockedForbidden || dataBlockedForbidden;

    log('--- RESULTS ---');
    log(`navigate ok          = ${json?.ok}`);
    log(`errorCode            = ${json?.errorCode ?? '(none)'}`);
    log(`interception.tier    = ${interception?.tier ?? '(n/a on blocked path)'}`);
    log(`blocked (data|error) = ${JSON.stringify(blockedList)} | ${errBlockedForbidden}`);
    log(`redirector hits      = ${redirectHits}               (expect >=1)`);
    log(`forbidden hits       = ${forbiddenHits}              (expect 0)`);

    // The security invariant: the forbidden target received 0 requests AND the
    // redirect was actually attempted (proving the guard, not a no-op) AND we have
    // explicit evidence the forbidden URL was blocked before send.
    const pass = forbiddenHits === 0 && redirectHits >= 1 && blockedForbidden;
    log(pass
      ? '✅ PASS: daemon→extension blocked the forbidden redirect before send (forbidden target got 0 requests)'
      : '❌ FAIL: see counts above (if redirector hits=0, the browser never reached the local redirector — check *.localtest.me DNS / PROBE_HOST)');
    process.exitCode = pass ? 0 : 1;
  } finally {
    // Best-effort: close the owned tab/session we created.
    await daemonCommand({ id: `m1-close-${Date.now()}`, action: 'close-window', surface: 'browser', session: SESSION }).catch(() => {});
    forbidden.close(); redirector.close();
  }
}

main().catch((e) => { log('ERROR', e.message); process.exitCode = 1; forbidden.close(); redirector.close(); });
