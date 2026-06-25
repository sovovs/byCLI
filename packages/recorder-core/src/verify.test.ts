import { describe, it, expect } from 'vitest';
import {
  deriveEvidenceSeedArgs, parseRunnerEvent, normalizeRunnerResult,
  validateRunnerConfig, buildRunnerArgs, type RunnerResultEvent,
} from './verify.js';

describe('verify · deriveEvidenceSeedArgs (HMAC, display-only)', () => {
  it('derives evidence without leaking the raw value', () => {
    const raw = { keyword: '张三', limit: 10 };
    const ev = deriveEvidenceSeedArgs(raw, 'session-key-xyz');
    expect(ev.keyword.usage).toBe('display_only');
    expect(ev.keyword.comparableAcrossRuns).toBe(false);
    expect(ev.keyword.hmacScope).toBe('recorder_session');
    // raw value never appears in the evidence
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain('张三');
    expect(ev.keyword.length).toBe('张三'.length);
    expect(ev.keyword.type).toBe('string');
  });
  it('is deterministic per key+value+session key, differs across session keys', () => {
    const a = deriveEvidenceSeedArgs({ q: 'x' }, 'k1');
    const b = deriveEvidenceSeedArgs({ q: 'x' }, 'k1');
    const c = deriveEvidenceSeedArgs({ q: 'x' }, 'k2');
    expect(a.q.hmac).toBe(b.q.hmac);
    expect(a.q.hmac).not.toBe(c.q.hmac); // session-keyed → not comparable across sessions
  });
});

