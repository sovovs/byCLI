import { describe, it, expect } from 'vitest';
import { rankSamples } from './rank.js';
import { groupPairsByEndpoint } from './aggregate.js';
import { pairSamples } from './pairing.js';
import { canonicalizeEntry, type RawNetworkEntry } from './canonical.js';
import type { CaptureSample, RankInput } from './types.js';

function sample(name: 'A' | 'B', entries: unknown[], seed?: Record<string, { placeholder: string; type: string }>): CaptureSample {
  return { sampleName: name, seedArgsEvidence: seed, entries: entries as never };
}
function run(samples: CaptureSample[]): RankInput { return { sessionId: 'rec_test', samples }; }

const jsonList = (url: string, extra: Record<string, unknown> = {}) => ({
  requestId: `net_${url}`, method: 'GET', url,
  requestHeaders: { accept: 'application/json' },
  responseStatus: 200, responseContentType: 'application/json',
  responsePreview: JSON.stringify([{ title: 't', url: 'u' }]),
  startedAt: 0, durationMs: 100, ...extra,
});

// Helper: canonicalize raw entries (mirrors rankSamples step 1, drops WS) then pair.
function pairsFrom(aRaw: unknown[], bRaw?: unknown[]) {
  const samples: CaptureSample[] = bRaw
    ? [sample('A', aRaw), sample('B', bRaw)]
    : [sample('A', aRaw)];
  const canonical = samples.map((s) =>
    (s.entries as unknown as RawNetworkEntry[])
      .map(canonicalizeEntry)
      .filter((r) => r.ok && r.entry)
      .map((r) => r.entry!),
  );
  const paired = pairSamples(samples, canonical);
  if (!paired.ok) throw new Error(`pairing failed: ${paired.reason}`);
  return paired.pairs;
}

