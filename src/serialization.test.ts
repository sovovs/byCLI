import { describe, expect, it } from 'vitest';
import type { CliCommand } from './registry.js';
import { cli, Strategy } from './registry.js';
import { formatCommandExample, formatRegistryHelpText, serializeCommand } from './serialization.js';

describe('formatRegistryHelpText', () => {
  it('preserves conditional browser metadata without serializing its resolver', () => {
    const requiresBrowser = (args: Record<string, unknown>) => args['auth-source'] !== 'env';
    const cmd = cli({
      site: 'wechat',
      name: 'search',
      access: 'read',
      strategy: Strategy.INTERCEPT,
      browser: requiresBrowser,
      args: [],
      func: async () => [],
    });

    expect(serializeCommand(cmd)).toMatchObject({ browser: 'conditional' });
    expect(serializeCommand(cmd)).not.toHaveProperty('requiresBrowser');
    expect(formatRegistryHelpText(cmd)).toContain('Browser: conditional');
  });

  it('keeps static browser metadata as booleans', () => {
    const browserCmd = cli({ site: 'static', name: 'on', access: 'read', browser: true, args: [], func: async () => [] });
    const noBrowserCmd = cli({ site: 'static', name: 'off', access: 'read', browser: false, args: [], func: async () => [] });

    expect(serializeCommand(browserCmd)).toMatchObject({ browser: true });
    expect(serializeCommand(noBrowserCmd)).toMatchObject({ browser: false });
  });

  it('summarizes long choices lists so help text stays readable', () => {
    const cmd: CliCommand = {
      site: 'demo',
      name: 'dynamic', access: 'read',
      description: 'Demo command',
      strategy: Strategy.PUBLIC,
      browser: false,
      args: [
        {
          name: 'field',
          help: 'Field to use',
          choices: ['all-fields', 'topic', 'title', 'author', 'publication-titles', 'year-published', 'doi'],
        },
      ],
      columns: ['field'],
    };

    expect(formatRegistryHelpText(cmd)).toContain('--field: all-fields, topic, title, author, ... (+3 more)');
  });

  it('includes aliases in structured serialization and help text', () => {
    const cmd: CliCommand = {
      site: 'demo',
      name: 'get',
      access: 'read',
      aliases: ['metadata'],
      description: 'Demo command',
      strategy: Strategy.COOKIE,
      browser: true,
      args: [],
    };

    expect(serializeCommand(cmd)).toMatchObject({
      command: 'demo/get',
      access: 'read',
      aliases: ['metadata'],
    });
    expect(formatRegistryHelpText(cmd)).toContain('Aliases: metadata');
  });

  it('surfaces access and canonical examples instead of strategy as primary help metadata', () => {
    const cmd: CliCommand = {
      site: 'bilibili',
      name: 'hot',
      access: 'read',
      description: 'Bilibili hot videos',
      strategy: Strategy.COOKIE,
      browser: true,
      args: [],
    };

    expect(formatCommandExample(cmd)).toBe('bycli bilibili hot -f yaml');
    expect(serializeCommand(cmd)).toMatchObject({
      command: 'bilibili/hot',
      access: 'read',
      example: 'bycli bilibili hot -f yaml',
    });
    expect(formatRegistryHelpText(cmd)).toContain('Access: read');
    expect(formatRegistryHelpText(cmd)).toContain('Example: bycli bilibili hot -f yaml');
    expect(formatRegistryHelpText(cmd)).not.toContain('Strategy:');
  });

  it('surfaces command default output format in structured serialization and help text', () => {
    const cmd: CliCommand = {
      site: 'gemini',
      name: 'ask',
      access: 'read',
      description: 'Ask Gemini',
      strategy: Strategy.COOKIE,
      browser: true,
      args: [],
      defaultFormat: 'plain',
    };

    expect(serializeCommand(cmd)).toMatchObject({
      command: 'gemini/ask',
      defaultFormat: 'plain',
    });
    expect(formatRegistryHelpText(cmd)).toContain('Default format: plain');
  });
});
