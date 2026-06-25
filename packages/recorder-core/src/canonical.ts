/**
 * Canonical capture: raw extension/CDP/daemon network entries → RecorderNetworkEntry.
 *
 * 06-recorder-core-engine.md · "Canonical Capture Schema": parse URL (host/pathname/
 * sorted queryParams), uppercase method (missing → reject), header/body shape-only,
 * response status/mime/bodyShape, timing. sourceCompleteness records present/missing/
 * truncated — a MISSING field must NEVER be mapped as empty (missing ≠ empty), since
 * that distinction caps confidence downstream.
 */

import type {
  RecorderNetworkEntry, SourceCompleteness, RequestBodyShape, CanonicalResponse, ResponseKind,
} from './types.js';

/**
 * Scoring-critical raw field NAMES this module reads off a capture entry. These are the
 * producer↔consumer contract with the capture layer (extension/src/cdp.ts → bundle CaptureRawEntry):
 * if the capture format renames any of these, canonicalization silently reads `undefined` →
 * sourceCompleteness marks the signal 'missing' → scoring degrades with no error. A recorder-core
 * contract test asserts this list ⊆ bundle CaptureRawEntry.properties so such drift fails loudly.
 * NOT included (intentionally benign): `startedAt`/`durationMs` (timing — unused by score/pairing/rank),
 * `requestId` (synthesized `net_<path>` fallback), `page` (taken from the Result envelope, not per-entry).
 */
export const CANONICAL_SCORING_RAW_FIELDS = [
  'method', 'url',
  'requestHeaders', 'requestBodyKind', 'requestBodyPreview', 'requestBodyTruncated',
  'responseStatus', 'responseContentType', 'responsePreview', 'responseBodyTruncated',
] as const;

/** Loosely-typed raw entry as it arrives from the capture layer (network-capture-read). */
export interface RawNetworkEntry {
  requestId?: string;
  page?: string;
  method?: string;
  url?: string;
  requestHeaders?: Record<string, string> | null;
  requestBodyKind?: string;       // 'json' | 'form' | 'text' | 'empty' | undefined
  requestBodyPreview?: string | null;
  requestBodyTruncated?: boolean;
  responseStatus?: number;
  responseContentType?: string;
  responsePreview?: string | null;
  responseBodyTruncated?: boolean;
  startedAt?: number;
  durationMs?: number;
  [k: string]: unknown;
}

export interface CanonicalResult {
  ok: boolean;
  entry?: RecorderNetworkEntry;
  /** Reason a raw entry was rejected at canonicalization (hard reject candidates). */
  rejectReason?: 'missing_method' | 'unparseable_url';
}

// Sensitive header classes we only record presence for (never values).
const AUTH_HEADERS = new Set(['authorization', 'cookie', 'x-csrf-token', 'x-xsrf-token', 'authentication']);

function headerShape(headers: Record<string, string> | null | undefined): {
  shape: Record<string, 'present'> | undefined;
  auth: Record<string, 'present'> | undefined;
  present: boolean;
} {
  if (!headers) return { shape: undefined, auth: undefined, present: false };
  const shape: Record<string, 'present'> = {};
  const auth: Record<string, 'present'> = {};
  for (const key of Object.keys(headers)) {
    const k = key.toLowerCase();
    shape[k] = 'present';
    if (AUTH_HEADERS.has(k)) auth[k] = 'present';
  }
  return { shape, auth: Object.keys(auth).length ? auth : undefined, present: true };
}

function parseBodyShape(kind: string | undefined, preview: string | null | undefined): RequestBodyShape | undefined {
  if (kind === undefined && preview == null) return undefined;
  if (kind === 'empty' || (!kind && !preview)) return { type: 'empty' };
  if (kind === 'json' || kind === 'form' || kind === 'text') {
    const keys = extractKeys(kind, preview);
    return keys.length ? { type: kind, keys } : { type: kind };
  }
  return undefined;
}

function extractKeys(kind: string, preview: string | null | undefined): string[] {
  if (!preview) return [];
  try {
    if (kind === 'json') {
      const v = JSON.parse(preview);
      return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];
    }
    if (kind === 'form') {
      return [...new URLSearchParams(preview).keys()];
    }
  } catch { /* truncated/invalid preview → no keys */ }
  return [];
}

