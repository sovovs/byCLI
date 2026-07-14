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
});
