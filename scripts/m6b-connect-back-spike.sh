#!/usr/bin/env bash
# M6b connect-back spike — proves the verify-runner CHILD reaches the daemon for a browser
# adapter (the single biggest unit-test blind spot: real spawn + real `new Page` + connect-back).
#
# It starts a throwaway daemon on an alt port (NO extension attached), then runs the REAL built
# child (`dist/src/main.js internal verify-runner`) against it with a browser fixture adapter.
#
# Expected JSONL: `started` (stage:load) → `result` ok:false, stage:EXECUTE, error
# `extension_not_connected`. That proves the child (a) left the "待 M6b" not-yet path, (b)
# entered the browser branch (stage advanced load→execute = defaultBrowserAdapterRunner ran),
# and (c) connected BACK to the daemon (the error came FROM the daemon, not ECONNREFUSED, and
# no new daemon was spawned). Real rows need a connected Chrome extension — that is the manual
# gate (the extension exec path itself is already covered by M3).
#
# Usage:  npm run build && bash scripts/m6b-connect-back-spike.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=19899
FIX="$ROOT/src/recorder/runner/__fixtures__/browser-adapter.mjs"
IN="$(mktemp -t m6b-input)"
printf '{"requestId":"req_smoke","name":"m6bsmoke/probe","adapterPath":"%s","executionSeedArgs":{}}' "$FIX" > "$IN"

BYCLI_DAEMON_PORT=$PORT node "$ROOT/dist/src/daemon.js" > /tmp/m6b-daemon.log 2>&1 &
DPID=$!
trap 'kill $DPID 2>/dev/null; rm -f "$IN"' EXIT

curl -s --retry-connrefused --retry 20 --retry-delay 1 --max-time 3 -H 'X-byCLI: 1' "http://127.0.0.1:$PORT/ping" > /dev/null
echo "daemon($PORT) ping: $(curl -s --max-time 3 http://127.0.0.1:$PORT/ping)"
echo "--- child JSONL (expect stage:execute + extension_not_connected) ---"
BYCLI_DAEMON_PORT=$PORT node "$ROOT/dist/src/main.js" internal verify-runner --jsonl \
  --request-id req_smoke --name m6bsmoke/probe --input "$IN"
