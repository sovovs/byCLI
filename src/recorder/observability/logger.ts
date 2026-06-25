// Structured logger for the daemon/runner recording path (#1a · 09 Structured Logging).
//
// The main repo keeps TWO loggers on purpose: `src/logger.ts` (human-facing emoji singleton,
// 17 CLI consumers, unchanged) and THIS one — single-line JSON for the daemon/runner SERVICE path,
// whose output goes to a detached process's stderr captured to daemon logs, never to an interactive
// user. The formatter + by-construction redaction (LogFields = only 09 allowed fields) live in
// recorder-core; this thin factory supplies the stderr sink that core deliberately omits to stay
// IO-free. Reuses the exact same engine as dashboard-be's logger so daemon/be log shapes match.

import { createLogger as createCoreLogger, type Logger, type LogLevel } from '@sovovs/bycli-recorder-core';

export type { Logger, LogLevel } from '@sovovs/bycli-recorder-core';
export type { LogFields } from '@sovovs/bycli-recorder-core';

/** daemon/runner structured logger: single-line JSON to stderr. Inject `sink` in tests. */
export function createRecorderLogger(
  level: LogLevel,
  sink: (line: string) => void = (line) => process.stderr.write(line + '\n'),
): Logger {
  return createCoreLogger(level, { sink });
}
