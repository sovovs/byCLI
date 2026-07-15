import { describe, expect, it } from 'vitest';
import {
  Strategy,
  type BrowserCliCommand,
  type CliCommand,
  type ConditionalBrowserCliCommand,
  type NonBrowserCliCommand,
} from './registry.js';
import { BROWSER_ONLY_STEPS, _validateBrowserOnlyStepsAgainstRegistry, shouldUseBrowserSession } from './capabilityRouting.js';
import { getRegisteredStepNames } from './pipeline/registry.js';

function makeCmd(partial: Partial<CliCommand> & { browser: true }): BrowserCliCommand;
function makeCmd(partial: Partial<CliCommand> & { browser: false }): NonBrowserCliCommand;
function makeCmd(partial: Partial<CliCommand> & { browser: 'conditional' }): ConditionalBrowserCliCommand;
function makeCmd(partial: Partial<CliCommand>): CliCommand {
  return {
    site: 'test',
    name: 'command', access: 'read',
    description: '',
    args: [],
    ...partial,
  } as CliCommand;
}

describe('shouldUseBrowserSession', () => {
  it('uses the already-resolved browser requirement for conditional commands', () => {
    const cmd = makeCmd({
      browser: 'conditional',
      requiresBrowser: () => true,
      strategy: Strategy.COOKIE,
      func: async () => [],
    });

    expect(shouldUseBrowserSession(cmd, false)).toBe(false);
    expect(shouldUseBrowserSession(cmd, true)).toBe(true);
  });

  it('rejects an unresolved conditional command when the API is bypassed', () => {
    const cmd = makeCmd({
      browser: 'conditional',
      requiresBrowser: () => false,
      strategy: Strategy.COOKIE,
      func: async () => [],
    });

    // @ts-expect-error conditional commands require an explicit resolved browser result
    expect(() => shouldUseBrowserSession(cmd)).toThrow(/must be resolved/i);
  });

  it('keeps one-argument routing available for static commands', () => {
    const browser = makeCmd({ browser: true, func: async () => [] });
    const noBrowser = makeCmd({ browser: false, func: async () => [] });

    expect(shouldUseBrowserSession(browser)).toBe(true);
    expect(shouldUseBrowserSession(noBrowser)).toBe(false);
  });

  it('skips browser session for public fetch-only pipelines', () => {
    expect(shouldUseBrowserSession(makeCmd({
      browser: true,
      strategy: Strategy.PUBLIC,
      pipeline: [{ fetch: 'https://example.com/api' }, { select: 'items' }],
    }))).toBe(false);
  });

  it('keeps browser session for public pipelines with browser-only steps', () => {
    expect(shouldUseBrowserSession(makeCmd({
      browser: true,
      strategy: Strategy.PUBLIC,
      pipeline: [{ navigate: 'https://example.com' }, { evaluate: '() => []' }],
    }))).toBe(true);
  });

  it('keeps browser session for non-public strategies (via normalized navigateBefore)', () => {
    // After normalizeCommand, COOKIE strategy without domain sets navigateBefore: true
    // (signals "needs authenticated browser context" without a specific pre-nav URL).
    expect(shouldUseBrowserSession(makeCmd({
      browser: true,
      strategy: Strategy.COOKIE,
      navigateBefore: true,
      pipeline: [{ fetch: 'https://example.com/api' }],
    }))).toBe(true);
  });

  it('keeps browser session for function adapters', () => {
    expect(shouldUseBrowserSession(makeCmd({
      browser: true,
      strategy: Strategy.PUBLIC,
      func: async () => [],
    }))).toBe(true);
  });

  it('routes pipelines containing the fill step into a browser session', () => {
    expect(shouldUseBrowserSession(makeCmd({
      browser: true,
      strategy: Strategy.PUBLIC,
      pipeline: [{ navigate: 'https://example.com' }, { fill: { ref: '#q', text: 'hello' } }],
    }))).toBe(true);
  });
});

describe('BROWSER_ONLY_STEPS / pipeline registry alignment', () => {
  it('is a subset of registered pipeline step names', () => {
    const { extras } = _validateBrowserOnlyStepsAgainstRegistry();
    expect(extras).toEqual([]);
  });

  it('includes fill (DOM-touching step added in PR #1222)', () => {
    expect(BROWSER_ONLY_STEPS.has('fill')).toBe(true);
    expect(getRegisteredStepNames()).toContain('fill');
  });
});
