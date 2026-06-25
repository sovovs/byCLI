# 08 · Runner And Isolation

## Boundary

User adapter JS never runs in API/Local Service main process. It runs in a child process managed by async runner. This protects service stability but is not a security sandbox: adapter still has same-user OS permissions.

## Runner API

```typescript
type VerifyRun = {
  requestId: string;
  child: ChildProcess;
  startedAt: number;
  timeoutAt: number;
  stdoutBytes: number;
  stderrBytes: number;
  status: "queued" | "running" | "succeeded" | "failed" | "timeout" | "cancelled";
};

startVerify(input): { requestId }
getVerifyStatus(requestId): VerifyRunStatus
cancelVerify(requestId): { cancelled: boolean }
```

## Process Rules

| Rule | Requirement |
| --- | --- |
| launch | `spawn` or async `execFile`, args array, no shell string |
| registry | create requestId before launch |
| timeout | hard timeout, graceful kill, then force kill |
| protocol channel (M7c) | JSONL protocol on a **dedicated fd** (`--protocol-fd 3`); the adapter's stdin/stdout/stderr are routed to `/dev/null` (spawn `stdio: ['ignore','ignore','ignore','pipe']`), so user `console.log` / `process.stdout.write` can neither pollute nor forge the protocol stream. The protocol fd is byte-capped (`output_truncated`). |
| result | exactly one terminal `result` event on the protocol fd, no human CLI text parsing |
| concurrency (M6c) | `maxConcurrency` running; excess FIFO-queued up to `HIGH_LEVEL_QUEUE_LIMIT`, then `queue_full` (→ 429) |
| orphan watchdog (M7d) | child self-terminates after `--max-runtime-ms` (= timeoutMs + killGraceMs + margin) if orphaned — a cross-platform backstop for when the parent dies before it can kill the child (e.g. win32 reaper has no portable cmdline guard) |
| cleanup | always remove registry entry or expire terminal state; clean temp files |
| cancel | idempotent; SIGTERM-first (so a browser adapter releases its tab lease) then force kill after the grace; removes sensitive temp data |
| child marker | child temp root carries a cleanup manifest (`requestId`, `ownerPid`〔= localServiceRunId stand-in〕, `pid`, `startedAt`, `tempRoot`, `operation`); no seed args or tokens |
| startup reap | on Local Service restart, reap dirs whose `ownerPid` is dead (true orphans) — with an **owner pid-reuse guard** (a live pid whose start time post-dates the run is a recycled pid → still an orphan) — or whose age exceeds the floored TTL (never below timeoutMs + killGraceMs, so a live run is never age-reaped); verify child cmdline/requestId against the marker before graceful→force kill; delete stale input/temp/trace |

## JSONL Protocol

Machine-readable event definitions (`RunnerStartedEvent`, `RunnerProgressEvent`, `RunnerResultEvent`, and the `RunnerEvent` union) live in `schemas/adapter-recorder.bundle.json` (under `$defs`); `RunnerResultEvent.error.code` references the shared error code definition (`#/$defs/ErrorCode`).

Internal command shape:

```bash
bycli internal verify-runner --jsonl \
  --request-id req_... \
  --name demo/search \
  --input /private/tmp/bycli-verify-xxxx/input.json \
  --protocol-fd 3 \
  --max-runtime-ms 635000
```

