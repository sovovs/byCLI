import type { Arg } from './registry.js';

export class ManifestSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestSchemaError';
  }
}

function fail(context: string, path: string, reason: string): never {
  throw new ManifestSchemaError(`${context} ${path}: ${reason}`);
}

function markSeen(value: object, context: string, path: string, seen: Set<object>): void {
  if (seen.has(value)) fail(context, path, 'cyclic or repeated/shared object identities cannot be represented faithfully in JSON');
  seen.add(value);
}

function denseArrayValues(value: unknown[], context: string, path: string): unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    fail(context, path, 'must be a standard JSON array (custom array instances are not supported)');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail(context, path, 'symbol-keyed array properties cannot be represented in JSON');
  }
  const propertyNames = Object.getOwnPropertyNames(value);
  const expectedNames = new Set(['length']);
  for (let index = 0; index < value.length; index += 1) expectedNames.add(String(index));
  for (const propertyName of propertyNames) {
    if (!expectedNames.has(propertyName)) {
      fail(context, `${path}.${propertyName}`, 'extra array properties cannot be represented in JSON');
    }
  }
  if (propertyNames.length !== expectedNames.size) {
    fail(context, path, 'sparse arrays cannot be represented faithfully in JSON');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    !lengthDescriptor
    || !('value' in lengthDescriptor)
    || lengthDescriptor.value !== value.length
    || lengthDescriptor.enumerable
    || lengthDescriptor.configurable
    || !lengthDescriptor.writable
  ) {
    fail(context, `${path}.length`, 'non-standard array length descriptors cannot be represented faithfully in JSON');
  }
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) fail(context, `${path}[${index}]`, 'sparse arrays cannot be represented faithfully in JSON');
    if (
      !('value' in descriptor)
      || !descriptor.enumerable
      || !descriptor.configurable
      || !descriptor.writable
    ) {
      fail(context, `${path}[${index}]`, 'non-standard array item descriptors cannot be represented faithfully in JSON');
    }
    values.push(descriptor.value);
  }
  return values;
}

function canonicalJsonValue(
  value: unknown,
  context: string,
  path: string,
  seen: Set<object>,
): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `boolean:${value}`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(context, path, 'must be a finite JSON number');
    if (Object.is(value, -0)) fail(context, path, 'negative zero cannot be represented faithfully in JSON');
    return `number:${String(value)}`;
  }
  if (value === undefined) fail(context, path, 'explicit undefined cannot be represented in JSON');
  if (typeof value === 'function') fail(context, path, 'functions cannot be represented in JSON');
  if (typeof value === 'symbol') fail(context, path, 'symbols cannot be represented in JSON');
  if (typeof value === 'bigint') fail(context, path, 'bigints cannot be represented in JSON');

  markSeen(value, context, path, seen);
  {
    if (Array.isArray(value)) {
      const items = denseArrayValues(value, context, path)
        .map((item, index) => canonicalJsonValue(item, context, `${path}[${index}]`, seen));
      return `array:[${items.join(',')}]`;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) {
      fail(context, path, 'must be a plain JSON object (Date and custom instances are not supported)');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail(context, path, 'symbol-keyed properties cannot be represented in JSON');
    }
    const propertyNames = Object.getOwnPropertyNames(value);
    const entries: string[] = [];
    for (const key of propertyNames.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor?.enumerable
        || !('value' in descriptor)
        || !descriptor.configurable
        || !descriptor.writable
      ) {
        fail(context, `${path}.${key}`, 'only enumerable data properties can be represented faithfully in JSON');
      }
      entries.push(`${JSON.stringify(key)}:${canonicalJsonValue(descriptor.value, context, `${path}.${key}`, seen)}`);
    }
    return `object:{${entries.join(',')}}`;
  }
}

function optionalBoolean(value: unknown, context: string, path: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') fail(context, path, 'must be a boolean when present');
  return value;
}

/**
 * Canonical execution-relevant argument schema used by both manifest build and
 * runtime hydration. Objects are key-order independent; arrays remain ordered.
 */
export function canonicalizeManifestArgSchema(
  args: readonly Arg[],
  context: string,
): string {
  if (!Array.isArray(args)) fail(context, 'args', 'must be a dense array');
  const seen = new Set<object>();
  markSeen(args, context, 'args', seen);
  const argValues = denseArrayValues(args, context, 'args') as Arg[];
  return argValues.map((arg, index) => {
    const argContext = `${context} argument "${String(arg.name)}"`;
    if (typeof arg.name !== 'string' || arg.name.length === 0) fail(argContext, 'name', 'must be a non-empty string');
    if (arg.type !== undefined && typeof arg.type !== 'string') fail(argContext, 'type', 'must be a string when present');
    if (arg.help !== undefined && typeof arg.help !== 'string') fail(argContext, 'help', 'must be a string when present');

    const hasDefault = Object.prototype.hasOwnProperty.call(arg, 'default');
    const defaultValue = hasDefault
      ? canonicalJsonValue(arg.default, argContext, 'default', seen)
      : 'missing';

    const hasChoices = Object.prototype.hasOwnProperty.call(arg, 'choices');
    let choices = 'missing';
    if (hasChoices) {
      if (!Array.isArray(arg.choices)) fail(argContext, 'choices', 'must be an array of strings when present');
      markSeen(arg.choices, argContext, 'choices', seen);
      choices = `array:[${denseArrayValues(arg.choices, argContext, 'choices').map((choice, choiceIndex) => {
        if (typeof choice !== 'string') {
          fail(argContext, `choices[${choiceIndex}]`, 'choice values must be strings');
        }
        return `string:${JSON.stringify(choice)}`;
      }).join(',')}]`;
    }

    return [
      `arg:${index}`,
      `name:${JSON.stringify(arg.name)}`,
      `type:${JSON.stringify(arg.type ?? 'str')}`,
      `default:${defaultValue}`,
      `required:${optionalBoolean(arg.required, argContext, 'required')}`,
      `valueRequired:${optionalBoolean(arg.valueRequired, argContext, 'valueRequired')}`,
      `positional:${optionalBoolean(arg.positional, argContext, 'positional')}`,
      `help:${JSON.stringify(arg.help ?? '')}`,
      `choices:${choices}`,
    ].join('|');
  }).join('||');
}
