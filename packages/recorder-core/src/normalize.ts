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
const DYNAMIC_PARAM_RE = /^(_t|_|ts|time|timestamp|nonce|uuid|sign|signature|csrf|token|callback|cb|rand|random)$/i;
const CURSOR_PARAM_RE = /^(cursor|next|next_cursor|page_token|offset|after|before)$/i;

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