describe('verify · parseRunnerEvent (JSONL → runner_protocol_error guards)', () => {
  const rid = 'req_1';
  it('parses a valid result event', () => {
    const r = parseRunnerEvent(JSON.stringify({ type: 'result', requestId: rid, ok: true }), rid, 1000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.type).toBe('result');
  });
  it('malformed JSON → runner_protocol_error', () => {
    const r = parseRunnerEvent('{not json', rid, 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('runner_protocol_error');
  });
  it('oversize line → runner_protocol_error', () => {
    const r = parseRunnerEvent(JSON.stringify({ type: 'progress', requestId: rid }), rid, 5);
    expect(r.ok).toBe(false);
  });
  it('requestId mismatch → runner_protocol_error', () => {
    const r = parseRunnerEvent(JSON.stringify({ type: 'started', requestId: 'other' }), rid, 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('requestId');
  });
  it('unknown type → runner_protocol_error, WITHOUT echoing the (attacker-controlled) type', () => {
    const r = parseRunnerEvent(JSON.stringify({ type: 'sk-LIVE-forged-type', requestId: rid }), rid, 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toContain('sk-LIVE-forged-type'); // Codex M7c: no echo of a forged type
  });
});

describe('verify · normalizeRunnerResult (summary-only, strips raw)', () => {
  it('keeps only the retained flag from trace, never path', () => {
    const ev: RunnerResultEvent = {
      type: 'result', requestId: 'r', ok: true,
      data: { stage: 'execute', rows: 3, fieldCount: 1, fixture: { status: 'matched' }, trace: { policy: 'retain-on-failure', retained: true, path: '/secret/trace.log' } },
    };
    const s = normalizeRunnerResult(ev);
    expect(s.rows).toBe(3);
    expect(s.fieldCount).toBe(1); // count only, never key names
    expect(s.trace).toEqual({ retained: true });
    expect(JSON.stringify(s)).not.toContain('/secret/trace.log');
  });
  it('passes through error code/message/hint for non-execute (runner-generated) errors', () => {
    const s = normalizeRunnerResult({ type: 'result', requestId: 'r', ok: false, error: { code: 'auth_required', message: 'login', hint: 'sign in' } });
    expect(s.ok).toBe(false);
    expect(s.error?.code).toBe('auth_required');
    expect(s.error?.message).toBe('login'); // no stage → runner-generated → verbatim
  });

  it('M7c: redacts an execute-stage (adapter-thrown) error message that may echo raw seed values', () => {
    const s = normalizeRunnerResult({
      type: 'result', requestId: 'r', ok: false,
      data: { stage: 'execute' },
      error: { code: 'adapter_runtime_error', message: 'request failed for token=sk-LIVE-9f3c2a1b' },
    });
    expect(s.error?.code).toBe('adapter_runtime_error');     // code preserved (caller still learns it errored)
    expect(s.error?.message).not.toContain('sk-LIVE-9f3c2a1b'); // raw seed never surfaced
    expect(JSON.stringify(s)).not.toContain('sk-LIVE-9f3c2a1b');
  });

  it('M7c: redacts by stage, not code — an adapter that sets a known code is still redacted', () => {
    const s = normalizeRunnerResult({
      type: 'result', requestId: 'r', ok: false,
      data: { stage: 'execute' },
      error: { code: 'auth_required', message: 'auth failed: password=hunter2' }, // adapter spoofs a known code
    });
    expect(s.error?.message).not.toContain('hunter2');
  });

  it('M7c: keeps a load-stage error message verbatim (no seed exposure, debuggability)', () => {
    const s = normalizeRunnerResult({
      type: 'result', requestId: 'r', ok: false,
      data: { stage: 'load' },
      error: { code: 'adapter_runtime_error', message: "SyntaxError: Unexpected token at line 5", hint: 'adapter failed to load' },
    });
    expect(s.error?.message).toBe('SyntaxError: Unexpected token at line 5');
    expect(s.error?.hint).toBe('adapter failed to load'); // runner-generated hint surfaces
  });

  it('M7c: withholds an execute-stage hint too (defense-in-depth, even if it carries a seed)', () => {
    const s = normalizeRunnerResult({
      type: 'result', requestId: 'r', ok: false,
      data: { stage: 'execute' },
      error: { code: 'adapter_runtime_error', message: 'boom', hint: 'retry with token=sk-LIVE-77' },
    });
    expect(s.error?.hint).toBeUndefined();                       // adapter-controlled hint dropped
    expect(JSON.stringify(s)).not.toContain('sk-LIVE-77');
    expect(s.error?.code).toBe('adapter_runtime_error');         // code still preserved
  });

  it('M7c: collapses an unsafe execute-stage code to adapter_runtime_error (code is adapter-controlled)', () => {
    // an adapter can `throw Object.assign(new Error("x"), { code: seed.password })`
    const s = normalizeRunnerResult({
      type: 'result', requestId: 'r', ok: false,
      data: { stage: 'execute' },
      error: { code: 'sk-LIVE-secret-as-code', message: 'x' },
    });
    expect(s.error?.code).toBe('adapter_runtime_error');         // seed-valued code never surfaced
    expect(JSON.stringify(s)).not.toContain('sk-LIVE-secret-as-code');
  });

  it('M7c: preserves a known-safe execute-stage code (auth_required)', () => {
    const s = normalizeRunnerResult({
      type: 'result', requestId: 'r', ok: false,
      data: { stage: 'execute' },
      error: { code: 'auth_required', message: 'login needed' },
    });
    expect(s.error?.code).toBe('auth_required'); // allowlisted → the legit signal survives
  });
});

describe('verify · validateRunnerConfig (09 HighLevelConfig ranges)', () => {
  it('all-empty → defaults', () => {
    const r = validateRunnerConfig({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config).toEqual({
        maxConcurrency: 2,
        queueLimit: 10,
        stdoutLimitBytes: 1_048_576,
        stderrLimitBytes: 65_536,
        jsonlLineLimit: 65_536,
        timeoutMs: 30_000,
        killGraceMs: 1500,
      });
    }
  });
  it('empty string and undefined both fall back to default', () => {
    const r = validateRunnerConfig({ timeoutMs: '', killGraceMs: undefined });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.timeoutMs).toBe(30_000);
      expect(r.config.killGraceMs).toBe(1500);
    }
  });
  it('accepts in-range integer overrides', () => {
    const r = validateRunnerConfig({ maxConcurrency: '8', timeoutMs: '60000' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.maxConcurrency).toBe(8);
      expect(r.config.timeoutMs).toBe(60_000);
    }
  });
  it('below min → config_invalid', () => {
    const r = validateRunnerConfig({ timeoutMs: '999' }); // min 1000
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorCode).toBe('config_invalid');
      expect(r.reason).toContain('timeoutMs');
    }
  });
  it('above max → config_invalid', () => {
    const r = validateRunnerConfig({ maxConcurrency: '2000' }); // max 1024
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('maxConcurrency');
  });
  it('non-integer (float) → config_invalid', () => {
    const r = validateRunnerConfig({ killGraceMs: '1500.5' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('killGraceMs');
  });
  it('non-numeric → config_invalid', () => {
    const r = validateRunnerConfig({ stdoutLimitBytes: 'lots' });
    expect(r.ok).toBe(false);
  });
  it('enforces each field min boundary inclusively', () => {
    const r = validateRunnerConfig({
      maxConcurrency: '1', queueLimit: '0', stdoutLimitBytes: '1024', stderrLimitBytes: '1024',
      jsonlLineLimit: '1024', timeoutMs: '1000', killGraceMs: '100',
    });
    expect(r.ok).toBe(true);
  });
  it('queueLimit accepts 0 (min, no queue) and rejects > 1000', () => {
    const zero = validateRunnerConfig({ queueLimit: '0' });
    expect(zero.ok).toBe(true);
    if (zero.ok) expect(zero.config.queueLimit).toBe(0);
    const over = validateRunnerConfig({ queueLimit: '1001' });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain('queueLimit');
  });
});

describe('verify · buildRunnerArgs (no shell string)', () => {
  it('builds a flat argv array in 08 order', () => {
    const args = buildRunnerArgs({ requestId: 'req_1', name: 'demo/search', inputPath: '/tmp/x/input.json' });
    expect(args).toEqual([
      'internal', 'verify-runner', '--jsonl',
      '--request-id', 'req_1',
      '--name', 'demo/search',
      '--input', '/tmp/x/input.json',
    ]);
  });
  it('passes values verbatim (no shell interpolation, no quoting)', () => {
    const args = buildRunnerArgs({ requestId: 'req_2', name: 'a b/c;d', inputPath: '/tmp/p ath/i.json' });
    // Each value is its own array element — spaces/semicolons are inert, never a shell token.
    expect(args).toContain('a b/c;d');
    expect(args).toContain('/tmp/p ath/i.json');
    expect(args[0]).toBe('internal');
  });
  it('appends --protocol-fd only when provided (Codex #3 dedicated protocol channel)', () => {
    const withFd = buildRunnerArgs({ requestId: 'r', name: 'n', inputPath: '/i', protocolFd: 3 });
    expect(withFd.slice(-2)).toEqual(['--protocol-fd', '3']);
    const withoutFd = buildRunnerArgs({ requestId: 'r', name: 'n', inputPath: '/i' });
    expect(withoutFd).not.toContain('--protocol-fd'); // standalone debugging → stdout fallback
  });
  it('appends --max-runtime-ms only when provided (Codex #7 orphan self-watchdog)', () => {
    const withWd = buildRunnerArgs({ requestId: 'r', name: 'n', inputPath: '/i', maxRuntimeMs: 635000 });
    expect(withWd.slice(-2)).toEqual(['--max-runtime-ms', '635000']);
    const withoutWd = buildRunnerArgs({ requestId: 'r', name: 'n', inputPath: '/i' });
    expect(withoutWd).not.toContain('--max-runtime-ms'); // standalone debugging → no watchdog
  });
});
