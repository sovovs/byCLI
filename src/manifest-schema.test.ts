import { describe, expect, it } from 'vitest';
import { canonicalizeManifestArgSchema, ManifestSchemaError } from './manifest-schema.js';

describe('manifest argument schema canonicalization', () => {
  it('compares valid plain JSON defaults independent of object key order', () => {
    const left = [{ name: 'config', default: { outer: { b: 2, a: 1 }, enabled: true } }];
    const right = [{ name: 'config', default: { enabled: true, outer: { a: 1, b: 2 } } }];

    expect(canonicalizeManifestArgSchema(left, 'test/left'))
      .toBe(canonicalizeManifestArgSchema(right, 'test/right'));
  });

  it.each([
    ['function default', () => true],
    ['explicit undefined default', undefined],
    ['date default', new Date('2026-07-14T00:00:00.000Z')],
    ['NaN default', Number.NaN],
    ['negative zero default', -0],
    ['bigint default', 1n],
    ['custom instance default', new (class Custom { value = 1; })()],
  ])('rejects an unsafe %s instead of collapsing it during JSON serialization', (_label, value) => {
    expect(() => canonicalizeManifestArgSchema([
      { name: 'unsafe', default: value },
    ], 'test/unsafe')).toThrow(ManifestSchemaError);
  });

  it('rejects cyclic defaults', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeManifestArgSchema([
      { name: 'unsafe', default: cyclic },
    ], 'test/cyclic')).toThrow(/cyclic/i);
  });

  it('does not treat a missing default as an explicit undefined default', () => {
    const missing = canonicalizeManifestArgSchema([{ name: 'value' }], 'test/missing');
    expect(() => canonicalizeManifestArgSchema([
      { name: 'value', default: undefined },
    ], 'test/undefined')).toThrow(ManifestSchemaError);
    expect(missing).toContain('default:missing');
  });

  it('distinguishes a string Date representation and null from unsafe Date and NaN values', () => {
    expect(() => canonicalizeManifestArgSchema([
      { name: 'date', default: new Date('2026-07-14T00:00:00.000Z') },
    ], 'test/date')).toThrow(ManifestSchemaError);
    expect(canonicalizeManifestArgSchema([
      { name: 'date', default: '2026-07-14T00:00:00.000Z' },
    ], 'test/date-string')).toContain('string:');
    expect(() => canonicalizeManifestArgSchema([
      { name: 'number', default: Number.NaN },
    ], 'test/nan')).toThrow(ManifestSchemaError);
    expect(canonicalizeManifestArgSchema([
      { name: 'number', default: null },
    ], 'test/null')).toContain('null');
  });

  it('rejects non-string and unsafe choice values', () => {
    expect(() => canonicalizeManifestArgSchema([
      { name: 'choice', choices: ['ok', 1] as unknown as string[] },
    ], 'test/choice')).toThrow(/choice/i);
    expect(() => canonicalizeManifestArgSchema([
      { name: 'choice', choices: ['ok', undefined] as unknown as string[] },
    ], 'test/choice')).toThrow(/choice/i);
  });

  it('accepts valid dense nested arrays', () => {
    expect(() => canonicalizeManifestArgSchema([
      { name: 'matrix', default: [[1, 2], [3, { ok: true }]] },
    ], 'test/dense-arrays')).not.toThrow();
  });

  it('rejects repeated object identities while accepting duplicated JSON values', () => {
    const shared = { value: 1 };
    expect(() => canonicalizeManifestArgSchema([
      { name: 'shared', default: [shared, shared] },
    ], 'test/shared')).toThrow(/shared|repeated/i);
    expect(() => canonicalizeManifestArgSchema([
      { name: 'duplicated', default: [{ value: 1 }, { value: 1 }] },
    ], 'test/duplicated')).not.toThrow();
  });

  it('rejects a sparse top-level args container', () => {
    const args = new Array(2) as Array<{ name: string }>;
    args[1] = { name: 'present' };
    expect(() => canonicalizeManifestArgSchema(args, 'test/sparse-args')).toThrow(/sparse/i);
  });

  it.each([
    ['extra property', () => Object.assign(['one'], { meta: true })],
    ['symbol property', () => {
      const choices = ['one'];
      Object.defineProperty(choices, Symbol('meta'), { value: true });
      return choices;
    }],
    ['accessor', () => {
      const choices: string[] = [];
      Object.defineProperty(choices, '0', { get: () => 'one', enumerable: true, configurable: true });
      return choices;
    }],
    ['nonstandard descriptor', () => Object.freeze(['one'])],
  ])('rejects a choices container with unsafe %s', (_label, makeChoices) => {
    expect(() => canonicalizeManifestArgSchema([
      { name: 'choice', choices: makeChoices() as unknown as string[] },
    ], 'test/unsafe-choices')).toThrow(ManifestSchemaError);
  });

  it.each([
    ['extra string property', () => {
      const value: unknown[] & { meta?: string } = [];
      value.meta = 'lost';
      return value;
    }],
    ['symbol property', () => {
      const value: unknown[] = [];
      Object.defineProperty(value, Symbol('meta'), { value: true, enumerable: true });
      return value;
    }],
    ['accessor index', () => {
      const value: unknown[] = [];
      Object.defineProperty(value, '0', { get: () => 'lost', enumerable: true, configurable: true });
      return value;
    }],
    ['non-enumerable extra', () => {
      const value: unknown[] = [];
      Object.defineProperty(value, 'meta', { value: true, enumerable: false });
      return value;
    }],
  ])('rejects array %s metadata that JSON cannot faithfully preserve', (_label, makeValue) => {
    expect(() => canonicalizeManifestArgSchema([
      { name: 'unsafe-array', default: makeValue() },
    ], 'test/unsafe-array')).toThrow(ManifestSchemaError);
  });
});