function responseShape(status: number | undefined, mime: string | undefined, preview: string | null | undefined, truncated: boolean | undefined): CanonicalResponse | undefined {
  if (status === undefined && mime === undefined && preview == null) return undefined;
  const resp: CanonicalResponse = {};
  if (status !== undefined) resp.status = status;
  if (mime) resp.mime = mime.split(';')[0].trim();
  if (preview != null) {
    const { kind, itemKeys } = bodyKind(resp.mime, preview);
    resp.bodyShape = itemKeys.length ? { kind, itemKeys } : { kind };
    // truncated preview lowers shape confidence
    resp.shapeConfidence = truncated ? 0.5 : 0.9;
  }
  return resp;
}

function bodyKind(mime: string | undefined, preview: string): { kind: ResponseKind; itemKeys: string[] } {
  if (mime && mime.includes('html')) return { kind: 'html', itemKeys: [] };
  if (mime && mime.includes('json')) {
    try {
      const v = JSON.parse(preview);
      if (Array.isArray(v)) {
        const first = v.find((x) => x && typeof x === 'object');
        return { kind: 'array', itemKeys: first ? Object.keys(first) : [] };
      }
      if (v && typeof v === 'object') return { kind: 'object', itemKeys: Object.keys(v) };
      return { kind: 'scalar', itemKeys: [] };
    } catch { /* truncated JSON */ return { kind: 'unknown', itemKeys: [] }; }
  }
  return { kind: 'unknown', itemKeys: [] };
}

/** Canonicalize one raw entry. Returns ok:false with rejectReason for hard-reject cases. */
export function canonicalizeEntry(raw: RawNetworkEntry): CanonicalResult {
  const method = typeof raw.method === 'string' ? raw.method.toUpperCase() : '';
  if (!method) return { ok: false, rejectReason: 'missing_method' };

  let parsed: URL;
  try { parsed = new URL(String(raw.url)); }
  catch { return { ok: false, rejectReason: 'unparseable_url' }; }

  // sorted query keys (deterministic)
  const queryParams: Record<string, string> = {};
  for (const k of [...parsed.searchParams.keys()].sort()) {
    queryParams[k] = parsed.searchParams.get(k) ?? '';
  }

  const hdr = headerShape(raw.requestHeaders);
  const reqBody = parseBodyShape(raw.requestBodyKind, raw.requestBodyPreview);
  const resp = responseShape(raw.responseStatus, raw.responseContentType, raw.responsePreview, raw.responseBodyTruncated);
  const hasTiming = typeof raw.startedAt === 'number' || typeof raw.durationMs === 'number';

  // sourceCompleteness — missing ≠ empty (06).
  const sourceCompleteness: SourceCompleteness = {
    requestHeaders: hdr.present ? 'present' : 'missing',
    requestBody: raw.requestBodyKind !== undefined || raw.requestBodyPreview != null
      ? (raw.requestBodyTruncated ? 'truncated' : 'present')
      : 'missing',
    responseBody: raw.responsePreview != null
      ? (raw.responseBodyTruncated ? 'truncated' : 'present')
      : 'missing',
    timing: hasTiming ? 'present' : 'missing',
  };

  const entry: RecorderNetworkEntry = {
    requestId: typeof raw.requestId === 'string' ? raw.requestId : `net_${parsed.pathname}`,
    method,
    url: parsed.toString(),
    host: parsed.host,
    pathname: parsed.pathname,
    sourceCompleteness,
  };
  if (raw.page) entry.page = raw.page;
  if (Object.keys(queryParams).length) entry.queryParams = queryParams;
  if (hdr.shape) entry.requestHeadersShape = hdr.shape;
  if (hdr.auth) entry.authSignals = hdr.auth;
  if (reqBody) entry.requestBodyShape = reqBody;
  if (resp) entry.response = resp;
  if (hasTiming) entry.timing = { startedAt: raw.startedAt, durationMs: raw.durationMs };

  return { ok: true, entry };
}
