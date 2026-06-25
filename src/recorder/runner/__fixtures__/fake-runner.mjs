// Fixture runner for runner-port.test.ts — a standalone child that emits the 08 JSONL
// protocol on the dedicated --protocol-fd (Codex #3; falls back to stdout when absent), no
// adapter loading. Behaviour is selected by input.executionSeedArgs.__mode so a single fixture
// covers happy/malformed/noresult/slow.
//
// argv (from buildRunnerArgs, prefixed by this script path):
//   internal verify-runner --jsonl --request-id <id> --name <name> --input <path> --protocol-fd 3
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const requestId = opt('--request-id');
const inputPath = opt('--input');
const protocolFd = opt('--protocol-fd') !== undefined ? Number(opt('--protocol-fd')) : undefined;

let mode = 'happy';
try {
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  mode = input.executionSeedArgs?.__mode ?? 'happy';
} catch {
  // fall through to happy; the parent will see whatever we emit
}

const writeRaw = (s) => { if (protocolFd !== undefined) fs.writeSync(protocolFd, s); else process.stdout.write(s); };
const emit = (o) => writeRaw(JSON.stringify(o) + '\n');

if (mode === 'happy') {
  emit({ type: 'started', requestId, pid: process.pid, stage: 'load' });
  emit({ type: 'result', requestId, ok: true, data: { stage: 'execute', rows: 2, fieldCount: 1, fixture: { status: 'ignored' }, trace: { retained: false } } });
} else if (mode === 'malformed') {
  emit({ type: 'started', requestId });
  writeRaw('{ this is not valid json\n');
} else if (mode === 'noresult') {
  emit({ type: 'started', requestId });
  // exit without ever emitting a terminal result
} else if (mode === 'slow') {
  emit({ type: 'started', requestId });
  setInterval(() => {}, 1000); // hang forever; rely on the parent's timeout → SIGTERM/SIGKILL
}
