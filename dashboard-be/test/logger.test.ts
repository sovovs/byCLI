import { describe, it, expect } from 'vitest';
import { createLogger } from '../src/logger.js';

function capture(level: 'error' | 'warn' | 'info' | 'debug') {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(level, { sink: (l) => lines.push(JSON.parse(l)), now: () => 'T0' });
  return { logger, lines };
}

describe('structured logger (M8b · 09)', () => {
  it('emits a JSON line with time/level/operation + only the passed allowed fields', () => {
    const { logger, lines } = capture('info');
    logger.info('recorder.verify', { requestId: 'req_1', sessionId: 'rec_1', status: 'accepted', durationMs: 12 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ time: 'T0', level: 'info', operation: 'recorder.verify', requestId: 'req_1', sessionId: 'rec_1', status: 'accepted', durationMs: 12 });
  });

  it('filters by level (info logger drops debug; error logger drops warn/info/debug)', () => {
    const info = capture('info');
    info.logger.debug('x');
    info.logger.info('y');
    expect(info.lines.map((l) => l.operation)).toEqual(['y']); // debug dropped

    const err = capture('error');
    err.logger.warn('a'); err.logger.info('b'); err.logger.debug('c'); err.logger.error('d');
    expect(err.lines.map((l) => l.operation)).toEqual(['d']); // only error passes
  });

  it('setLevel / cycleLevel adjust verbosity at runtime', () => {
    const { logger, lines } = capture('error');
    logger.info('dropped'); // below error
    expect(lines).toHaveLength(0);
    expect(logger.cycleLevel()).toBe('warn');
    expect(logger.cycleLevel()).toBe('info');
    logger.info('now-visible');
    expect(lines.map((l) => l.operation)).toEqual(['now-visible']);
    expect(logger.setLevel('debug')).toBe('debug');
    logger.debug('deep');
    expect(lines.map((l) => l.operation)).toEqual(['now-visible', 'deep']);
    expect(logger.cycleLevel()).toBe('error'); // debug → wraps to error
  });
});
