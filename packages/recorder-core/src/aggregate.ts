/**
 * Endpoint aggregation (14-candidate-aggregation-scoring-plan.md · 第1步).
 *
 * 🔴 Architecture invariant ("核心架构原则"): recorder-core is a PURE DOMAIN layer that
 * outputs only deterministic OBSERVED FACTS. Semantic inference (是不是查询维度 /
 * 该不该暴露 / paramRole / exposeAsArg / inferredMeaning) belongs to the LLM layer in a
 * LATER step — this module must never emit it.
 *
 * groupPairsByEndpoint() folds the per-instance Pair[] (one per request call) into one
 * EndpointGroup per logical endpoint, keyed by method+host+pathname (NOT query, NOT
 * response shape kind). Each group exposes:
 *   - primaryPair: the representative call (priority-selected, NOT first) used for the
 *     existing scoring + endpoint base fields, so scoring stays UNCHANGED.
 *   - paramObservations[]: the union of observed request params across member calls —
 *     FACTS ONLY (counts, sample coverage, value variation, dynamicLike/cursorLike).
 *   - responseShapeVariants / mixedResponseShape: distinct response kinds seen.
 *   - mergedRequestIds: every member entry's requestId (debug/provenance).
 *   - reviewRequired: any member pair.reviewRequired OR mixedResponseShape.
 *
 * pairing.ts is NOT touched. Sample-name mapping relies on the pairing contract: pair.a
 * always comes from sample A (canonical[0]), pair.b from sample B (canonical[1]).
 */

import type {
  RecorderNetworkEntry, ParamObservation, ResponseKind, SampleName,
} from './types.js';
import type { Pair } from './pairing.js';
import { DYNAMIC_PARAM_RE, CURSOR_PARAM_RE, SIGNED_PARAM_RE, CACHE_BUSTER_PARAM_RE } from './normalize.js';

/** One member call within an endpoint group, tagged with the sample it came from. */
interface MemberEntry {
  entry: RecorderNetworkEntry;
  sample: SampleName;
}

export interface EndpointGroup {
  /** aggregation key = method + host + pathname (deterministic). */
  key: string;
  /** every Pair folded into this group (≥1). */
  pairs: Pair[];
  /** the representative call for scoring + endpoint base fields (priority-selected). */
  primaryPair: Pair;
  /** all member entries (each pair's a, plus b when present) with sample tags. */
  members: MemberEntry[];
  /** union of observed request params across members — FACTS ONLY. */
  paramObservations: ParamObservation[];
  /** distinct response bodyShape.kind seen across members (e.g. ['array','object']). */
  responseShapeVariants: ResponseKind[];
  /** >1 distinct response kind among 2xx member responses. */
  mixedResponseShape: boolean;
  /** requestIds of every member entry. */
  mergedRequestIds: string[];
  /** index of each member's originating pair within the group's pairs (debug). */
  groupedPairIndexes: number[];
  /** any member pair.reviewRequired OR mixedResponseShape. */
  reviewRequired: boolean;
}

function endpointKey(e: RecorderNetworkEntry): string {
  return [e.method, e.host ?? '', e.pathname ?? ''].join('|');
}

function is2xx(e: RecorderNetworkEntry): boolean {
  const s = e.response?.status;
  return typeof s === 'number' && s >= 200 && s < 300;
}

function respKind(e: RecorderNetworkEntry): ResponseKind | undefined {
  return e.response?.bodyShape?.kind;
}

function itemKeyCount(e: RecorderNetworkEntry): number {
  return e.response?.bodyShape?.itemKeys?.length ?? 0;
}

function hasResponseBody(e: RecorderNetworkEntry): boolean {
  return e.sourceCompleteness?.responseBody === 'present';
}

/**
 * Priority shape rank for primaryPair selection (Codex High 4):
 *   2 = 2xx + array, 1 = 2xx + object, 0 = anything else.
 * Object richness (itemKeys count) is a tiebreak handled by the comparator.
 */
function shapeRank(e: RecorderNetworkEntry): number {
  if (!is2xx(e)) return 0;
  const k = respKind(e);
  if (k === 'array') return 2;
  if (k === 'object') return 1;
  return 0;
}

/**
 * Pick the representative pair by PRIORITY, not order (Codex High 4):
 *   ① 2xx + array  ② 2xx + object with richer itemKeys  ③ paired over single
 *   ④ response body present  ⑤ original order (stable fallback).
 */
function selectPrimary(pairs: Pair[]): Pair {
  let best = 0;
  for (let i = 1; i < pairs.length; i++) {
    if (isBetterPrimary(pairs[i].a, pairs[i], pairs[best].a, pairs[best])) best = i;
  }
  return pairs[best];
}

/** Returns true if (candEntry,candPair) should outrank the current best. */
function isBetterPrimary(candEntry: RecorderNetworkEntry, candPair: Pair, bestEntry: RecorderNetworkEntry, bestPair: Pair): boolean {
  // ①/② shape rank (array > object > other)
  const cr = shapeRank(candEntry), br = shapeRank(bestEntry);
  if (cr !== br) return cr > br;
  // ② richer itemKeys among same shape rank (objects, or two arrays)
  const ck = itemKeyCount(candEntry), bk = itemKeyCount(bestEntry);
  if (ck !== bk) return ck > bk;
  // ③ paired over single
  const cp = candPair.kind === 'paired' ? 1 : 0, bp = bestPair.kind === 'paired' ? 1 : 0;
  if (cp !== bp) return cp > bp;
  // ④ response body present
  const cb = hasResponseBody(candEntry) ? 1 : 0, bb = hasResponseBody(bestEntry) ? 1 : 0;
  if (cb !== bb) return cb > bb;
  // ⑤ original order → keep the earlier (best), never replace on a pure tie
  return false;
}

