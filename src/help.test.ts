import { describe, it, expect } from 'vitest';
import {
  classifyAdapter,
  commandHelpData,
  formatCommandHelpText,
  formatRootAdapterHelpText,
  formatSiteHelpText,
  siteHelpData,
} from './help.js';
import { cli, Strategy } from './registry.js';

const conditional = cli({
  site: 'wechat',
  name: 'search',
  access: 'read',
  strategy: Strategy.INTERCEPT,
  browser: args => args['auth-source'] !== 'env',
  args: [],
  func: async () => [],
});

describe('conditional browser help metadata', () => {
  it('exposes named adapter session capability only for opted-in commands', () => {
    const isolated = cli({
      site: 'wechat',
      name: 'download',
      access: 'read',
      strategy: Strategy.INTERCEPT,
      adapterConcurrency: { isolatedTabs: true, maxParallel: 3 },
      args: [],
      func: async () => [],
    });

    expect(commandHelpData(isolated)).toMatchObject({
      adapterConcurrency: { isolatedTabs: true, maxParallel: 3 },
      adapter_common_options: expect.arrayContaining([
        expect.objectContaining({ name: 'adapter-session' }),
        expect.objectContaining({ name: 'adapter-queue-timeout', default: 300 }),
      ]),
    });
    expect(commandHelpData(conditional)).not.toHaveProperty('adapterConcurrency');
    expect(commandHelpData(conditional)).not.toHaveProperty('adapter_common_options');
    expect(formatCommandHelpText(isolated)).toContain('Adapter session options:');
    expect(formatCommandHelpText(isolated)).toContain('--adapter-session <name>');
  });

  it('preserves the conditional state in command and site structured help', () => {
    expect(commandHelpData(conditional)).toMatchObject({ browser: 'conditional' });
    expect(commandHelpData(conditional)).not.toHaveProperty('requiresBrowser');
    expect(siteHelpData('wechat', [conditional])).toMatchObject({
      commands: [expect.objectContaining({ browser: 'conditional' })],
    });
    expect(JSON.stringify(siteHelpData('wechat', [conditional]))).not.toContain('requiresBrowser');
  });

  it('shows browser common options for conditional commands in structured and text help', () => {
    expect(commandHelpData(conditional)).toHaveProperty('browser_common_options');
    expect(siteHelpData('wechat', [conditional])).toHaveProperty('browser_common_options');
    expect(formatCommandHelpText(conditional)).toContain('Browser common options:');
    expect(formatCommandHelpText(conditional)).toContain('Browser: conditional');
    expect(formatSiteHelpText('wechat', [conditional])).toContain('Browser common options:');
  });

  it('keeps static no-browser commands free of browser common options', () => {
    const local = cli({ site: 'local', name: 'read', access: 'read', browser: false, args: [], func: async () => [] });

    expect(commandHelpData(local)).toMatchObject({ browser: false });
    expect(commandHelpData(local)).not.toHaveProperty('browser_common_options');
    expect(formatCommandHelpText(local)).toContain('Browser: no');
  });
});

describe('classifyAdapter', () => {
  it('classifies DNS-style domains as site', () => {
    expect(classifyAdapter('www.bilibili.com')).toBe('site');
    expect(classifyAdapter('chatgpt.com')).toBe('site');
    expect(classifyAdapter('claude.ai')).toBe('site');
    expect(classifyAdapter('grok.com')).toBe('site');
  });

  it('classifies localhost as app (Electron / osascript desktop integrations)', () => {
    expect(classifyAdapter('localhost')).toBe('app');
  });

  it('classifies non-DNS domain strings as app (e.g. literal "doubao-app")', () => {
    expect(classifyAdapter('doubao-app')).toBe('app');
  });

  it('defaults missing domain to site (most adapters without explicit domain are public web scrapers)', () => {
    expect(classifyAdapter(undefined)).toBe('site');
  });
});

describe('formatRootAdapterHelpText', () => {
  it('renders all three sections in External / App / Site order when populated', () => {
    const text = formatRootAdapterHelpText({
      external: [
        { name: 'gh', label: 'gh' },
        { name: 'wx', label: 'wx(wx-cli)' },
      ],
      apps: ['chatwise', 'codex'],
      sites: ['bilibili'],
    });
    expect(text).toContain('External CLIs (2):');
    expect(text).toContain('App adapters (2):');
    expect(text).toContain('Site adapters (1):');
    expect(text).toContain('wx(wx-cli)');
    expect(text.indexOf('External CLIs')).toBeLessThan(text.indexOf('App adapters'));
    expect(text.indexOf('App adapters')).toBeLessThan(text.indexOf('Site adapters'));
  });

  it('omits empty sections instead of rendering a (0) header', () => {
    const text = formatRootAdapterHelpText({
      external: [],
      apps: [],
      sites: ['bilibili'],
    });
    expect(text).not.toContain('External CLIs');
    expect(text).not.toContain('App adapters');
    expect(text).toContain('Site adapters (1):');
  });

  it('returns empty string when all groups are empty', () => {
    expect(formatRootAdapterHelpText({ external: [], apps: [], sites: [] })).toBe('');
  });

  it('always renders the agent discovery hint when any section is populated', () => {
    const text = formatRootAdapterHelpText({
      external: [],
      apps: [],
      sites: ['bilibili'],
    });
    expect(text).toContain("'bycli <site> --help -f yaml'");
  });
});
