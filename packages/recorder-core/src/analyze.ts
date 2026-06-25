/**
 * Pure site-analysis (extracted from src/browser/analyze.ts for M5a).
 *
 * Classifies a site from already-collected PageSignals: anti-bot vendor, request
 * pattern (A/B/C/D/E), nearest existing adapter, recommended next step. NO IO — it
 * never drives a browser; the caller collects PageSignals (CLI via its Page,
 * dashboard-be via daemon /command). Same pure-domain split as rank (M4).
 *
 * The registry param uses a structural AdapterRef so this package stays free of
 * the main-repo CliCommand type; CliCommand is assignable to AdapterRef.
 */

// ── Collected signals ──────────────────────────────────────────────────────

export interface PageSignals {
  requestedUrl: string;
  finalUrl: string;
  cookieNames: string[];
  networkEntries: Array<{
    url: string;
    status: number;
    contentType: string;
    bodyPreview: string | null;
  }>;
  initialState: {
    __INITIAL_STATE__: boolean;
    __NUXT__: boolean;
    __NEXT_DATA__: boolean;
    __APOLLO_STATE__: boolean;
  };
  title: string;
}

/** Minimal adapter registry entry (structural; main-repo CliCommand is assignable). */
export interface AdapterRef {
  site: string;
  name: string;
  domain?: string;
}

// ── Anti-bot detection ──────────────────────────────────────────────────────

export type AntiBotVendor = 'aliyun_waf' | 'cloudflare' | 'akamai' | 'geetest' | 'unknown';

export interface AntiBotVerdict {
  detected: boolean;
  vendor: AntiBotVendor | null;
  evidence: string[];
  implication: string;
}

