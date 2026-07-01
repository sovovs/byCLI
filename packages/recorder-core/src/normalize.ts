/**
 * Normalize — rank-internal engine phase (06-recorder-core-engine.md · "Normalize").
 *
 * Turns a canonical RecorderNetworkEntry into the normalized signals the ranker needs:
 *   - EndpointDescriptor (urlTemplate/queryParams/dynamicParams/excludedParams/authRequired)
 *   - ArgMapping[] candidates (from body/query param candidates)
 *   - ResponseShape + signals (authRequired, antiBotSignal, echoesSeedArg)
 *
 * headerShape / bodyParamCandidates / antiBotSignal are rank-internal signals, NOT
 * standalone candidate fields (06): they feed scoreExplanation/risks/authRequired and
 * ArgMapping construction.
 */

import type {
  RecorderNetworkEntry, EndpointDescriptor, ResponseShape, ArgMapping, ArgIn,
} from './types.js';

// Dynamic/cache-buster param names to exclude from a stable endpoint (06).
// Exported so the endpoint-aggregation layer (aggregate.ts) can flag observed params
// dynamicLike/cursorLike WITHOUT duplicating the patterns (single source of truth).
export const DYNAMIC_PARAM_RE = /^(_t|_|ts|time|timestamp|nonce|uuid|sign|signature|csrf|token|callback|cb|rand|random)$/i;
export const CURSOR_PARAM_RE = /^(cursor|next|next_cursor|page_token|offset|after|before)$/i;

// Refinement of the dynamicLike umbrella (14-plan · scoring recalibration). These split
// the SUB-KIND of a dynamic param as a deterministic name-pattern FACT — recorder-core
// never applies a penalty (that is be's scorer's job in a later step):
//   - SIGNED_PARAM_RE   → signature/auth/anti-bot params (sign/nonce/csrf/token/w_rid/x-bogus…).
//   - CACHE_BUSTER_PARAM_RE → cache-buster params (_t/ts/timestamp/cb/rand…).
// Both are anchored whole-name + case-insensitive, exactly like DYNAMIC_PARAM_RE. The two
// sets do NOT overlap by design; if a name ever matched both, signedLike wins (higher-signal,
// more conservative) — enforced in aggregate.ts, not here. A dynamicLike param matching
// NEITHER (e.g. uuid/web_id/device_id/trace_id) is the "unknown dynamic" class (both false).
export const SIGNED_PARAM_RE = /^(sign|signature|sig|hmac|hash|nonce|csrf|token|access_token|_signature|w_rid|x_bogus|x-bogus|verify|challenge)$/i;
export const CACHE_BUSTER_PARAM_RE = /^(_t|_|t|ts|time|timestamp|cb|callback|rand|random|r)$/i;

export interface NormalizedEntry {
  endpoint: EndpointDescriptor;
  responseShape: ResponseShape;
  /** seed→param candidates, later turned into ArgMapping[] when seed evidence matches. */
  paramCandidates: Array<{ name: string; in: ArgIn }>;
  signals: {
    authRequired: boolean;
    antiBotSignal: boolean;
    /** dynamic fields detected (timestamp/nonce/sign/...) → -delta + excluded. */
    hasDynamicFields: boolean;
    /** cursor/pagination params, kept separate from search args (06 cursor-pagination). */
    cursorParams: string[];
    /** suspected static/html (weak, -25) vs confirmed (hard reject) — see score.ts. */
    suspectedStatic: boolean;
    requiresSession: boolean;
  };
}

function isAuthStatus(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 302;
}

