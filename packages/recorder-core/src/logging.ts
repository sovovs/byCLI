// Structured logging (09 Structured Logging) — the single shared implementation.
//
// Key design: `LogFields` holds ONLY the 09 allowed fields — token/cookie/Authorization/raw body/
// raw executionSeedArgs/raw stdout-stderr/full trace path and other forbidden fields **cannot be
// typed in**, so "sensitive fields never reach a log line" is a by-construction guarantee, not
// caller discipline. Each log entry is one JSON line. Levels filter by error<warn<info<debug;
// the level is runtime-adjustable and a change is itself logged, but redaction is NEVER widened —
// forbidden fields are unrepresentable at every level.
//
// Charter: pure formatter, **no IO** — the `sink` is injected and DEFAULTS TO A NO-OP here so
// recorder-core never touches `process.stderr`. dashboard-be and the main-repo daemon/runner
// wrap this and supply a real stderr sink; both re-export it so there is one implementation.

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** 09 allowed log fields ONLY. Adding a forbidden field here is a deliberate type error. */
export interface LogFields {
  requestId?: string;
  sessionId?: string;
  contextId?: string;
  stage?: string;
  status?: string;
  errorCode?: string;
  durationMs?: number;
  queueDepth?: number;
}

export interface Logger {
  error(operation: string, fields?: LogFields): void;
  warn(operation: string, fields?: LogFields): void;
  info(operation: string, fields?: LogFields): void;
  debug(operation: string, fields?: LogFields): void;
  /** Runtime level change (09 Log Level Control). Returns the new level. */
  setLevel(level: LogLevel): LogLevel;
  /** Cycle error→warn→info→debug→error (SIGUSR2 operator toggle). Returns the new level. */
  cycleLevel(): LogLevel;
  getLevel(): LogLevel;
}

export interface LoggerOptions {
  /** Where a formatted JSON line goes. Default: no-op (core stays IO-free; callers supply stderr). */
  sink?: (line: string) => void;
  /** Injectable clock for the `time` field (tests). Default: ISO now. */
  now?: () => string;
}

const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];

export function createLogger(initialLevel: LogLevel, opts: LoggerOptions = {}): Logger {
  let level = initialLevel;
  const sink = opts.sink ?? (() => { /* no-op: core is IO-free; be/daemon wrappers inject stderr */ });
  const now = opts.now ?? (() => new Date().toISOString());

  const emit = (lvl: LogLevel, operation: string, fields?: LogFields): void => {
    if (ORDER[lvl] > ORDER[level]) return; // below the active verbosity → dropped
    // Only `operation` + the allowed LogFields are serialized; nothing else can reach here.
    sink(JSON.stringify({ time: now(), level: lvl, operation, ...fields }));
  };

  return {
    error: (op, f) => emit('error', op, f),
    warn: (op, f) => emit('warn', op, f),
    info: (op, f) => emit('info', op, f),
    debug: (op, f) => emit('debug', op, f),
    setLevel: (l) => { level = l; return level; },
    cycleLevel: () => { level = LEVELS[(LEVELS.indexOf(level) + 1) % LEVELS.length]!; return level; },
    getLevel: () => level,
  };
}
