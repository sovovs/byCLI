// Structured logging (M8b · 09). The implementation moved to recorder-core (#1a) — a pure, IO-free
// formatter with by-construction redaction (LogFields holds only 09 allowed fields, so forbidden
// fields are unrepresentable). This module wraps it to default the sink to stderr (core stays
// IO-free) and re-exports the types, so existing be imports + logger.test.ts are unchanged.
import {
  createLogger as createCoreLogger,
  type Logger,
  type LogLevel,
  type LogFields,
  type LoggerOptions,
} from '@sovovs/bycli-recorder-core';

export type { Logger, LogLevel, LogFields, LoggerOptions };

/** be logger: defaults the sink to stderr (stdout is reserved); tests override via opts.sink. */
export function createLogger(initialLevel: LogLevel, opts: LoggerOptions = {}): Logger {
  return createCoreLogger(initialLevel, { sink: (line) => process.stderr.write(line + '\n'), ...opts });
}
