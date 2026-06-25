import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunnerPort } from './runner-port.js';
import { createMetrics, type RunnerConfig } from '@sovovs/bycli-recorder-core';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-runner.mjs', import.meta.url));

const FULL: RunnerConfig = {
  maxConcurrency: 2, queueLimit: 10, stdoutLimitBytes: 1_048_576, stderrLimitBytes: 65_536,
  jsonlLineLimit: 65_536, timeoutMs: 30_000, killGraceMs: 1500,
};
const mkConfig = (o: Partial<RunnerConfig> = {}): RunnerConfig => ({ ...FULL, ...o });

type StartInput = Parameters<ReturnType<typeof createRunnerPort>['startVerify']>[0];
const seed = (over: Partial<StartInput> = {}): StartInput =>
  ({ name: 'demo/x', evidenceSeedArgs: {}, rawSeedArgs: {}, fixture: 'ignore', trace: 'off', ...over });
const inputPathOf = (args: string[]): string => args[args.indexOf('--input') + 1];

// The parent reads the JSONL protocol from child.stdio[3] (Codex #3), not stdout — so fakes expose
// a `protocol` stream at stdio[3]. stdout/stderr (/dev/null in production) are kept only to prove
// they are NOT parsed.
type FakeChild = EventEmitter & {
  stdout: EventEmitter; stderr: EventEmitter; protocol: EventEmitter;
  stdio: unknown[]; kill: ReturnType<typeof vi.fn>;
};
function mkFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.protocol = new EventEmitter();
  child.stdio = [null, child.stdout, child.stderr, child.protocol]; // fd 3 = protocol
  child.kill = vi.fn(() => true);
  return child;
}

/** A controllable fake child + a spawnImpl that returns it and records the argv. */
function fakeChild() {
  const captured: { command?: string; args?: string[] } = {};
  const child = mkFakeChild();
  const spawnImpl = ((command: string, args: string[]) => { captured.command = command; captured.args = args; return child; }) as never;
  return { child, captured, spawnImpl };
}

/** A spawnImpl that returns a FRESH controllable child each call (for concurrency/queue tests). */
function fakeChildFactory() {
  const children: FakeChild[] = [];
  const spawnImpl = (() => { const child = mkFakeChild(); children.push(child); return child; }) as never;
  return { children, spawnImpl };
}

describe('RunnerPort · real spawn (08 JSONL end-to-end)', () => {
  const realLauncher = { command: process.execPath, prefixArgs: [FIXTURE] };

  it('happy path: started → result, summary carries rows/fieldCount', async () => {
    const port = createRunnerPort({ config: mkConfig(), launcher: realLauncher });
    const { requestId } = await port.startVerify(seed({ rawSeedArgs: { __mode: 'happy' } }));
    expect(requestId).toMatch(/^req_/);
    const summary = await port.whenSettled(requestId)!;
    expect(summary.ok).toBe(true);
    expect(summary.rows).toBe(2);
    expect(summary.fieldCount).toBe(1); // count only, never key names (Codex M7c)
    // status reflects the terminal summary; activeCount drops back to 0
    expect(await port.getVerifyStatus(requestId)).toEqual(summary);
    expect(port.activeCount()).toBe(0);
  });

  it('terminal run is GC\'d from the registry after the retention window (Codex M9 · High)', async () => {
    const port = createRunnerPort({ config: mkConfig(), launcher: realLauncher, terminalRetentionMs: 30 });
    const { requestId } = await port.startVerify(seed({ rawSeedArgs: { __mode: 'happy' } }));
    await port.whenSettled(requestId);
    expect(port.getRunStatus(requestId)).not.toBeNull(); // readable right after settle (wrapper polls)
    await new Promise((r) => setTimeout(r, 60)); // wait past the retention window
    expect(port.getRunStatus(requestId)).toBeNull(); // GC'd → runs map stays bounded, no input retained
  });

  it('malformed JSONL line → runner_protocol_error', async () => {
    const port = createRunnerPort({ config: mkConfig(), launcher: realLauncher });
    const { requestId } = await port.startVerify(seed({ rawSeedArgs: { __mode: 'malformed' } }));
    const summary = await port.whenSettled(requestId)!;
    expect(summary.ok).toBe(false);
    expect(summary.error?.code).toBe('runner_protocol_error');
  });

  it('child exits without a result → runner_protocol_error', async () => {
    const port = createRunnerPort({ config: mkConfig(), launcher: realLauncher });
    const { requestId } = await port.startVerify(seed({ rawSeedArgs: { __mode: 'noresult' } }));
    const summary = await port.whenSettled(requestId)!;
    expect(summary.ok).toBe(false);
    expect(summary.error?.code).toBe('runner_protocol_error');
  });

  it('a hung adapter is killed at the timeout → verify_timeout', async () => {
    const port = createRunnerPort({ config: mkConfig({ timeoutMs: 120, killGraceMs: 40 }), launcher: realLauncher });
    const { requestId } = await port.startVerify(seed({ rawSeedArgs: { __mode: 'slow' } }));
    const summary = await port.whenSettled(requestId)!;
    expect(summary.ok).toBe(false);
    expect(summary.error?.code).toBe('verify_timeout');
  });
});

