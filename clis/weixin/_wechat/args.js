import { ArgumentError } from '@sovovs/bycli/errors';

/**
 * @param {Record<string, unknown>} args
 * @returns {'browser' | 'env'}
 */
export function readAuthSource(args) {
  const value = args['auth-source'] ?? 'browser';
  if (value === 'browser' || value === 'env') return value;
  throw new ArgumentError('--auth-source must be one of: browser, env');
}

/**
 * @param {Record<string, unknown>} args
 * @param {string} key
 * @param {number} [fallback]
 * @returns {number | undefined}
 */
export function readPositiveInteger(args, key, fallback) {
  const raw = args[key] ?? fallback;
  if (raw === undefined) return undefined;

  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new ArgumentError(`--${key} must be a positive integer`);
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    throw new ArgumentError(`--${key} must be a positive integer`);
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new ArgumentError(`--${key} must be a positive integer`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} args
 * @param {string} key
 * @returns {string}
 */
export function readRequiredString(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ArgumentError(`--${key} is required`);
  }
  return value.trim();
}