const WAF_SIGNATURES: Array<{
  vendor: Exclude<AntiBotVendor, 'unknown'>;
  cookiePatterns: RegExp[];
  bodyPatterns: RegExp[];
  implication: string;
}> = [
  {
    vendor: 'aliyun_waf',
    cookiePatterns: [/^acw_sc__v2$/, /^acw_tc$/, /^ssxmod_itna/],
    bodyPatterns: [/arg1\s*=\s*['"][0-9A-F]{30,}/, /\/ntc_captcha\//i],
    implication: 'Direct Node-side fetch/curl will return the slider HTML. Validate the endpoint in browser context first; HTML COOKIE adapters still finish with Node-side fetch + page.getCookies.',
  },
  {
    vendor: 'cloudflare',
    cookiePatterns: [/^__cf_bm$/, /^cf_clearance$/, /^__cfduid$/],
    bodyPatterns: [/Cloudflare Ray ID/i, /Checking your browser before accessing/i, /cf-chl-/i],
    implication: 'Cloudflare bot check. Start from a real browser session; probe in browser context first. HTML COOKIE adapters still finish with Node-side fetch + page.getCookies.',
  },
  {
    vendor: 'akamai',
    cookiePatterns: [/^_abck$/, /^bm_sz$/, /^bm_sv$/],
    bodyPatterns: [/akamai/i],
    implication: 'Akamai Bot Manager. Probe in browser context first; keep final HTML COOKIE adapters on Node-side fetch + page.getCookies.',
  },
  {
    vendor: 'geetest',
    cookiePatterns: [],
    bodyPatterns: [/geetest/i, /gt_captcha/i],
    implication: 'Geetest slider/puzzle captcha. Agent cannot bypass programmatically — requires UI strategy or human-in-loop.',
  },
];

export function detectAntiBot(signals: PageSignals): AntiBotVerdict {
  const evidence: string[] = [];
  let match: typeof WAF_SIGNATURES[number] | null = null;

  for (const sig of WAF_SIGNATURES) {
    const hits: string[] = [];
    for (const pat of sig.cookiePatterns) {
      const hit = signals.cookieNames.find((c) => pat.test(c));
      if (hit) hits.push(`cookie:${hit}`);
    }
    for (const pat of sig.bodyPatterns) {
      for (const entry of signals.networkEntries) {
        if (entry.bodyPreview && pat.test(entry.bodyPreview)) {
          hits.push(`body:${entry.url}`);
          break;
        }
      }
    }
    if (hits.length > 0 && !match) {
      match = sig;
      evidence.push(...hits);
    }
  }

  if (!match) {
    return {
      detected: false,
      vendor: null,
      evidence: [],
      implication: 'No known anti-bot signatures. Try Node-side COOKIE fetch first; if endpoint validation is blocked, retry from browser context.',
    };
  }
  return { detected: true, vendor: match.vendor, evidence, implication: match.implication };
}

// ── Pattern classification ──────────────────────────────────────────────────

export type Pattern = 'A' | 'B' | 'C' | 'D' | 'E' | 'unknown';

export interface PatternVerdict {
  pattern: Pattern;
  reason: string;
  json_responses: number;
  auth_failures: number;
}

export function classifyPattern(signals: PageSignals): PatternVerdict {
  const jsonEntries = signals.networkEntries.filter((e) => /json/i.test(e.contentType));
  const authFailures = signals.networkEntries.filter((e) => e.status === 401 || e.status === 403).length;
  const hasInitialState =
    signals.initialState.__INITIAL_STATE__ || signals.initialState.__NUXT__ ||
    signals.initialState.__NEXT_DATA__ || signals.initialState.__APOLLO_STATE__;

  if (authFailures >= 2 && jsonEntries.length >= 1) {
    return { pattern: 'D', reason: `${authFailures} auth-failing API responses seen — endpoint is token-gated`, json_responses: jsonEntries.length, auth_failures: authFailures };
  }
  if (hasInitialState) {
    const which = Object.entries(signals.initialState).filter(([, v]) => v).map(([k]) => k);
    return { pattern: 'B', reason: `SSR state global present: ${which.join(', ')}`, json_responses: jsonEntries.length, auth_failures: authFailures };
  }
  if (jsonEntries.length >= 1) {
    return { pattern: 'A', reason: `${jsonEntries.length} JSON XHR/fetch responses observed — classic API pattern`, json_responses: jsonEntries.length, auth_failures: authFailures };
  }
  return { pattern: 'C', reason: 'No JSON XHR and no SSR state — HTML scrape (Pattern C); escalate to E manually if WebSocket traffic appears', json_responses: jsonEntries.length, auth_failures: authFailures };
}

// ── Nearest-adapter lookup ──────────────────────────────────────────────────

export interface NearestAdapter {
  site: string;
  example_commands: string[];
  reason: string;
}

export function findNearestAdapter(finalUrl: string, registry: Map<string, AdapterRef>): NearestAdapter | null {
  let host: string;
  try { host = new URL(finalUrl).hostname; } catch { return null; }
  const cleanedHost = host.replace(/^www\./, '');
  const parts = cleanedHost.split('.');
  const apex = parts.slice(-2).join('.');
  const siteKey = parts.length > 1 ? parts[parts.length - 2] : cleanedHost;

  const hits = new Map<string, AdapterRef[]>();
  for (const cmd of registry.values()) {
    const domain = cmd.domain?.toLowerCase();
    const siteMatches =
      (domain && (cleanedHost.endsWith(domain) || domain.endsWith(apex))) ||
      cmd.site.toLowerCase() === siteKey?.toLowerCase() ||
      cleanedHost.includes(cmd.site.toLowerCase());
    if (siteMatches) {
      const list = hits.get(cmd.site) ?? [];
      list.push(cmd);
      hits.set(cmd.site, list);
    }
  }
  if (hits.size === 0) return null;

  let best: [string, AdapterRef[]] | null = null;
  for (const entry of hits) {
    if (!best || entry[1].length > best[1].length) best = entry;
  }
  if (!best) return null;

  return {
    site: best[0],
    example_commands: best[1].slice(0, 5).map((c) => `${c.site} ${c.name}`),
    reason: `${best[1].length} existing adapter${best[1].length === 1 ? '' : 's'} target this site — reuse strategy/cookie config`,
  };
}

// ── Top-level assembly ──────────────────────────────────────────────────────

export interface AnalyzeReport {
  requested_url: string;
  final_url: string;
  title: string;
  pattern: PatternVerdict;
  anti_bot: AntiBotVerdict;
  initial_state: PageSignals['initialState'];
  nearest_adapter: NearestAdapter | null;
  recommended_next_step: string;
}

export function analyzeSite(signals: PageSignals, registry: Map<string, AdapterRef>): AnalyzeReport {
  const pattern = classifyPattern(signals);
  const antiBot = detectAntiBot(signals);
  const nearest = findNearestAdapter(signals.finalUrl, registry);

  let next: string;
  if (antiBot.detected) next = antiBot.implication;
  else if (pattern.pattern === 'A') next = 'Pick the most specific JSON endpoint from `bycli browser network` and try a bare Node fetch with cookies; escalate to browser-context fetch only if blocked.';
  else if (pattern.pattern === 'B') next = 'Read the SSR global via `bycli browser eval "JSON.stringify(window.__INITIAL_STATE__ ?? window.__NUXT__ ?? window.__NEXT_DATA__ ?? window.__APOLLO_STATE__)"` — no API needed.';
  else if (pattern.pattern === 'C') next = 'No API visible — use SSR HTML scrape (e.g. `bycli browser extract`) against the rendered page.';
  else if (pattern.pattern === 'D') next = 'Endpoints need auth. Re-open the page from a signed-in session, then retry analyze; see `field-decode-playbook` §4 for token tracing.';
  else if (pattern.pattern === 'E') next = 'WebSocket stream detected — find the underlying HTTP poll/long-poll endpoint; raw WS is not supported.';
  else next = 'No strong signal. Manually inspect `bycli browser network --all` and pick a pattern.';

  return {
    requested_url: signals.requestedUrl,
    final_url: signals.finalUrl,
    title: signals.title,
    pattern,
    anti_bot: antiBot,
    initial_state: signals.initialState,
    nearest_adapter: nearest,
    recommended_next_step: next,
  };
}