describe('RunnerPort · mechanism (controlled child)', () => {
  it('writes input.json 0600 in a 0700 temp dir, then cleans it up on settle', async () => {
    const { child, captured, spawnImpl } = fakeChild();
    const port = createRunnerPort({ config: mkConfig(), spawnImpl, launcher: { command: 'node', prefixArgs: [] } });
    const { requestId } = await port.startVerify(seed({ rawSeedArgs: { secret: 'S3CR3T-RAW' } }));

    const inputPath = inputPathOf(captured.args!);
    const tempRoot = path.dirname(inputPath);
    // POSIX security guarantees (08 Input JSON Security)
    expect(fs.statSync(inputPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(tempRoot).mode & 0o777).toBe(0o700);
    // raw seed args DO live in input.json (execution-only)
    expect(fs.readFileSync(inputPath, 'utf8')).toContain('S3CR3T-RAW');

    // emit a terminal result, then the child exits
    child.protocol.emit('data', Buffer.from(JSON.stringify({ type: 'result', requestId, ok: true, data: { rows: 1 } }) + '\n'));
    child.emit('close', 0, null);

    const summary = await port.whenSettled(requestId)!;
    expect(summary.ok).toBe(true);
    // cleanup: the whole temp dir (input.json + marker) is gone
    expect(fs.existsSync(tempRoot)).toBe(false);
    // raw seed arg never reaches the status summary
    expect(JSON.stringify(summary)).not.toContain('S3CR3T-RAW');
    expect(JSON.stringify(await port.getVerifyStatus(requestId))).not.toContain('S3CR3T-RAW');
  });

  it('cancel is idempotent: kills the child, cleans temp, repeat calls stay cancelled', async () => {
    const { child, captured, spawnImpl } = fakeChild();
    const port = createRunnerPort({ config: mkConfig(), spawnImpl, launcher: { command: 'node', prefixArgs: [] } });
    const { requestId } = await port.startVerify(seed({ rawSeedArgs: {} }));
    const tempRoot = path.dirname(inputPathOf(captured.args!));

    const c1 = await port.cancelVerify(requestId);
    expect(c1.cancelled).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM'); // #4: SIGTERM first so the child releases its lease
    expect(fs.existsSync(tempRoot)).toBe(false); // temp removed on cancel

    const c2 = await port.cancelVerify(requestId); // idempotent
    expect(c2.cancelled).toBe(true);

    const summary = await port.whenSettled(requestId)!;
    expect(summary.ok).toBe(false);
  });

  it('cancel of an unknown requestId → { cancelled: false }', async () => {
    const { spawnImpl } = fakeChild();
    const port = createRunnerPort({ config: mkConfig(), spawnImpl, launcher: { command: 'node', prefixArgs: [] } });
    expect(await port.cancelVerify('req_nope')).toEqual({ cancelled: false });
  });

  it('protocol stream over the byte cap → output_truncated (child killed)', async () => {
    const { child, captured, spawnImpl } = fakeChild();
    const port = createRunnerPort({ config: mkConfig({ stdoutLimitBytes: 16 }), spawnImpl, launcher: { command: 'node', prefixArgs: [] } });
    const { requestId } = await port.startVerify(seed({ rawSeedArgs: {} }));
    const tempRoot = path.dirname(inputPathOf(captured.args!));

    child.protocol.emit('data', Buffer.from('x'.repeat(64))); // exceeds 16-byte cap
    const summary = await port.whenSettled(requestId)!;
    expect(summary.ok).toBe(false);
    expect(summary.error?.code).toBe('output_truncated');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fs.existsSync(tempRoot)).toBe(false);
  });

  it('Codex #3: adapter stdout/stderr are NOT parsed as protocol (only fd 3 is)', async () => {
    const { child, captured, spawnImpl } = fakeChild();
    const port = createRunnerPort({ config: mkConfig(), spawnImpl, launcher: { command: 'node', prefixArgs: [] } });
    const { requestId } = await port.startVerify(seed({ rawSeedArgs: {} }));
    void captured;

    // Adapter pollutes fd 1/2 with junk + even a forged result line — the parent reads neither.
    child.stdout.emit('data', Buffer.from('not json at all\n'));
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', requestId, ok: false, error: { code: 'forged', message: 'x' } }) + '\n'));
    child.stderr.emit('data', Buffer.from('debug noise\n'));
    // The REAL result arrives on fd 3 and is the only one that counts.
    child.protocol.emit('data', Buffer.from(JSON.stringify({ type: 'result', requestId, ok: true, data: { rows: 7 } }) + '\n'));
    child.emit('close', 0, null);

    const summary = await port.whenSettled(requestId)!;
    expect(summary.ok).toBe(true);   // fd1 junk/forgery ignored; fd3 result wins
    expect(summary.rows).toBe(7);
    expect(child.kill).not.toHaveBeenCalled(); // no protocol_error from the stdout junk
  });

  it('getVerifyStatus returns null while running, the summary once terminal', async () => {
    const { child, captured, spawnImpl } = fakeChild();
    const port = createRunnerPort({ config: mkConfig(), spawnImpl, launcher: { command: 'node', prefixArgs: [] } });
    const { requestId } = await port.startVerify(seed({ rawSeedArgs: {} }));
    expect(await port.getVerifyStatus(requestId)).toBeNull(); // still running
    expect(port.activeCount()).toBe(1);

    child.protocol.emit('data', Buffer.from(JSON.stringify({ type: 'result', requestId, ok: true, data: { rows: 0 } }) + '\n'));
    child.emit('close', 0, null);
    void captured;
    const summary = await port.whenSettled(requestId)!;
    expect(summary.ok).toBe(true);
    expect(await port.getVerifyStatus(requestId)).toEqual(summary);
  });
});

