import { describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { buildSecretSet, redactText, redactValue } from './redact.js';

describe('plugin redaction', () => {
  it('builds unique, longest-first secrets from credentials and every cookie value', () => {
    const cookie = [
      'slave_sid=session+/=value',
      'data_ticket=ticket-value',
      'bizuin=business-value',
      'cert=certificate-value',
      'rand_info=random-value',
      'duplicate=ticket-value',
    ].join('; ');
    const secrets = buildSecretSet({
      token: 'token+/=value',
      cookie,
      fingerprint: 'fingerprint+/=value',
    });

    const expectedMembers = [
      'token+/=value',
      'token%2B%2F%3Dvalue',
      cookie,
      encodeURIComponent(cookie),
      'session+/=value',
      'session%2B%2F%3Dvalue',
      'ticket-value',
      'business-value',
      'certificate-value',
      'random-value',
      'fingerprint+/=value',
      'fingerprint%2B%2F%3Dvalue',
    ];
    expect(expectedMembers.every(member => secrets.includes(member))).toBe(true);
    expect(new Set(secrets).size).toBe(secrets.length);
    expect(secrets.map(secret => secret.length)).toEqual(
      [...secrets].map(secret => secret.length).sort((left, right) => right - left),
    );
  });

  it('redacts raw and encoded credential material without exposing it in assertions', () => {
    const credentials = {
      token: 'token+/=value',
      cookie: 'slave_sid=session-value; data_ticket=ticket-value',
      fingerprint: 'fingerprint+/=value',
    };
    const secrets = buildSecretSet(credentials);
    const output = redactText(
      [
        credentials.token,
        encodeURIComponent(credentials.token),
        credentials.cookie,
        'session-value',
        'ticket-value',
        encodeURIComponent(credentials.fingerprint),
      ].join(' '),
      secrets,
    );

    expect(secrets.every(secret => !output.includes(secret))).toBe(true);
    expect(output.includes('[REDACTED]')).toBe(true);
  });

  it('matches percent-escape hex digits case-insensitively but keeps literal text case-sensitive', () => {
    const credentials = {
      token: 'token-value',
      cookie: 'slave_sid=session-value',
      fingerprint: 'fingerprint+/=value',
    };
    const secrets = buildSecretSet(credentials);
    const lowerEncoded = 'fingerprint%2b%2f%3dvalue';
    const mixedEncoded = 'fingerprint%2B%2f%3Dvalue';
    const changedLiteralCase = 'Fingerprint%2b%2f%3dvalue';

    expect(redactText(lowerEncoded, secrets) === '[REDACTED]').toBe(true);
    expect(redactText(mixedEncoded, secrets) === '[REDACTED]').toBe(true);
    expect(redactText(changedLiteralCase, secrets) === changedLiteralCase).toBe(true);
  });

  it('redacts non-empty secrets even when they are only one to three characters', () => {
    const secrets = buildSecretSet({
      token: 't',
      cookie: 'a=c',
      fingerprint: '+/',
    });
    const directSecret = 'xyz';

    expect(secrets.includes('')).toBe(false);
    expect(secrets.includes('t')).toBe(true);
    expect(secrets.includes('a=c')).toBe(true);
    expect(secrets.includes('c')).toBe(true);
    expect(secrets.includes('+/')).toBe(true);
    expect(secrets.includes('%2B%2F')).toBe(true);
    expect(redactText('token=t', secrets)).toBe('token=[REDACTED]');
    expect(redactText('Cookie: a=c', secrets)).toBe('Cookie: [REDACTED]');
    expect(redactText('Cookie: name=c', ['c'])).toBe('Cookie: name=[REDACTED]');
    expect(redactText('fingerprint=+/', secrets)).toBe('fingerprint=[REDACTED]');
    expect(redactText('fingerprint=%2B%2F', secrets)).toBe('fingerprint=[REDACTED]');
    expect(redactText(directSecret, [directSecret, ''])).toBe('[REDACTED]');
  });

  it('uses context-aware matching for short secrets without corrupting prose or protocols', () => {
    const secrets = buildSecretSet({ token: 'a', cookie: 'n=1', fingerprint: 'x' });

    expect(redactText('HTTP 1.1 uses a prose example', secrets)).toBe(
      'HTTP 1.1 uses a prose example',
    );
    expect(redactText('a', secrets)).toBe('[REDACTED]');
    expect(redactText('  1  ', secrets)).toBe('  [REDACTED]  ');
    expect(redactText('token=a&fingerprint=x', secrets)).toBe(
      'token=[REDACTED]&fingerprint=[REDACTED]',
    );
    expect(redactText('Cookie: n=1', secrets)).toBe('Cookie: [REDACTED]');
  });

  it('redacts an arbitrary short secret in an explicit Cookie value', () => {
    expect(redactText('Cookie: n=1', ['1'])).toBe('Cookie: n=[REDACTED]');
  });

  it('reconstructs cookie value context from copied plain secret arrays', () => {
    const secrets = buildSecretSet({
      token: 'long-token',
      cookie: 'uin=1',
      fingerprint: 'long-fingerprint',
    });
    const variants = [
      [...secrets],
      secrets.filter(Boolean),
      Object.freeze([...secrets]),
      JSON.parse(JSON.stringify(secrets)),
    ];

    expect(variants.map(variant => redactText('uin: 1', variant))).toEqual(
      variants.map(() => 'uin: [REDACTED]'),
    );
  });

  it('does not authorize unrelated short secrets from another credential signal', () => {
    expect(redactText('cookie=x ordinary a prose', ['a'])).toBe(
      'cookie=x ordinary a prose',
    );
  });

  it('does not let adjacent arbitrary secrets authorize ordinary prose', () => {
    expect(redactText('HTTP a prose example', ['a', 'prose'])).toBe(
      'HTTP a prose example',
    );
  });

  it('performs one-pass replacement without rescanning markers or amplifying repeatedly', () => {
    const markerCharacters = [...new Set('[REDACTED]')];
    expect(redactText('token-secret', ['token-secret', ...markerCharacters])).toBe('[REDACTED]');

    const repeated = 'token-secret'.repeat(5_000);
    const output = redactText(repeated, ['token-secret']);
    expect(output).toBe('[REDACTED]'.repeat(5_000));
    expect(output.length <= repeated.length * 2).toBe(true);
  });

  it('bounds short-secret context parsing work linearly', () => {
    const input = 'a'.repeat(1_000);
    const originalSlice = String.prototype.slice;
    let slicedCharacters = 0;
    let output = '';
    const sliceSpy = vi.spyOn(String.prototype, 'slice').mockImplementation(function (
      start,
      end,
    ) {
      const result = originalSlice.call(this, start, end);
      slicedCharacters += result.length;
      return result;
    });

    try {
      output = redactText(input, ['a']);
    } finally {
      sliceSpy.mockRestore();
    }

    expect(output).toBe(input);
    expect(slicedCharacters).toBeLessThan(input.length * 20);
  });

  it('redacts nested arrays and plain objects without mutating the input', () => {
    const secret = ['synthetic', 'credential'].join('-');
    const input = {
      message: secret,
      stage: 'download',
      nested: [{ detail: `prefix ${secret} suffix` }],
    };

    const result = redactValue(input, [secret]);

    expect(result === input).toBe(false);
    expect(result.nested === input.nested).toBe(false);
    expect(result.nested[0] === input.nested[0]).toBe(false);
    expect(result.message === '[REDACTED]').toBe(true);
    expect(result.nested[0]?.detail === 'prefix [REDACTED] suffix').toBe(true);
    expect(result.stage).toBe('download');
    expect(input.message === secret).toBe(true);
  });

  it('breaks cycles safely while retaining non-cyclic shared references', () => {
    const secret = ['cycle', 'credential'].join('-');
    const shared = { message: secret };
    const input = {
      message: secret,
      left: shared,
      right: shared,
    };
    input.self = input;

    const result = redactValue(input, [secret]);

    expect(result.message === '[REDACTED]').toBe(true);
    expect(result.self === '[CIRCULAR]').toBe(true);
    expect(result.left === result.right).toBe(true);
    expect(input.message === secret).toBe(true);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('does not invoke getters and redacts custom-prototype instances', () => {
    const secret = ['getter', 'credential'].join('-');
    let getterCalls = 0;
    const input = Object.defineProperty({ stage: 'download' }, 'message', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return secret;
      },
    });
    class Envelope {
      message = secret;
    }
    const custom = new Envelope();

    const result = redactValue(input, [secret]);

    expect(getterCalls).toBe(0);
    expect(Object.getOwnPropertyDescriptor(result, 'message')?.value).toBe('[REDACTED]');
    expect(result.stage).toBe('download');
    const customResult = redactValue(custom, [secret]);
    expect(customResult === custom).toBe(false);
    expect(Object.getPrototypeOf(customResult)).toBeNull();
    expect(customResult.message === '[REDACTED]').toBe(true);
  });

  it('does not invoke getters stored at array indexes', () => {
    const secret = ['array-getter', 'credential'].join('-');
    let getterCalls = 0;
    const input = [];
    Object.defineProperty(input, 0, {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return secret;
      },
    });

    const result = redactValue(input, [secret]);

    expect(getterCalls).toBe(0);
    expect(Object.getOwnPropertyDescriptor(result, '0')?.value).toBe('[REDACTED]');
  });

  it('projects Error subclasses without retaining executable prototypes', () => {
    const secret = ['error', 'credential'].join('-');
    class DiagnosticError extends Error {
      name = 'DiagnosticError';
      detail = secret;
    }
    const input = new DiagnosticError(secret, { cause: new Error(secret) });

    const result = redactValue(input, [secret]);

    expect(result === input).toBe(false);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(result.message === '[REDACTED]').toBe(true);
    expect(result.name).toBe('DiagnosticError');
    expect(result.detail === '[REDACTED]').toBe(true);
    expect((result.cause).message === '[REDACTED]').toBe(true);
    expect(typeof result.stack).toBe('string');
    expect(input.message === secret).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result, 'message')?.enumerable).toBe(false);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(inspect(result).includes(secret)).toBe(false);
  });

  it('redacts symbol-keyed own data while preserving the symbol key', () => {
    const secret = ['symbol', 'credential'].join('-');
    const key = Symbol('diagnostic');
    const input = { [key]: secret, stage: 'download' };

    const result = redactValue(input, [secret]);

    expect(result[key] === '[REDACTED]').toBe(true);
    expect(result.stage).toBe('download');
    expect(input[key] === secret).toBe(true);
  });

  it('sanitizes secret-bearing symbol key descriptions', () => {
    const secret = ['credential', 'secret'].join('-');
    const key = Symbol(secret);
    const result = redactValue({ [key]: 'safe' }, [secret]);
    const projectedSymbols = Object.getOwnPropertySymbols(result);

    expect(projectedSymbols).toHaveLength(1);
    expect(projectedSymbols[0]).not.toBe(key);
    expect(projectedSymbols[0]?.description).toBeUndefined();
    expect(result[projectedSymbols[0]]).toBe('safe');
    expect(inspect(result).includes(secret)).toBe(false);
  });

  it('sanitizes secret-bearing string keys in JSON and inspect output', () => {
    const secret = ['property', 'credential'].join('-');
    const result = redactValue({ [secret]: 'safe-value' }, [secret]);
    const json = JSON.stringify(result);
    const rendered = inspect(result);

    expect(json.includes(secret)).toBe(false);
    expect(rendered.includes(secret)).toBe(false);
    expect(Object.keys(result)).toEqual(['[REDACTED]']);
    expect(result['[REDACTED]']).toBe('safe-value');
  });

  it('resolves sanitized string-key collisions deterministically without dropping values', () => {
    const secret = ['collision', 'credential'].join('-');
    const input = { '[REDACTED]': 'existing', [secret]: 'sanitized' };
    const result = redactValue(input, [secret]);

    expect(Object.keys(result)).toEqual(['[REDACTED]', '[REDACTED]_2']);
    expect(Object.values(result)).toEqual(['existing', 'sanitized']);
    expect(JSON.stringify(result).includes(secret)).toBe(false);
    expect(inspect(result).includes(secret)).toBe(false);
  });

  it('does not let short low-entropy secrets corrupt ordinary object keys', () => {
    const result = redactValue({ stage: 'download', data: 'ok' }, ['a', '1']);

    expect(Object.keys(result)).toEqual(['stage', 'data']);
    expect(result).toEqual({ stage: 'download', data: 'ok' });
  });

  it('preserves canonical array index keys while redacting their values', () => {
    const result = redactValue(['safe', 'token-secret'], ['1', 'token-secret']);

    expect(Object.keys(result)).toEqual(['0', '1']);
    expect(result).toEqual(['safe', '[REDACTED]']);
  });

  it('keeps projected arrays intact through a JSON round trip', () => {
    const result = redactValue(['zero', 'one'], ['1']);

    expect(JSON.parse(JSON.stringify(result))).toEqual(['zero', 'one']);
  });

  it('sanitizes a string key that exactly equals a short secret', () => {
    const result = redactValue({ x: 'safe' }, ['x']);

    expect(Object.keys(result)).toEqual(['[REDACTED]']);
    expect(result['[REDACTED]']).toBe('safe');
  });

  it('sanitizes a long secret embedded in a string key', () => {
    const secret = 'long-credential-secret';
    const result = redactValue({ [`prefix-${secret}-suffix`]: 'safe' }, [secret]);

    expect(JSON.stringify(result).includes(secret)).toBe(false);
    expect(inspect(result).includes(secret)).toBe(false);
  });

  it('compiles candidates once for an entire nested value traversal', () => {
    const secret = ['nested', 'credential'].join('-');
    let filterReads = 0;
    const secrets = new Proxy([secret], {
      get(target, key, receiver) {
        if (key === 'filter') filterReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });

    const result = redactValue({ first: secret, nested: [secret, { third: secret }] }, secrets);

    expect(result).toEqual({
      first: '[REDACTED]',
      nested: ['[REDACTED]', { third: '[REDACTED]' }],
    });
    expect(filterReads).toBe(1);
  });

  it('removes inherited and own serialization hooks without invoking them', () => {
    const secret = ['hook', 'credential'].join('-');
    let hookCalls = 0;
    class HostileEnvelope {
      value = secret;
      toJSON() {
        hookCalls += 1;
        return secret;
      }
      [inspect.custom]() {
        hookCalls += 1;
        return secret;
      }
    }
    const inheritedHooks = new HostileEnvelope();
    const ownHooks = {
      value: secret,
      toJSON: () => {
        hookCalls += 1;
        return secret;
      },
      [inspect.custom]: () => {
        hookCalls += 1;
        return secret;
      },
    };

    for (const input of [inheritedHooks, ownHooks]) {
      const result = redactValue(input, [secret]);
      const json = JSON.stringify(result);
      const rendered = inspect(result);
      expect(json.includes(secret)).toBe(false);
      expect(rendered.includes(secret)).toBe(false);
      expect(Object.getPrototypeOf(result)).toBeNull();
    }
    expect(hookCalls).toBe(0);
  });

  it('returns inert serializable projections for branded and callable inputs', () => {
    const secret = ['brand', 'credential'].join('-');
    const date = Object.assign(new Date(), { detail: secret });
    const map = Object.assign(new Map([['key', secret]]), { detail: secret });
    const set = Object.assign(new Set([secret]), { detail: secret });
    const callable = Object.assign(() => secret, { detail: secret });

    for (const input of [date, map, set, callable]) {
      const result = redactValue(input, [secret]);
      const json = JSON.stringify(result);
      const rendered = inspect(result);
      expect(json.includes(secret)).toBe(false);
      expect(rendered.includes(secret)).toBe(false);
      expect(typeof result === 'function').toBe(false);
    }
  });

  it('projects non-JSON primitives to stable serializable markers', () => {
    const result = redactValue(
      {
        bigint: 1n,
        symbol: Symbol('sensitive-description'),
        undefinedValue: undefined,
        nan: Number.NaN,
        infinity: Number.POSITIVE_INFINITY,
      },
      [],
    );

    expect(result.bigint).toBe('[BIGINT]');
    expect(result.symbol).toBe('[SYMBOL]');
    expect(result.undefinedValue).toBe('[UNDEFINED]');
    expect(result.nan).toBe('[NON_FINITE_NUMBER]');
    expect(result.infinity).toBe('[NON_FINITE_NUMBER]');
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('fails closed when object reflection throws', () => {
    const secret = ['proxy', 'credential'].join('-');
    const hostile = new Proxy(
      { value: secret },
      {
        ownKeys() {
          throw new Error('reflection denied');
        },
      },
    );

    const result = redactValue(hostile, [secret]);

    expect(result).toBe('[REDACTED]');
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(inspect(result).includes(secret)).toBe(false);
  });
});
