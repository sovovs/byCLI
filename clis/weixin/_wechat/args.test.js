import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@sovovs/bycli/errors';
import { readAuthSource, readPositiveInteger, readRequiredString } from './args.js';

describe('argument readers', () => {
  it.each([[undefined, 10], [1, 1], ['2', 2], [10, 10]])(
    'accepts positive integer %s',
    (value, expected) => {
      expect(readPositiveInteger({ limit: value }, 'limit', 10)).toBe(expected);
    },
  );

  it.each([0, -1, 1.5, 'x', true, false, '', ' ', '1.5', Infinity, -Infinity, NaN])(
    'rejects invalid positive integer %s',
    value => {
      expect(() => readPositiveInteger({ limit: value }, 'limit', 10)).toThrow(ArgumentError);
    },
  );

  it('returns undefined when neither a value nor fallback is provided', () => {
    expect(readPositiveInteger({}, 'limit')).toBeUndefined();
  });

  it('uses nullish fallback semantics for positive integers', () => {
    expect(readPositiveInteger({ limit: null }, 'limit', 10)).toBe(10);
    expect(readPositiveInteger({ limit: null }, 'limit')).toBeUndefined();
  });

  it('reads the literal hyphenated auth-source key', () => {
    expect(readAuthSource({ 'auth-source': 'env', authSource: 'browser' })).toBe('env');
    expect(readAuthSource({})).toBe('browser');
    expect(readAuthSource({ 'auth-source': null })).toBe('browser');
  });

  it.each(['other', '', 1, true])('rejects invalid auth source %s', value => {
    expect(() => readAuthSource({ 'auth-source': value })).toThrow(ArgumentError);
  });

  it('trims a required string read from a literal hyphenated key', () => {
    expect(readRequiredString({ 'fake-id': '  account-id  ' }, 'fake-id')).toBe('account-id');
  });

  it.each([undefined, null, '', '   ', 1, true, {}, []])(
    'rejects invalid required string %s',
    value => {
      expect(() => readRequiredString({ query: value }, 'query')).toThrow(ArgumentError);
    },
  );
});