describe('groupPairsByEndpoint · facts-only aggregation', () => {
  it('same endpoint called N times with different params → 1 group, paramObservations = union', () => {
    // A & B hit the SAME endpoint (method+host+pathname) with different query params.
    const pairs = pairsFrom(
      [jsonList('https://x.com/api/search?keyword=cat&page=1')],
      [jsonList('https://x.com/api/search?keyword=dog&page=2')],
    );
    const groups = groupPairsByEndpoint(pairs);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.key).toBe('GET|x.com|/api/search');

    const byName = Object.fromEntries(g.paramObservations.map((p) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(['keyword', 'page']);

    // keyword: differing values across A/B → observedVariation true; seen in both samples.
    expect(byName.keyword.in).toBe('query');
    expect(byName.keyword.observedVariation).toBe(true);
    expect(byName.keyword.observedCount).toBe(2);
    expect(byName.keyword.totalCalls).toBe(2);
    expect(byName.keyword.observedAlways).toBe(true);
    expect(byName.keyword.observedSamples).toEqual(['A', 'B']);
    expect(byName.keyword.dynamicLike).toBe(false);
    expect(byName.keyword.cursorLike).toBe(false);

    // page: 1 vs 2 → also varies.
    expect(byName.page.observedVariation).toBe(true);
  });

  it('param with identical value across calls → observedVariation false; single occurrence → unknown', () => {
    // locale identical in both; q differs; region only present in A (seen once → unknown).
    const pairs = pairsFrom(
      [jsonList('https://x.com/api/s?q=cat&locale=en&region=us')],
      [jsonList('https://x.com/api/s?q=dog&locale=en')],
    );
    const g = groupPairsByEndpoint(pairs)[0];
    const byName = Object.fromEntries(g.paramObservations.map((p) => [p.name, p]));
    expect(byName.locale.observedVariation).toBe(false);
    expect(byName.locale.observedAlways).toBe(true);
    expect(byName.q.observedVariation).toBe(true);
    expect(byName.region.observedVariation).toBe('unknown'); // only one occurrence
    expect(byName.region.observedAlways).toBe(false);
    expect(byName.region.observedSamples).toEqual(['A']);
  });

  it('dynamicLike / cursorLike flags reuse normalize patterns (facts, not verdicts)', () => {
    const pairs = pairsFrom(
      [jsonList('https://x.com/api/s?keyword=cat&_t=111&sign=aaa&cursor=c1')],
      [jsonList('https://x.com/api/s?keyword=dog&_t=222&sign=bbb&cursor=c2')],
    );
    const g = groupPairsByEndpoint(pairs)[0];
    const byName = Object.fromEntries(g.paramObservations.map((p) => [p.name, p]));
    expect(byName._t.dynamicLike).toBe(true);
    expect(byName.sign.dynamicLike).toBe(true);
    expect(byName.cursor.cursorLike).toBe(true);
    expect(byName.keyword.dynamicLike).toBe(false);
    expect(byName.keyword.cursorLike).toBe(false);
  });

  it('signedLike / cacheBusterLike refine dynamicLike (facts, not penalties)', () => {
    // signed/anti-bot params, cache-buster params, an "unknown dynamic" (uuid/web_id/
    // device_id), and a plain business param — all under one endpoint.
    const pairs = pairsFrom(
      [jsonList('https://x.com/api/s?keyword=cat&category_id=1&sign=a&nonce=n1&csrf=c1&token=t1&w_rid=w1&_t=111&ts=1&timestamp=1&cb=1&rand=1&uuid=u1&web_id=e1&device_id=d1')],
      [jsonList('https://x.com/api/s?keyword=dog&category_id=2&sign=b&nonce=n2&csrf=c2&token=t2&w_rid=w2&_t=222&ts=2&timestamp=2&cb=2&rand=2&uuid=u2&web_id=e2&device_id=d2')],
    );
    const g = groupPairsByEndpoint(pairs)[0];
    const byName = Object.fromEntries(g.paramObservations.map((p) => [p.name, p]));

    // signed/anti-bot → signedLike true, cacheBusterLike false.
    for (const n of ['sign', 'nonce', 'csrf', 'token', 'w_rid']) {
      expect(byName[n].signedLike, `${n}.signedLike`).toBe(true);
      expect(byName[n].cacheBusterLike, `${n}.cacheBusterLike`).toBe(false);
    }
    // cache-buster → cacheBusterLike true, signedLike false.
    for (const n of ['_t', 'ts', 'timestamp', 'cb', 'rand']) {
      expect(byName[n].cacheBusterLike, `${n}.cacheBusterLike`).toBe(true);
      expect(byName[n].signedLike, `${n}.signedLike`).toBe(false);
    }
    // "unknown dynamic": dynamicLike umbrella true (uuid is in DYNAMIC_PARAM_RE) but
    // NEITHER refinement matches — be treats as small penalty.
    expect(byName.uuid.dynamicLike).toBe(true);
    expect(byName.uuid.signedLike).toBe(false);
    expect(byName.uuid.cacheBusterLike).toBe(false);
    for (const n of ['web_id', 'device_id']) {
      expect(byName[n].signedLike, `${n}.signedLike`).toBe(false);
      expect(byName[n].cacheBusterLike, `${n}.cacheBusterLike`).toBe(false);
    }
    // normal business params → all three false.
    for (const n of ['keyword', 'category_id']) {
      expect(byName[n].dynamicLike, `${n}.dynamicLike`).toBe(false);
      expect(byName[n].signedLike, `${n}.signedLike`).toBe(false);
      expect(byName[n].cacheBusterLike, `${n}.cacheBusterLike`).toBe(false);
    }
  });

  it('body params → observedVariation unknown (request body values not captured), valueKinds empty', () => {
    const post = (kw: string) => ({
      requestId: `net_post_${kw}`, method: 'POST', url: 'https://x.com/api/search',
      requestBodyKind: 'json', requestBodyPreview: JSON.stringify({ keyword: kw, page: 1 }),
      responseStatus: 200, responseContentType: 'application/json',
      responsePreview: JSON.stringify([{ title: 't' }]), startedAt: 0, durationMs: 50,
    });
    const g = groupPairsByEndpoint(pairsFrom([post('cat')], [post('dog')]))[0];
    const kw = g.paramObservations.find((p) => p.name === 'keyword')!;
    expect(kw.in).toBe('body');
    expect(kw.observedVariation).toBe('unknown');
    expect(kw.valueKinds).toEqual([]);
  });

  it('mixed response shape under same endpoint → 1 group, mixedResponseShape + reviewRequired, primaryPair picks array', () => {
    // Same method+host+pathname, but A returns an array and B returns an object.
    // (Different bodyShape.kind means pairing keeps them as single pairs, but they
    //  aggregate to one endpoint group.)
    const asArray = {
      requestId: 'net_arr', method: 'GET', url: 'https://x.com/api/feed',
      responseStatus: 200, responseContentType: 'application/json',
      responsePreview: JSON.stringify([{ id: 1 }, { id: 2 }]), startedAt: 0, durationMs: 10,
    };
    const asObject = {
      requestId: 'net_obj', method: 'GET', url: 'https://x.com/api/feed',
      responseStatus: 200, responseContentType: 'application/json',
      responsePreview: JSON.stringify({ ok: true }), startedAt: 0, durationMs: 10,
    };
    const pairs = pairsFrom([asArray, asObject]);
    const groups = groupPairsByEndpoint(pairs);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.mixedResponseShape).toBe(true);
    expect(g.reviewRequired).toBe(true);
    expect(g.responseShapeVariants.sort()).toEqual(['array', 'object']);
    // primaryPair priority ① 2xx+array wins over object.
    expect(g.primaryPair.a.requestId).toBe('net_arr');
    expect(g.primaryPair.a.response?.bodyShape?.kind).toBe('array');
  });

  it('primaryPair prefers richer object when no array present', () => {
    const lean = {
      requestId: 'net_lean', method: 'GET', url: 'https://x.com/api/obj',
      responseStatus: 200, responseContentType: 'application/json',
      responsePreview: JSON.stringify({ a: 1 }), startedAt: 0, durationMs: 10,
    };
    const rich = {
      requestId: 'net_rich', method: 'GET', url: 'https://x.com/api/obj',
      responseStatus: 200, responseContentType: 'application/json',
      responsePreview: JSON.stringify({ a: 1, b: 2, c: 3, d: 4 }), startedAt: 0, durationMs: 10,
    };
    const g = groupPairsByEndpoint(pairsFrom([lean, rich]))[0];
    expect(g.primaryPair.a.requestId).toBe('net_rich');
  });

  it('distinct endpoints stay separate groups', () => {
    const pairs = pairsFrom(
      [jsonList('https://x.com/api/a?q=1'), jsonList('https://x.com/api/b?q=1')],
      [jsonList('https://x.com/api/a?q=2'), jsonList('https://x.com/api/b?q=2')],
    );
    const groups = groupPairsByEndpoint(pairs);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.key).sort()).toEqual(['GET|x.com|/api/a', 'GET|x.com|/api/b']);
    // mergedRequestIds carries both members per group.
    for (const g of groups) {
      expect(g.mergedRequestIds.length).toBe(2);
    }
  });

  it('mergedRequestIds includes every member entry id', () => {
    const g = groupPairsByEndpoint(pairsFrom(
      [jsonList('https://x.com/api/s?q=cat')],
      [jsonList('https://x.com/api/s?q=dog')],
    ))[0];
    expect(g.mergedRequestIds.sort()).toEqual(
      ['net_https://x.com/api/s?q=cat', 'net_https://x.com/api/s?q=dog'].sort(),
    );
  });
});