export function normalizeEntry(entry: RecorderNetworkEntry): NormalizedEntry {
  const queryKeys = entry.queryParams ? Object.keys(entry.queryParams) : [];
  const dynamicParams: string[] = [];
  const cursorParams: string[] = [];
  const stableQuery: Record<string, unknown> = {};

  for (const k of queryKeys) {
    if (DYNAMIC_PARAM_RE.test(k)) { dynamicParams.push(k); continue; }
    if (CURSOR_PARAM_RE.test(k)) { cursorParams.push(k); continue; }
    stableQuery[k] = entry.queryParams![k];
  }

  // urlTemplate: host+pathname with stable query keys as placeholders.
  const stableKeys = Object.keys(stableQuery).sort();
  const queryTemplate = stableKeys.length ? '?' + stableKeys.map((k) => `${k}={${k}}`).join('&') : '';
  const urlTemplate = `${entry.host ?? ''}${entry.pathname ?? ''}${queryTemplate}`;

  const requiresSession = !!entry.authSignals && Object.keys(entry.authSignals).length > 0;
  const authRequired = requiresSession || isAuthStatus(entry.response?.status);

  const endpoint: EndpointDescriptor = {
    method: entry.method,
    urlTemplate,
    host: entry.host ?? '',
    pathname: entry.pathname ?? '',
  };
  if (Object.keys(stableQuery).length) endpoint.queryParams = stableQuery;
  if (dynamicParams.length || cursorParams.length) endpoint.excludedParams = [...dynamicParams, ...cursorParams];
  if (dynamicParams.length) endpoint.dynamicParams = dynamicParams;
  if (entry.requestBodyShape) endpoint.requestBodyShape = entry.requestBodyShape;
  if (authRequired) endpoint.authRequired = true;

  // param candidates: stable query keys + request body keys.
  const paramCandidates: Array<{ name: string; in: ArgIn }> = [
    ...stableKeys.map((name) => ({ name, in: 'query' as ArgIn })),
    ...(entry.requestBodyShape?.keys ?? []).map((name) => ({ name, in: 'body' as ArgIn })),
  ];

  const bs = entry.response?.bodyShape;
  const responseShape: ResponseShape = {};
  if (bs?.kind) responseShape.kind = bs.kind;
  if (bs?.itemKeys?.length) responseShape.itemKeys = bs.itemKeys;
  if (entry.response?.shapeConfidence !== undefined) responseShape.shapeConfidence = entry.response.shapeConfidence;

  const mime = entry.response?.mime ?? '';
  // suspected static/html: html shape or static-looking path, NOT confirmed analytics.
  const suspectedStatic = bs?.kind === 'html' || /\.(js|css|png|jpg|svg|woff2?|ico)(\?|$)/i.test(entry.pathname ?? '');
  const antiBotSignal = isAuthStatus(entry.response?.status) || /captcha|challenge|verify/i.test(entry.pathname ?? '');

  return {
    endpoint,
    responseShape,
    paramCandidates,
    signals: {
      authRequired,
      antiBotSignal,
      hasDynamicFields: dynamicParams.length > 0,
      cursorParams,
      suspectedStatic: suspectedStatic && mime.includes('html') ? true : suspectedStatic,
      requiresSession,
    },
  };
}

/** Build ArgMapping[] by matching seed-arg evidence placeholders against param candidates. */
export function buildArgMappings(
  paramCandidates: Array<{ name: string; in: ArgIn }>,
  seedArgsEvidence: Record<string, { placeholder?: string; type?: string }> | undefined,
): ArgMapping[] {
  if (!seedArgsEvidence) return [];
  const mappings: ArgMapping[] = [];
  for (const [argName, ev] of Object.entries(seedArgsEvidence)) {
    // match by param name == argName or placeholder hint (display-only evidence).
    const hit = paramCandidates.find((p) => p.name === argName);
    if (hit) {
      mappings.push({ argName, in: hit.in, paramName: hit.name, valueType: ev.type, evidenceId: ev.placeholder });
    }
  }
  return mappings;
}

/**
 * Resolve which request param(s) carry the user's search seed VALUE, by scanning captured
 * query-param values for one equal to the seed (06 · seed→param; dashboard seed input).
 *
 * The dashboard user types a search VALUE ("apple") but never knows the URL param NAME
 * (`q`/`keyword`/…). We recover the name by exact value match against the captured
 * `queryParams` across all entries (canonical keeps query values; request bodies keep only
 * key names, so body values cannot be matched here). Match is whitespace-trimmed and
 * case-insensitive but NOT substring (a substring match would false-positive a paging index
 * or any value that happens to contain the term). Returns the matched param NAMES (deduped),
 * which the caller pairs with the raw seed to build seedArgsEvidence — the raw seed value
 * itself is never returned or stored here.
 */
export function resolveSeedParams(entries: RecorderNetworkEntry[], seedValue: string): string[] {
  const needle = seedValue.trim().toLowerCase();
  if (!needle) return [];
  const names = new Set<string>();
  for (const e of entries) {
    if (!e.queryParams) continue;
    for (const [name, value] of Object.entries(e.queryParams)) {
      if (typeof value !== 'string') continue;
      if (value.trim().toLowerCase() === needle) names.add(name);
    }
  }
  return [...names];
}
