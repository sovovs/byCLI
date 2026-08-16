import { describe, expect, it } from 'vitest';
import {
  ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError,
} from '@sovovs/bycli/errors';
import {
  combineArticleFallbackErrors,
  isEligibleArticleFallbackError,
  withMissingFallbackName,
} from './article-fallback-policy.js';

describe('Weixin article fallback policy', () => {
  it('allows only command and empty primary errors to enter fallback', () => {
    expect(isEligibleArticleFallbackError(new CommandExecutionError('rate limited'))).toBe(true);
    expect(isEligibleArticleFallbackError(new EmptyResultError('primary'))).toBe(true);
    expect(isEligibleArticleFallbackError(new AuthRequiredError('mp.weixin.qq.com'))).toBe(false);
    expect(isEligibleArticleFallbackError(new ArgumentError('bad input'))).toBe(false);
    expect(isEligibleArticleFallbackError(new Error('unknown'))).toBe(false);
  });

  it.each([
    [new EmptyResultError('primary', 'Primary scan was empty.'), 'EMPTY_RESULT'],
    [new CommandExecutionError('Primary failed', 'Wait before retrying.'), 'COMMAND_EXEC'],
  ])('preserves the primary terminal type when fallback needs --name', (primaryError, code) => {
    const result = withMissingFallbackName('weixin articles', primaryError);

    expect(result).toMatchObject({ code });
    expect(result.hint).toContain('exact official-account name in --name');
    expect(result.hint).toContain(primaryError.hint);
  });

  it('keeps two empty phases as EMPTY_RESULT with sanitized bounded context', () => {
    const result = combineArticleFallbackErrors({
      operation: 'weixin articles',
      primaryError: new EmptyResultError('primary', 'No primary rows for secret-token.'),
      fallbackError: new EmptyResultError(
        'fallback',
        'Scanned 2 pages for sid=secret-cookie and reached the page cap.',
      ),
      credentials: { token: 'secret-token', cookie: 'sid=secret-cookie' },
    });

    expect(result).toMatchObject({ code: 'EMPTY_RESULT' });
    expect(result.hint).toContain('Primary (EMPTY_RESULT)');
    expect(result.hint).toContain('No primary rows');
    expect(result.hint).toContain('fallback (EMPTY_RESULT)');
    expect(result.hint).toContain('Scanned 2 pages');
    expect(result.hint).not.toMatch(/secret-token|secret-cookie/);
  });

  it('combines mixed operational failures as COMMAND_EXEC', () => {
    const result = combineArticleFallbackErrors({
      operation: 'weixin save-articles',
      primaryError: new CommandExecutionError('Primary rate limited', 'Wait before retrying.'),
      fallbackError: new EmptyResultError('fallback', 'Sogou search exhausted after 2 pages.'),
      credentials: { token: 't', cookie: 'c' },
    });

    expect(result).toMatchObject({ code: 'COMMAND_EXEC' });
    expect(result.hint).toContain('Primary rate limited');
    expect(result.hint).toContain('Wait before retrying');
    expect(result.hint).toContain('Sogou search exhausted after 2 pages');
  });

  it('passes through a fallback authentication gate unchanged', () => {
    const fallbackError = new AuthRequiredError('weixin.sogou.com', 'Complete verification.');
    const result = combineArticleFallbackErrors({
      operation: 'weixin articles',
      primaryError: new EmptyResultError('primary'),
      fallbackError,
      credentials: { token: 't', cookie: 'c' },
    });

    expect(result).toBe(fallbackError);
  });
});