describe('RunnerPort · M6c concurrency queue + strict duplicate-result', () => {
  const resultLine = (requestId: string, rows = 0): Buffer =>
    Buffer.from(JSON.stringify({ type: 'result', requestId, ok: true, data: { rows } }) + '\n');
  const lch = { command: 'node', prefixArgs: [] as string[] };

  it('queues beyond maxConcurrency; a freed slot launches the next (FIFO)', async () => {
    const { children, spawnImpl } = fakeChildFactory();
    const port = createRunnerPort({ config: mkConfig({ maxConcurrency: 1, queueLimit: 5 }), spawnImpl, launcher: lch });
    const { requestId: r1 } = await port.startVerify(seed());
    const { requestId: r2 } = await port.startVerify(seed());
    expect(port.activeCount()).toBe(1);
    expect(port.queuedCount()).toBe(1);
    expect(children).toHaveLength(1); // r2 stays queued, no child spawned
    expect(port.getRunStatus(r2)!.status).toBe('queued');

    children[0].protocol.emit('data', resultLine(r1));
    children[0].emit('close', 0, null);
    await port.whenSettled(r1);

    expect(children).toHaveLength(2); // freed slot launched r2
    expect(port.getRunStatus(r2)!.status).toBe('running');
    expect(port.queuedCount()).toBe(0);

    children[1].protocol.emit('data', resultLine(r2));
    children[1].emit('close', 0, null);
    await port.whenSettled(r2);
    expect(port.activeCount()).toBe(0);
  });

  it('rejects with queue_full once maxConcurrency + queueLimit are saturated', async () => {
    const { spawnImpl } = fakeChildFactory();
    const port = createRunnerPort({ config: mkConfig({ maxConcurrency: 1, queueLimit: 1 }), spawnImpl, launcher: lch });
    await port.startVerify(seed()); // running
    await port.startVerify(seed()); // queued (fills queueLimit=1)
    await expect(port.startVerify(seed())).rejects.toMatchObject({ code: 'queue_full' });
  });

  it('cancel of a queued run drops it from the queue without ever spawning', async () => {
    const { children, spawnImpl } = fakeChildFactory();
    const port = createRunnerPort({ config: mkConfig({ maxConcurrency: 1, queueLimit: 5 }), spawnImpl, launcher: lch });
    const { requestId: r1 } = await port.startVerify(seed());
    const { requestId: r2 } = await port.startVerify(seed());
    expect(port.getRunStatus(r2)!.status).toBe('queued');

    expect(await port.cancelVerify(r2)).toEqual({ cancelled: true });
    expect(port.queuedCount()).toBe(0);
    expect(port.getRunStatus(r2)!.status).toBe('cancelled');
    expect(children).toHaveLength(1); // r2 never spawned

    // settling r1 must NOT resurrect the cancelled r2
    children[0].protocol.emit('data', resultLine(r1));
    children[0].emit('close', 0, null);
    await port.whenSettled(r1);
    expect(children).toHaveLength(1);
  });

  it('a duplicate result event → runner_protocol_error and SIGKILL (08: one and only one)', async () => {
    const { children, spawnImpl } = fakeChildFactory();
    const port = createRunnerPort({ config: mkConfig(), spawnImpl, launcher: lch });
    const { requestId } = await port.startVerify(seed());
    const ch = children[0];
    ch.protocol.emit('data', resultLine(requestId, 1));
    ch.protocol.emit('data', resultLine(requestId, 2)); // duplicate terminal result
    const summary = await port.whenSettled(requestId)!;
    expect(summary.ok).toBe(false);
    expect(summary.error?.code).toBe('runner_protocol_error');
    expect(summary.error?.message).toContain('duplicate');
    expect(ch.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('a single result settles on close (buffer-until-exit), not before', async () => {
    const { children, spawnImpl } = fakeChildFactory();
    const port = createRunnerPort({ config: mkConfig(), spawnImpl, launcher: lch });
    const { requestId } = await port.startVerify(seed());
    const ch = children[0];
    ch.protocol.emit('data', resultLine(requestId, 5));
    expect(await port.getVerifyStatus(requestId)).toBeNull(); // recorded, not yet settled
    ch.emit('close', 0, null);
    const summary = await port.whenSettled(requestId)!;
    expect(summary.ok).toBe(true);
    expect(summary.rows).toBe(5);
  });

  it('a result with no close is force-killed after the grace and settled with the result', async () => {
    vi.useFakeTimers();
    try {
      const { children, spawnImpl } = fakeChildFactory();
      const port = createRunnerPort({ config: mkConfig({ killGraceMs: 50 }), spawnImpl, launcher: lch });
      const { requestId } = await port.startVerify(seed());
      const ch = children[0];
      ch.protocol.emit('data', resultLine(requestId, 3));
      vi.advanceTimersByTime(60); // past killGraceMs → resultGrace fires (kill + settle)
      expect(ch.kill).toHaveBeenCalledWith('SIGKILL');
      expect(port.getRunStatus(requestId)!.status).toBe('succeeded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Codex #5: a repeat start for an in-flight id is idempotent (no clobber, no second child)', async () => {
    const { children, spawnImpl } = fakeChildFactory();
    const port = createRunnerPort({ config: mkConfig({ maxConcurrency: 2 }), spawnImpl, launcher: lch });
    const { requestId } = await port.startVerify(seed({ requestId: 'req_canon' }));
    expect(children).toHaveLength(1);
    expect(port.getRunStatus(requestId)!.status).toBe('running');

    // be re-forwards the same canonical id → idempotent: same id, NO new child, original not clobbered.
    const again = await port.startVerify(seed({ requestId: 'req_canon' }));
    expect(again.requestId).toBe('req_canon');
    expect(children).toHaveLength(1);

    // the original (single) child still drives the run to a correct terminal state.
    children[0].protocol.emit('data', resultLine(requestId, 4));
    children[0].emit('close', 0, null);
    const summary = await port.whenSettled(requestId)!;
    expect(summary.ok).toBe(true);
    expect(summary.rows).toBe(4);
  });

  it('Codex #5: a repeat start for a settled id returns the cached run, not a fresh one', async () => {
    const { children, spawnImpl } = fakeChildFactory();
    const port = createRunnerPort({ config: mkConfig(), spawnImpl, launcher: lch });
    const { requestId } = await port.startVerify(seed({ requestId: 'req_done' }));
    children[0].protocol.emit('data', resultLine(requestId, 2));
    children[0].emit('close', 0, null);
    await port.whenSettled(requestId);
    expect(port.getRunStatus(requestId)!.status).toBe('succeeded');

    const again = await port.startVerify(seed({ requestId: 'req_done' }));
    expect(again.requestId).toBe('req_done');
    expect(children).toHaveLength(1);                                  // no new run spawned
    expect(port.getRunStatus('req_done')!.status).toBe('succeeded');   // still the cached terminal
  });

  it('generates distinct ids (collision-avoided) when no requestId is provided', async () => {
    const { children, spawnImpl } = fakeChildFactory();
    const port = createRunnerPort({ config: mkConfig({ maxConcurrency: 2 }), spawnImpl, launcher: lch });
    const a = await port.startVerify(seed());
    const b = await port.startVerify(seed());
    expect(a.requestId).not.toBe(b.requestId);
    expect(children).toHaveLength(2);
  });
});

describe('RunnerPort · observability (#1c · 09 metrics)', () => {
  const lch = { command: 'node', prefixArgs: [] };
  const realLauncher = { command: process.execPath, prefixArgs: [FIXTURE] };

  it('happy path → runner_verify_total{succeeded} + duration histogram', async () => {
    const metrics = createMetrics();
    const port = createRunnerPort({ config: mkConfig(), launcher: realLauncher, metrics });
    const { requestId } = await port.startVerify(seed({ rawSeedArgs: { __mode: 'happy' } }));
    await port.whenSettled(requestId);
    const s = metrics.snapshot();
    expect(s.counters['runner_verify_total{status=succeeded}']).toBe(1);
    expect(s.histograms['runner_verify_duration_ms']?.count).toBe(1);
  });

  it('timeout → runner_timeout_total + runner_verify_total{timeout}', async () => {
    const metrics = createMetrics();
    const port = createRunnerPort({ config: mkConfig({ timeoutMs: 100, killGraceMs: 30 }), launcher: realLauncher, metrics });
    const { requestId } = await port.startVerify(seed({ rawSeedArgs: { __mode: 'slow' } }));
    await port.whenSettled(requestId);
    const s = metrics.snapshot();
    expect(s.counters['runner_timeout_total']).toBe(1);
    expect(s.counters['runner_verify_total{status=timeout}']).toBe(1);
  });

  it('malformed protocol → runner_protocol_error_total', async () => {
    const metrics = createMetrics();
    const port = createRunnerPort({ config: mkConfig(), launcher: realLauncher, metrics });
    const { requestId } = await port.startVerify(seed({ rawSeedArgs: { __mode: 'malformed' } }));
    await port.whenSettled(requestId);
    expect(metrics.snapshot().counters['runner_protocol_error_total']).toBe(1);
  });

  it('queue_full reject → runner_queue_rejected_total; enqueue → runner_queue_depth', async () => {
    const metrics = createMetrics();
    const { spawnImpl } = fakeChildFactory(); // controlled children never settle → stay running/queued
    // maxConcurrency 1, queueLimit 1: 1st runs, 2nd queues (depth 1), 3rd rejected queue_full.
    const port = createRunnerPort({ config: mkConfig({ maxConcurrency: 1, queueLimit: 1 }), spawnImpl, launcher: lch, metrics });
    await port.startVerify(seed());                                                   // running
    await port.startVerify(seed());                                                   // queued → observe depth 1
    await expect(port.startVerify(seed())).rejects.toMatchObject({ code: 'queue_full' });
    const s = metrics.snapshot();
    expect(s.counters['runner_queue_rejected_total']).toBe(1);
    expect(s.histograms['runner_queue_depth']?.max).toBe(1);
  });
});

describe('RunnerPort · temp-store capacity guard (#1d)', () => {
  const lch = { command: 'node', prefixArgs: [] };
  const CAP = { maxBytes: 1000, highWatermarkRatio: 0.9, lowWatermarkRatio: 0.7 }; // highBytes = 900

  it('over high watermark + sweep does not help → temp_store_full, child never spawned', async () => {
    const metrics = createMetrics();
    const { child, captured, spawnImpl } = fakeChild();
    void child;
    const port = createRunnerPort({
      config: mkConfig(), spawnImpl, launcher: lch, metrics,
      tempCapacity: CAP, measureTempBytes: () => 950, // > 900, stays over after sweep
    });
    const { requestId } = await port.startVerify(seed());
    const summary = await port.whenSettled(requestId)!;
    expect(summary.ok).toBe(false);
    expect(summary.error?.code).toBe('temp_store_full');
    expect(captured.command).toBeUndefined(); // never spawned — refused before any work
    const s = metrics.snapshot();
    expect(s.counters['temp_store_pressure_total']).toBe(1);
    expect(s.counters['temp_store_full_total']).toBe(1);
  });

  it('under high watermark → proceeds normally', async () => {
    const metrics = createMetrics();
    const { child, captured, spawnImpl } = fakeChild();
    const port = createRunnerPort({
      config: mkConfig(), spawnImpl, launcher: lch, metrics,
      tempCapacity: CAP, measureTempBytes: () => 500, // < 900
    });
    const { requestId } = await port.startVerify(seed());
    expect(captured.command).toBe('node'); // spawned
    child.protocol.emit('data', Buffer.from(JSON.stringify({ type: 'result', requestId, ok: true, data: { rows: 1 } }) + '\n'));
    child.emit('close', 0, null);
    const summary = await port.whenSettled(requestId)!;
    expect(summary.ok).toBe(true);
    expect(metrics.snapshot().counters['temp_store_full_total']).toBeUndefined();
  });

  it('measurement throws → fail-closed → temp_store_full', async () => {
    const metrics = createMetrics();
    const { spawnImpl } = fakeChild();
    const port = createRunnerPort({
      config: mkConfig(), spawnImpl, launcher: lch, metrics,
      tempCapacity: CAP, measureTempBytes: () => { throw new Error('tmpdir unreadable'); },
    });
    const { requestId } = await port.startVerify(seed());
    const summary = await port.whenSettled(requestId)!;
    expect(summary.error?.code).toBe('temp_store_full');
    expect(metrics.snapshot().counters['temp_store_full_total']).toBe(1);
  });

  it('sweep frees space → pressure recorded but run proceeds', async () => {
    const metrics = createMetrics();
    const { child, captured, spawnImpl } = fakeChild();
    let calls = 0;
    let swept = false;
    const port = createRunnerPort({
      config: mkConfig(), spawnImpl, launcher: lch, metrics,
      tempCapacity: CAP,
      measureTempBytes: () => (++calls === 1 ? 950 : 500), // over first, under after sweep
      sweepTemp: () => { swept = true; },
    });
    const { requestId } = await port.startVerify(seed());
    expect(swept).toBe(true);
    expect(captured.command).toBe('node'); // proceeded
    child.protocol.emit('data', Buffer.from(JSON.stringify({ type: 'result', requestId, ok: true, data: { rows: 1 } }) + '\n'));
    child.emit('close', 0, null);
    const summary = await port.whenSettled(requestId)!;
    expect(summary.ok).toBe(true);
    const s = metrics.snapshot();
    expect(s.counters['temp_store_pressure_total']).toBe(1);
    expect(s.counters['temp_store_full_total']).toBeUndefined();
  });
});
