// 结构化日志(M8b · 09 Structured Logging)。
// 关键设计:`LogFields` 只含 09 的 allowed 字段 —— token/cookie/Authorization/raw body/raw
// executionSeedArgs/raw stdout-stderr/完整 trace path 等 forbidden 字段**类型上就放不进来**,
// 故"敏感字段绝不进日志"是 by-construction 保证,不靠调用方自觉。每条日志是一行 JSON。
// 级别按 error<warn<info<debug 过滤;级别运行时可调(SIGUSR2,见 server.ts),改级别本身会记一条,
// 且永不放宽 redaction —— 任何级别下 forbidden 字段都进不来。

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
  /** Where a formatted JSON line goes. Default: stderr (stdout is reserved / structured-only). */
  sink?: (line: string) => void;
  /** Injectable clock for the `time` field (tests). Default: ISO now. */
  now?: () => string;
}

const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];

export function createLogger(initialLevel: LogLevel, opts: LoggerOptions = {}): Logger {
  let level = initialLevel;
  const sink = opts.sink ?? ((line) => process.stderr.write(line + '\n'));
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
