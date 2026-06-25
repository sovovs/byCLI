/**
 * Gap 2 guard (be↔contract reconciliation handoff): pin the raw capture entry ↔ canonicalize
 * contract so a capture-format field rename fails LOUDLY here instead of silently degrading
 * sourceCompleteness → scoring → candidate quality. See bundle $defs/CaptureRawEntry and
 * canonical.ts CANONICAL_SCORING_RAW_FIELDS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { canonicalizeEntry, CANONICAL_SCORING_RAW_FIELDS } from './canonical.js';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(here, '../../../dashboard-docs/system/adapter-recorder-system/schemas/adapter-recorder.bundle.json');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BUNDLE = JSON.parse(readFileSync(bundlePath, 'utf8')) as { $defs: Record<string, any> };

describe('capture contract: raw capture entry ↔ canonicalize (Gap 2 guard)', () => {
  it('every scoring-critical field canonical reads is declared in bundle CaptureRawEntry', () => {
    const raw = BUNDLE.$defs.CaptureRawEntry;
    expect(raw, 'bundle must define $defs/CaptureRawEntry').toBeTruthy();
    const declared = new Set(Object.keys(raw.properties ?? {}));
    for (const field of CANONICAL_SCORING_RAW_FIELDS) {
      // a capture rename (or a contract that drops this field) trips HERE, not silently at rank time.
      expect(declared.has(field), `CaptureRawEntry must declare scoring field "${field}"`).toBe(true);
    }
  });

  it('CaptureSample.entries references the RAW CaptureRawEntry, not the normalized RecorderNetworkEntry', () => {
    expect(BUNDLE.$defs.CaptureSample.properties.entries.items.$ref).toBe('#/$defs/CaptureRawEntry');
  });

  it('canonicalizeEntry consumes a CaptureRawEntry-shaped entry and marks the scoring signals present', () => {
    // sample mirrors extension/src/cdp.ts NetworkCaptureEntry (the producer of record).
    const result = canonicalizeEntry({
      kind: 'cdp',
      url: 'https://api.example.com/search?q=x',
      method: 'GET',
      requestHeaders: { 'content-type': 'application/json' },
      requestBodyKind: 'json',
      requestBodyPreview: '{"q":"x"}',
      requestBodyTruncated: false,
      responseStatus: 200,
      responseContentType: 'application/json',
      responsePreview: '[{"id":1}]',
      responseBodyTruncated: false,
      timestamp: 1_700_000_000_000,
    });
    expect(result.ok).toBe(true);
    const e = result.entry!;
    expect(e.method).toBe('GET');
    expect(e.host).toBe('api.example.com');
    expect(e.sourceCompleteness.requestHeaders).toBe('present');
    expect(e.sourceCompleteness.requestBody).toBe('present');
    expect(e.sourceCompleteness.responseBody).toBe('present');
    expect(e.response).toBeTruthy();
    // documented benign mismatch: producer emits `timestamp`, canonical reads startedAt/durationMs →
    // timing is always 'missing' (unused by score/pairing/rank; see CANONICAL_SCORING_RAW_FIELDS doc).
    expect(e.sourceCompleteness.timing).toBe('missing');
  });
});
