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

function canonicalJsonValue(
  value: unknown,
  context: string,
  path: string,
  ancestors: Set<object>,
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

  if (ancestors.has(value)) fail(context, path, 'cyclic values cannot be represented in JSON');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
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
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          fail(context, `${path}[${index}]`, 'sparse arrays cannot be represented faithfully in JSON');
        }
        if (
          !('value' in descriptor)
          || !descriptor.enumerable
          || !descriptor.configurable
          || !descriptor.writable
        ) {
          fail(context, `${path}[${index}]`, 'non-standard array item descriptors cannot be represented faithfully in JSON');
        }
        items.push(canonicalJsonValue(descriptor.value, context, `${path}[${index}]`, ancestors));
      }
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
      entries.push(`${JSON.stringify(key)}:${canonicalJsonValue(descriptor.value, context, `${path}.${key}`, ancestors)}`);
    }
    return `object:{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
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
  return args.map((arg, index) => {
    const argContext = `${context} argument "${String(arg.name)}"`;
    if (typeof arg.name !== 'string' || arg.name.length === 0) fail(argContext, 'name', 'must be a non-empty string');
    if (arg.type !== undefined && typeof arg.type !== 'string') fail(argContext, 'type', 'must be a string when present');
    if (arg.help !== undefined && typeof arg.help !== 'string') fail(argContext, 'help', 'must be a string when present');

    const hasDefault = Object.prototype.hasOwnProperty.call(arg, 'default');
    const defaultValue = hasDefault
      ? canonicalJsonValue(arg.default, argContext, 'default', new Set())
      : 'missing';

    const hasChoices = Object.prototype.hasOwnProperty.call(arg, 'choices');
    let choices = 'missing';
    if (hasChoices) {
      if (!Array.isArray(arg.choices)) fail(argContext, 'choices', 'must be an array of strings when present');
      choices = `array:[${arg.choices.map((choice, choiceIndex) => {
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