/** typeof-style value kind of an observed query value (canonical stores query values as strings). */
function valueKindOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Build the param-observation union across a group's member entries.
 * FACTS ONLY: no role/expose/meaning inference (that is the LLM's job in a later step).
 */
function buildParamObservations(members: MemberEntry[]): ParamObservation[] {
  const totalCalls = members.length;
  // name|in → accumulator
  interface Acc {
    name: string;
    in: 'query' | 'body';
    observedCount: number;
    samples: Set<SampleName>;
    /** observed query values (string form); body params have no captured values. */
    values: string[];
    valueKinds: Set<string>;
    /** whether any captured value existed (query). false for body-only params. */
    hasValues: boolean;
  }
  const accs = new Map<string, Acc>();

  const ensure = (name: string, inLoc: 'query' | 'body'): Acc => {
    const k = `${inLoc}:${name}`;
    let a = accs.get(k);
    if (!a) {
      a = { name, in: inLoc, observedCount: 0, samples: new Set(), values: [], valueKinds: new Set(), hasValues: false };
      accs.set(k, a);
    }
    return a;
  };

  for (const m of members) {
    const e = m.entry;
    // query params (values captured by canonical)
    if (e.queryParams) {
      for (const [name, value] of Object.entries(e.queryParams)) {
        const a = ensure(name, 'query');
        a.observedCount += 1;
        a.samples.add(m.sample);
        a.hasValues = true;
        a.values.push(typeof value === 'string' ? value : JSON.stringify(value));
        a.valueKinds.add(valueKindOf(value));
      }
    }
    // body params (only key names captured — no values)
    for (const name of e.requestBodyShape?.keys ?? []) {
      const a = ensure(name, 'body');
      a.observedCount += 1;
      a.samples.add(m.sample);
    }
  }

  const out: ParamObservation[] = [];
  for (const a of accs.values()) {
    let observedVariation: true | false | 'unknown';
    if (a.in === 'body' || !a.hasValues) {
      observedVariation = 'unknown'; // body values not captured
    } else if (a.observedCount < 2) {
      observedVariation = 'unknown'; // only seen once → cannot judge variation
    } else {
      observedVariation = new Set(a.values).size > 1;
    }
    // Signed vs cache-buster refinement of dynamicLike (name-pattern FACTS, no penalty here).
    // Precedence: signed wins over cache-buster on any (by-design impossible) overlap.
    const signedLike = SIGNED_PARAM_RE.test(a.name);
    out.push({
      name: a.name,
      in: a.in,
      observedCount: a.observedCount,
      totalCalls,
      observedSamples: [...a.samples].sort(),
      observedAlways: a.observedCount === totalCalls,
      observedVariation,
      valueKinds: [...a.valueKinds].sort(),
      dynamicLike: DYNAMIC_PARAM_RE.test(a.name),
      signedLike,
      cacheBusterLike: !signedLike && CACHE_BUSTER_PARAM_RE.test(a.name),
      cursorLike: CURSOR_PARAM_RE.test(a.name),
    });
  }
  // deterministic order: query before body, then by name
  out.sort((x, y) => (x.in === y.in ? x.name.localeCompare(y.name) : x.in === 'query' ? -1 : 1));
  return out;
}

/**
 * Fold per-instance Pair[] into one EndpointGroup per method+host+pathname.
 * Group order follows first-appearance of each endpoint key (deterministic).
 */
export function groupPairsByEndpoint(pairs: Pair[]): EndpointGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, Pair[]>();
  for (const p of pairs) {
    const k = endpointKey(p.a);
    let list = byKey.get(k);
    if (!list) { list = []; byKey.set(k, list); order.push(k); }
    list.push(p);
  }

  const groups: EndpointGroup[] = [];
  for (const key of order) {
    const groupPairs = byKey.get(key)!;
    const members: MemberEntry[] = [];
    const groupedPairIndexes: number[] = [];
    groupPairs.forEach((p, idx) => {
      // pairing contract: a ← sample A, b ← sample B.
      members.push({ entry: p.a, sample: 'A' });
      groupedPairIndexes.push(idx);
      if (p.b) {
        members.push({ entry: p.b, sample: 'B' });
        groupedPairIndexes.push(idx);
      }
    });

    const primaryPair = selectPrimary(groupPairs);
    const paramObservations = buildParamObservations(members);

    // response shape variants across ALL members; mixed measured among 2xx only.
    const allKinds = new Set<ResponseKind>();
    const twoxxKinds = new Set<ResponseKind>();
    for (const m of members) {
      const k = respKind(m.entry);
      if (!k) continue;
      allKinds.add(k);
      if (is2xx(m.entry)) twoxxKinds.add(k);
    }
    const responseShapeVariants = [...allKinds].sort();
    const mixedResponseShape = twoxxKinds.size > 1;

    const mergedRequestIds = members.map((m) => m.entry.requestId).filter((id): id is string => !!id);
    const reviewRequired = groupPairs.some((p) => p.reviewRequired) || mixedResponseShape;

    groups.push({
      key,
      pairs: groupPairs,
      primaryPair,
      members,
      paramObservations,
      responseShapeVariants,
      mixedResponseShape,
      mergedRequestIds,
      groupedPairIndexes,
      reviewRequired,
    });
  }
  return groups;
}
