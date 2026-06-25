/**
 * High-Level analyze module (M5a, 07-high-level-services.md · analyzeBrowser).
 *
 * Module-first (ADR-0004): drives the Page abstraction through the multi-step
 * site probe (goto / wait / network capture / window-global probe / cookies) to
 * assemble PageSignals, then calls the PURE analyzeSite() classifier. In-process
 * async, no child process (07:50). Hosted by the main-repo daemon high-level
 * surface (Codex A' verdict); dashboard-be only forwards.
 *
 * Timeout surfaces as `analyze_timeout` (07:52), never a runner error.
 */

import type { IPage } from '../../types.js';
import { analyzeSite, type AdapterRef, type PageSignals, type AnalyzeReport } from '../../browser/analyze.js';
import { generateInterceptorJs } from '../../interceptor.js';

export interface AnalyzeInput {
  url: string;
  /** site-level settle window after load (ms); default 2000 (07 input). */
  settleMs?: number;
}

export class AnalyzeTimeoutError extends Error {
  readonly code = 'analyze_timeout';
  constructor(ms: number) {
    super(`analyze timed out after ${ms}ms`);
    this.name = 'AnalyzeTimeoutError';
  }
}

const DEFAULT_SETTLE_MS = 2000;

/** Window-global + cookie + finalUrl probe (mirrors the CLI analyze probe). */
const PROBE_JS = `(function(){
  return {
    cookieNames: (document.cookie || '').split(';').map(function(c){ return c.trim().split('=')[0]; }).filter(Boolean),
    initialState: {
      __INITIAL_STATE__: typeof window.__INITIAL_STATE__ !== 'undefined',
      __NUXT__: typeof window.__NUXT__ !== 'undefined',
      __NEXT_DATA__: typeof window.__NEXT_DATA__ !== 'undefined',
      __APOLLO_STATE__: typeof window.__APOLLO_STATE__ !== 'undefined',
    },
    title: document.title || '',
    finalUrl: location.href,
  };
})()`;

interface RawNetItem { url?: string; status?: number; ct?: string; body?: unknown; }

/**
 * Collect PageSignals by driving the page, then classify with the pure analyzeSite.
 * `registry` is the adapter registry used for nearest-adapter matching.
 */
export async function analyzeBrowser(
  page: IPage,
  registry: Map<string, AdapterRef>,
  input: AnalyzeInput,
): Promise<AnalyzeReport> {
  const settleMs = input.settleMs ?? DEFAULT_SETTLE_MS;

  // Prefer the session-level CDP network capture; fall back to an injected interceptor.
  const hasSessionCapture = (await page.startNetworkCapture?.()) ?? false;
  await page.goto(input.url);
  await page.wait(Math.max(1, Math.round(settleMs / 1000)));
  if (!hasSessionCapture) {
    // match-all: analyze wants every json/text response, not a filtered subset.
    try { await page.evaluate(generateInterceptorJs('true')); } catch { /* non-fatal */ }
  }
  await page.wait(1);

  const rawItems = ((await page.readNetworkCapture?.()) ?? []) as RawNetItem[];
  const networkEntries = rawItems.map((e) => ({
    url: e.url ?? '',
    status: e.status ?? 0,
    contentType: e.ct ?? '',
    bodyPreview: typeof e.body === 'string'
      ? e.body.slice(0, 2000)
      : (e.body ? JSON.stringify(e.body).slice(0, 2000) : null),
  }));

  const probe = await page.evaluate(PROBE_JS) as {
    cookieNames: string[];
    initialState: PageSignals['initialState'];
    title: string;
    finalUrl: string;
  };
  const browserCookieNames = (await page.getCookies({ url: probe.finalUrl || input.url }).catch(() => []))
    .map((c) => c.name)
    .filter(Boolean);
  const cookieNames = [...new Set([...probe.cookieNames, ...browserCookieNames])];

  const signals: PageSignals = {
    requestedUrl: input.url,
    finalUrl: probe.finalUrl,
    cookieNames,
    networkEntries,
    initialState: probe.initialState,
    title: probe.title,
  };
  return analyzeSite(signals, registry);
}

/** Wrap analyzeBrowser with a deadline → AnalyzeTimeoutError (07:52 analyze_timeout). */
export async function analyzeBrowserWithTimeout(
  page: IPage,
  registry: Map<string, AdapterRef>,
  input: AnalyzeInput,
  timeoutMs: number,
): Promise<AnalyzeReport> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AnalyzeTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([analyzeBrowser(page, registry, input), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