describe('rankSamples · aggregation integration', () => {
  it('same endpoint, different params → ONE candidate with paramObservations union', () => {
    const r = rankSamples(run([
      sample('A', [jsonList('https://x.com/api/search?keyword=cat&page=1')], { keyword: { placeholder: 'kw_1', type: 'string' } }),
      sample('B', [jsonList('https://x.com/api/search?keyword=dog&page=2')], { keyword: { placeholder: 'kw_2', type: 'string' } }),
    ]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cands = r.candidates.filter((c) => c.endpoint.pathname === '/api/search');
    expect(cands).toHaveLength(1);
    const c = cands[0];
    expect(c.paramObservations?.map((p) => p.name).sort()).toEqual(['keyword', 'page']);
    expect(c.mergedRequestIds?.length).toBe(2);
    // endpoint.queryParams stays the representative request's stable query (NOT the union).
    expect(c.endpoint.queryParams).toHaveProperty('keyword');
    expect(c.endpoint.queryParams).toHaveProperty('page');
  });

  it('mixed shape endpoint → one candidate, reviewRequired, representative is the array', () => {
    const asArray = {
      requestId: 'net_arr', method: 'GET', url: 'https://x.com/api/feed',
      responseStatus: 200, responseContentType: 'application/json',
      responsePreview: JSON.stringify([{ id: 1 }]), startedAt: 0, durationMs: 10,
    };
    const asObject = {
      requestId: 'net_obj', method: 'GET', url: 'https://x.com/api/feed',
      responseStatus: 200, responseContentType: 'application/json',
      responsePreview: JSON.stringify({ ok: true }), startedAt: 0, durationMs: 10,
    };
    const r = rankSamples(run([sample('A', [asArray, asObject])]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cands = r.candidates.filter((c) => c.endpoint.pathname === '/api/feed');
    expect(cands).toHaveLength(1);
    const c = cands[0];
    expect(c.reviewRequired).toBe(true);
    expect(c.responseShapeVariants?.sort()).toEqual(['array', 'object']);
    // representative drives responseShape → array.
    expect(c.responseShape?.kind).toBe('array');
  });

  it('REAL A/B shape drift (A array, B object, same endpoint) → 1 candidate, mixedResponseShape, both variants + requestIds', () => {
    // The prior "mixed shape" test stuffed BOTH entries into one sample A; this uses
    // real separate A and B samples. pairKey includes bodyShape.kind, so the A-array and
    // B-object never pairKey-match — the B-object was previously dropped before
    // aggregation. Now the unmatched B entry surfaces as a single pair and re-folds.
    const arrA = {
      requestId: 'net_arr_A', method: 'GET', url: 'https://x.com/api/feed?keyword=cat',
      responseStatus: 200, responseContentType: 'application/json',
      responsePreview: JSON.stringify([{ id: 1 }, { id: 2 }]), startedAt: 0, durationMs: 10,
    };
    const objB = {
      requestId: 'net_obj_B', method: 'GET', url: 'https://x.com/api/feed?page=2',
      responseStatus: 200, responseContentType: 'application/json',
      responsePreview: JSON.stringify({ ok: true }), startedAt: 0, durationMs: 10,
    };
    const r = rankSamples(run([sample('A', [arrA]), sample('B', [objB])]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cands = r.candidates.filter((c) => c.endpoint.pathname === '/api/feed');
    expect(cands).toHaveLength(1);
    const c = cands[0];
    expect(c.reviewRequired).toBe(true);
    expect(c.responseShapeVariants?.sort()).toEqual(['array', 'object']);
    expect(c.mergedRequestIds?.sort()).toEqual(['net_arr_A', 'net_obj_B']);
    // paramObservations covers params from BOTH calls (keyword from A, page from B).
    expect(c.paramObservations?.map((p) => p.name).sort()).toEqual(['keyword', 'page']);
    // representative drives responseShape → array (2xx+array outranks object).
    expect(c.responseShape?.kind).toBe('array');
  });

  it('B-only endpoint (never appears in sample A) with stable shape → still produces a candidate', () => {
    const aOnly = jsonList('https://x.com/api/search?keyword=cat');
    const bOnly = {
      requestId: 'net_bonly', method: 'GET', url: 'https://x.com/api/bonly?q=1',
      responseStatus: 200, responseContentType: 'application/json',
      responsePreview: JSON.stringify([{ id: 9 }]), startedAt: 0, durationMs: 10,
    };
    const r = rankSamples(run([sample('A', [aOnly]), sample('B', [bOnly])]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bCand = r.candidates.find((c) => c.endpoint.pathname === '/api/bonly');
    expect(bCand).toBeDefined();
    expect(bCand?.mergedRequestIds).toContain('net_bonly');
    // the A-only endpoint still surfaces too.
    expect(r.candidates.some((c) => c.endpoint.pathname === '/api/search')).toBe(true);
  });

  it('candidateId is deterministic and stable across runs', () => {
    const build = () => rankSamples(run([
      sample('A', [jsonList('https://x.com/api/search?keyword=cat')], { keyword: { placeholder: 'kw_1', type: 'string' } }),
      sample('B', [jsonList('https://x.com/api/search?keyword=dog')], { keyword: { placeholder: 'kw_2', type: 'string' } }),
    ]));
    const r1 = build(), r2 = build();
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.candidates.map((c) => c.id)).toEqual(r2.candidates.map((c) => c.id));
  });
});
