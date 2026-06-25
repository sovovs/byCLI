import { describe, it, expect } from 'vitest';
import { deriveEvidenceSeedArgs } from '@sovovs/bycli-recorder-core';
import { SessionKeyRegistry, defaultSessionKeyRegistry } from './session-keys.js';

// Deterministic clock + key source so we can assert stability / rotation precisely.
function fixture(ttlMs = 1000) {
  let clock = 1_000_000;
  let n = 0;
  const reg = new SessionKeyRegistry(ttlMs, () => clock, () => `k${++n}`);
  return { reg, tick: (ms: number) => { clock += ms; }, mintCount: () => n };
}

describe('SessionKeyRegistry (M7a per-session HMAC key)', () => {
  it('is stable within a session and distinct across sessions', () => {
    const { reg } = fixture();
    const a1 = reg.keyFor('sess-A');
    const a2 = reg.keyFor('sess-A');
    const b = reg.keyFor('sess-B');
    expect(a1).toBe(a2);      // same session → same secret
    expect(a1).not.toBe(b);   // different session → different secret
    expect(reg.size()).toBe(2);
  });

  it('uses one stable process-wide fallback when sessionId is absent', () => {
    const { reg } = fixture();
    const f1 = reg.keyFor();
    const f2 = reg.keyFor(undefined);
    const s = reg.keyFor('sess-A');
    expect(f1).toBe(f2);          // fallback stable
    expect(f1).not.toBe(s);       // fallback is not a session key
    expect(reg.size()).toBe(1);   // fallback is not stored in the session map
  });

  it('rotates the salt after the TTL elapses', () => {
    const { reg, tick } = fixture(1000);
    const before = reg.keyFor('sess-A');
    tick(1500); // past the 1000ms TTL
    const after = reg.keyFor('sess-A');
    expect(after).not.toBe(before); // expired → re-minted, old secret gone
  });

  it('evict() drops a session salt so the next key is fresh', () => {
    const { reg } = fixture();
    const before = reg.keyFor('sess-A');
    reg.evict('sess-A');
    const after = reg.keyFor('sess-A');
    expect(after).not.toBe(before);
  });

  it('sweepExpired drops only expired salts and reports the count', () => {
    const { reg, tick } = fixture(1000);
    reg.keyFor('old');   // createdAt = T0
    tick(600);
    reg.keyFor('fresh'); // createdAt = T0+600, both still within the 1000ms TTL here
    tick(600);           // now T0+1200: 'old' is expired (1200>1000), 'fresh' is not (600<1000)
    const dropped = reg.sweepExpired();
    expect(dropped).toBe(1);    // only 'old' expired
    expect(reg.size()).toBe(1); // 'fresh' remains
  });

  it('yields session-scoped, non-comparable-across-session evidence HMACs', () => {
    const { reg } = fixture();
    const raw = { token: 'secret-value' };
    const evA = deriveEvidenceSeedArgs(raw, reg.keyFor('sess-A'));
    const evA2 = deriveEvidenceSeedArgs(raw, reg.keyFor('sess-A'));
    const evB = deriveEvidenceSeedArgs(raw, reg.keyFor('sess-B'));
    // same value, same session → same hmac; same value, different session → different hmac.
    expect(evA.token.hmac).toBe(evA2.token.hmac);
    expect(evA.token.hmac).not.toBe(evB.token.hmac);
    expect(evA.token.hmacScope).toBe('recorder_session');
  });

  it('defaultSessionKeyRegistry is a stable singleton', () => {
    expect(defaultSessionKeyRegistry()).toBe(defaultSessionKeyRegistry());
  });
});