`--protocol-fd` selects the dedicated JSONL channel (M7c, keeps the protocol off the adapter's stdout/stderr); `--max-runtime-ms` arms the orphan self-watchdog (M7d). Both are omitted for standalone debugging, where the runner falls back to stdout and no watchdog.

Events:

```json
{"type":"started","requestId":"req_...","pid":12345,"stage":"load"}
{"type":"progress","requestId":"req_...","stage":"execute","message":"adapter_started"}
{"type":"result","requestId":"req_...","ok":false,"error":{"code":"auth_required","message":"...","hint":"..."},"data":{"rows":0,"trace":{"retained":false}}}
```

Rules:

- the JSONL protocol is written to the **dedicated `--protocol-fd` (fd 3)**, not stdout; the adapter's stdout/stderr go to `/dev/null` so they can never pollute or forge the protocol (M7c).
- one and only one terminal `result`.
- each line has matching `requestId`.
- max line length is `VERIFY_RUNNER_JSONL_LINE_LIMIT`.
- malformed JSON, oversize line, wrong requestId, unknown type (parse error text never echoes the offending type) or duplicate result returns `runner_protocol_error`.

## Result Schema

```json
{
  "type": "result",
  "requestId": "req_...",
  "ok": true,
  "data": {
    "stage": "fixture|load|execute|validate",
    "rows": 3,
    "fieldCount": 2,
    "fixture": { "status": "matched|updated|ignored" },
    "trace": { "policy": "retain-on-failure", "retained": false, "path": null }
  },
  "error": null
}
```

`fieldCount` (M7c) is the field **count** of the produced rows, never the key **names** — a key could be a seed value if an adapter keys its output rows on one. The Local Service normalizes this internal `RunnerResultEvent.data` into the status-facing `VerifySummary` via `normalizeRunnerResult` (see `06`/`03`): at the `execute` stage (adapter-thrown) the `message`/`hint` are withheld (fixed text) and the `code` is collapsed to `adapter_runtime_error` unless it is a known-safe code (e.g. `auth_required`) — so a seed-valued message/hint/code can never reach the user-facing summary. A load-stage error from the adapter's own module evaluation (vs a runner-side resolve error) is likewise redacted at emit time.

Error codes include `auth_required`, `verify_timeout`, `adapter_runtime_error`, `shape_mismatch`, `fixture_mismatch`, `network_error`, `output_truncated`, `queue_full`, `runner_protocol_error`.

## Runner Error Namespace

Runner JSONL `error.code` must be a subset of the shared error code enum (`adapter-recorder.bundle.json#/$defs/ErrorCode`).

- A runner must not emit a private code that is not registered in the unified error schema.
- A new runner failure mode requires: add the code to `adapter-recorder.bundle.json#/$defs/ErrorCode`, add a row to `03-contracts-and-versioning.md` Error Mapping, then use it in the runner.
- A private code that has not entered the schema/mapping is normalized to `runner_protocol_error` before reaching public request status.
- This keeps runner result, request status and contract tests on one error vocabulary.

## Environment Isolation

Recorder-triggered verify uses minimal environment:

| Item | Requirement |
| --- | --- |
| `HOME` | temp dir |
| `BYCLI_CONFIG_DIR` | temp config with only required current site/session config |
| `BYCLI_CACHE_DIR` | recorder temp store |
| `BYCLI_DAEMON_PORT` | current daemon port |
| `PATH` | minimal required path |
| `NODE_OPTIONS` | do not inherit user value |
| sensitive token | do not pass into adapter child |

The temp config may include current adapter path, fixture path, browser session/profile/contextId and current site temp dir. It must not include other sites' memory/cookies/adapters/reports or long-term cache path.

## Input JSON Security

`input.json` stores execution-only data: `executionSeedArgs`, fixture policy, trace policy, adapter path, allowed dirs and redaction policy. The fixture policy is the input enum `ignore | match | update` (H-002, see `03`) — distinct from the runner's emitted `fixture.status` result `matched | updated | ignored` below.

Requirements:

- parent dir: random, per request, `0700`
- parent owner/mode/realpath checked
- file: exclusive create, `0600`
- cleanup on done/cancel/timeout
- raw `executionSeedArgs` not copied to report/status/log

Implementation outline:

```typescript
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-verify-'));
fs.chmodSync(tempRoot, 0o700);
const stat = fs.lstatSync(tempRoot);
if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('bad temp root');
if (process.getuid && stat.uid !== process.getuid()) throw new Error('owner mismatch');
if ((stat.mode & 0o777) !== 0o700) throw new Error('mode mismatch');
const inputPath = path.join(fs.realpathSync(tempRoot), `${requestId}-input.json`);
const fd = fs.openSync(inputPath, 'wx', 0o600);
try {
  fs.writeSync(fd, JSON.stringify(inputPayload));
} finally {
  fs.closeSync(fd);
}
```

## Platform File Permission Policy

The POSIX checks above are not portable. Each platform must reach an equivalent "only current user can read/write" guarantee.

| Platform | Policy |
| --- | --- |
| POSIX | `0700` dir, `0600` file, uid/mode/realpath/lstat checks as above |
| Windows | temp dir DACL limited to current user, SYSTEM, Administrators; no inherited broad ACE (Everyone/Users); reject reparse point/symlink/junction; exclusive create, no shared read/write; close fd after write; cleanup uses canonical path + request temp root containment |
| unsupported | fail closed before launch (`config_invalid` or `runner_protocol_error`) |

## Stronger Sandboxing

MVP does not require OS sandbox. If same-user arbitrary JS is unacceptable, use one of:

| Option | Strength | Cost |
| --- | --- | --- |
| separate OS user | medium | user management, cross-platform complexity |
| seccomp/landlock/sandbox-exec/AppContainer | high | platform policy maintenance |
| container/VM | highest | startup and resource cost |
