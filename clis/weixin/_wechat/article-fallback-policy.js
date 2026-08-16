import {
  AuthRequiredError, CommandExecutionError, EmptyResultError,
} from '@sovovs/bycli/errors';
import { buildSecretSet, redactText } from './redact.js';

function safePhase(error, secrets) {
  const message = error instanceof Error ? error.message : String(error);
  const hint = error && typeof error === 'object' && typeof error.hint === 'string'
    ? error.hint : '';
  const summary = hint ? `${message} (${hint})` : message;
  return {
    code: error && typeof error === 'object' && typeof error.code === 'string'
      ? error.code : 'UNKNOWN',
    summary: redactText(summary, secrets),
  };
}

export function isEligibleArticleFallbackError(error) {
  return error instanceof CommandExecutionError || error instanceof EmptyResultError;
}

export function withMissingFallbackName(operation, error) {
  const hint = `${error.hint ? `${error.hint} ` : ''}Sogou fallback requires the exact official-account name in --name.`;
  if (error instanceof EmptyResultError) return new EmptyResultError(operation, hint);
  return new CommandExecutionError(error.message, hint);
}

export function combineArticleFallbackErrors({
  operation,
  primaryError,
  fallbackError,
  credentials,
}) {
  if (fallbackError instanceof AuthRequiredError) return fallbackError;
  const secrets = buildSecretSet(credentials);
  const primary = safePhase(primaryError, secrets);
  const fallback = safePhase(fallbackError, secrets);
  const hint = `Primary (${primary.code}): ${primary.summary}; fallback (${fallback.code}): ${fallback.summary}`;
  if (primaryError instanceof EmptyResultError && fallbackError instanceof EmptyResultError) {
    return new EmptyResultError(operation, hint);
  }
  return new CommandExecutionError(
    'Weixin article index and Sogou fallback both failed',
    hint,
  );
}
