/**
 * Per-session HMAC key registry (M7a · 04:95-111).
 *
 * The verify evidence HMAC (`deriveEvidenceSeedArgs`) must be keyed by a per-session secret so that
 * seed-arg evidence is scoped to a recorder session (`hmacScope: 'recorder_session'`), is not
 * reversible, and is not comparable across sessions. The secret is a random salt held ONLY in daemon
 * process memory:
 *   - it NEVER crosses the wire (be sends the non-secret `sessionId`; the daemon mints + holds the
 *     salt) — 04:111 forbids the salt from entering any request/response;
 *   - restarting the daemon drops every salt → automatic rotation (04:95);
 *   - a salt also TTL-expires so an abandoned session does not pin its secret forever.
 *
 * This replaces the M5c/M6 placeholder key `daemon-${PORT}`, which was process-wide (every session
 * shared one deterministic key derived from the port — not a per-session secret).
 */
import { randomBytes } from 'node:crypto';

interface SaltEntry { key: string; createdAt: number; }

/** A recording session is short-lived; an hour is a generous ceiling before the salt is dropped. */
export const DEFAULT_SESSION_KEY_TTL_MS = 3_600_000;

export class SessionKeyRegistry {
  private readonly salts = new Map<string, SaltEntry>();
  private fallbackKey: string | null = null;

  constructor(
    private readonly ttlMs: number = DEFAULT_SESSION_KEY_TTL_MS,
    private readonly now: () => number = Date.now,
    /** Injectable secret source (tests); defaults to a 256-bit CSPRNG salt. */
    private readonly mintKey: () => string = () => randomBytes(32).toString('hex'),
  ) {}

  /**
   * The per-session HMAC key: lazily minted on first use and stable for the session's lifetime
   * (within the TTL). An absent `sessionId` (standalone CLI verify with no recorder session) falls
   * back to a single process-wide random secret — still session-unlinkable across daemon restarts and
   * never derived from anything on the wire.
   */
  keyFor(sessionId?: string): string {
    if (!sessionId) {
      this.fallbackKey ??= this.mintKey();
      return this.fallbackKey;
    }
    this.sweepExpired();
    const existing = this.salts.get(sessionId);
    if (existing) return existing.key;
    const key = this.mintKey();
    this.salts.set(sessionId, { key, createdAt: this.now() });
    return key;
  }

  /** Explicit eviction when a session ends (best-effort; the TTL sweep is the backstop). */
  evict(sessionId: string): void { this.salts.delete(sessionId); }

  /** Drop every salt older than the TTL. Called on access and (optionally) on a periodic sweep. */
  sweepExpired(): number {
    const cutoff = this.now() - this.ttlMs;
    let dropped = 0;
    for (const [sid, e] of this.salts) {
      if (e.createdAt < cutoff) { this.salts.delete(sid); dropped++; }
    }
    return dropped;
  }

  /** Live salt count (introspection / tests). */
  size(): number { return this.salts.size; }
}

let singleton: SessionKeyRegistry | null = null;

/** Process-wide registry used by the daemon /v1/verify handler. Reset implicitly on daemon restart. */
export function defaultSessionKeyRegistry(): SessionKeyRegistry {
  return (singleton ??= new SessionKeyRegistry());
}
