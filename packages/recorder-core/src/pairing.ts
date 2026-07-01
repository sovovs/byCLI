/**
 * A/B pairing (06-recorder-core-engine.md · "A/B Pairing").
 *
 * Pair first by method+host+pathname+response.mime+response.bodyShape.kind, then by
 * query/body key overlap, timing window and response item-key similarity.
 *
 * Fallback ladder (never return silent empty candidates):
 *   - paired A/B                                  → normal rank/diff
 *   - pairing failed but one sample stable shape  → single-sample, reviewRequired
 *   - no usable shape                             → insufficient_samples error
 *   - A/B share seed values                       → degrade to single-sample + reason
 */

import type { RecorderNetworkEntry, CaptureSample } from './types.js';

export interface Pair {
  kind: 'paired' | 'single';
  a: RecorderNetworkEntry;
  b?: RecorderNetworkEntry;
  reviewRequired: boolean;
  reason?: string;
}

function pairKey(e: RecorderNetworkEntry): string {
  return [e.method, e.host ?? '', e.pathname ?? '', e.response?.mime ?? '', e.response?.bodyShape?.kind ?? ''].join('|');
}

function keyOverlap(a: RecorderNetworkEntry, b: RecorderNetworkEntry): number {
  const ak = new Set([...(a.queryParams ? Object.keys(a.queryParams) : []), ...(a.requestBodyShape?.keys ?? [])]);
  const bk = [...(b.queryParams ? Object.keys(b.queryParams) : []), ...(b.requestBodyShape?.keys ?? [])];
  if (ak.size === 0 && bk.length === 0) return 1;
  const inter = bk.filter((k) => ak.has(k)).length;
  const union = new Set([...ak, ...bk]).size || 1;
  return inter / union;
}

/** Whether an entry has a usable response shape for candidate generation. */
function hasStableShape(e: RecorderNetworkEntry): boolean {
  const k = e.response?.bodyShape?.kind;
  return k === 'array' || k === 'object';
}

/** True when A and B seed evidence are identical (cannot prove seed→param mapping). */
function sharesSeedValues(a: CaptureSample, b: CaptureSample): boolean {
  const av = JSON.stringify(a.seedArgsEvidence ?? {});
  const bv = JSON.stringify(b.seedArgsEvidence ?? {});
  return av !== '{}' && av === bv;
}

export type PairingResult =
  | { ok: true; pairs: Pair[] }
  | { ok: false; errorCode: 'insufficient_samples'; reason: string };

/**
 * Pair entries across samples. `entriesBySample` is the canonicalized entries per
 * sample (A first, B second when present).
 */
export function pairSamples(samples: CaptureSample[], canonical: RecorderNetworkEntry[][]): PairingResult {
  const aEntries = canonical[0] ?? [];
  const bEntries = canonical[1] ?? [];
  const sampleA = samples[0];
  const sampleB = samples[1];

  // No usable shape anywhere → explicit error (never silent empty).
  const anyStable = [...aEntries, ...bEntries].some(hasStableShape);
  if (!anyStable && aEntries.length === 0) {
    return { ok: false, errorCode: 'insufficient_samples', reason: 'no entries captured' };
  }
  if (!anyStable) {
    return { ok: false, errorCode: 'insufficient_samples', reason: 'no entry has a usable response shape' };
  }

  // Single-sample mode (no B, or A/B share seed values → cannot prove mapping).
  const singleOnly = bEntries.length === 0 || (sampleA && sampleB && sharesSeedValues(sampleA, sampleB));
  if (singleOnly) {
    const reason = bEntries.length === 0
      ? 'only one sample captured'
      : 'A and B share seed evidence; cannot prove seed→param mapping';
    const pairs: Pair[] = aEntries
      .filter(hasStableShape)
      .map((a) => ({ kind: 'single' as const, a, reviewRequired: true, reason }));
    return { ok: true, pairs };
  }

  // Paired mode: match each A entry to the best B entry by pairKey + key overlap.
  const pairs: Pair[] = [];
  const usedB = new Set<number>();
  for (const a of aEntries) {
    if (!hasStableShape(a)) continue;
    const ak = pairKey(a);
    let best = -1, bestScore = 0;
    bEntries.forEach((b, i) => {
      if (usedB.has(i) || pairKey(b) !== ak) return;
      const score = keyOverlap(a, b);
      if (score >= bestScore) { bestScore = score; best = i; }
    });
    if (best >= 0) {
      usedB.add(best);
      pairs.push({ kind: 'paired', a, b: bEntries[best], reviewRequired: false });
    } else {
      // A entry with stable shape but no B match → single-sample fallback.
      pairs.push({ kind: 'single', a, reviewRequired: true, reason: 'no matching B-sample entry' });
    }
  }
  // B entries with a usable shape that no A entry consumed (e.g. a B-only endpoint,
  // or an A/B response shape-drift where pairKey includes bodyShape.kind so the same
  // endpoint's array-A / object-B never pairKey-match). Emit them as single pairs so
  // they reach groupPairsByEndpoint, which re-folds by method+host+pathname and can
  // surface mixedResponseShape / responseShapeVariants across the real A/B split.
  bEntries.forEach((b, i) => {
    if (usedB.has(i) || !hasStableShape(b)) return;
    pairs.push({ kind: 'single', a: b, reviewRequired: true, reason: 'no matching A-sample entry' });
  });
  if (pairs.length === 0) {
    return { ok: false, errorCode: 'insufficient_samples', reason: 'no pairable entry with usable shape' };
  }
  return { ok: true, pairs };
}
