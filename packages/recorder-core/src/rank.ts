/**
 * Rank — Core Engine orchestration entry (06-recorder-core-engine.md · "Output").
 *
 * rankSamples(input, profile): canonicalize → normalize → pair → score → RankCandidate[]
 * with stable, unique ids usable as InitRequest.selectedCandidateId. This is the shared
 * entry for be POST /recorder/rank and High-Level. Never returns silent empty candidates
 * (06 A/B Pairing): zero usable shape → { ok:false, errorCode:'insufficient_samples' }.
 */

import type {
  RankInput, RankResult, RankCandidate, CaptureSample, RecorderNetworkEntry, ScoringProfile, Confidence,
} from './types.js';
import { DEFAULT_SCORING_PROFILE } from './types.js';
import { canonicalizeEntry, type RawNetworkEntry } from './canonical.js';
import { normalizeEntry, buildArgMappings } from './normalize.js';
import { pairSamples } from './pairing.js';
import { groupPairsByEndpoint } from './aggregate.js';
import { scoreCandidate } from './score.js';

/** Stable candidate id: deterministic from method+pathname+index (no Date/random). */
function candidateId(entry: RecorderNetworkEntry, index: number): string {
  const slug = `${entry.method}_${entry.pathname ?? ''}`.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return `cand_${slug || 'endpoint'}_${index}`;
}

/** Does any param candidate match a seed-arg evidence key? (proves seed→param) */
function hasSeedArgMapping(sample: CaptureSample | undefined, paramNames: string[]): boolean {
  if (!sample?.seedArgsEvidence) return false;
  const keys = Object.keys(sample.seedArgsEvidence);
  return keys.some((k) => paramNames.includes(k));
}

/** Cap a confidence at 'medium' (missing response body → never high; 06). */
function capAtMedium(c: Confidence): Confidence {
  return c === 'high' ? 'medium' : c;
}

/**
 * Detect WebSocket(Pattern E)traffic in the captured samples. WS frames are excluded
 * from scoring (no request/response endpoint semantics), so a WS-driven site otherwise
 * yields a misleading `insufficient_samples: no entries captured`. When WS is present we
 * surface an actionable Pattern-E hint instead. Returns null if no WS observed.
 */
function describeWebSocketTraffic(samples: CaptureSample[]): string | null {
  const framesByUrl = new Map<string, number>();
  for (const s of samples) {
    const entries = (s.entries ?? []) as Array<{ kind?: string; url?: string; webSocketFrames?: unknown[] }>;
    for (const e of entries) {
      if (e?.kind !== 'cdp-websocket') continue;
      const url = typeof e.url === 'string' && e.url ? e.url : '(unknown)';
      const frames = Array.isArray(e.webSocketFrames) ? e.webSocketFrames.length : 0;
      framesByUrl.set(url, (framesByUrl.get(url) ?? 0) + frames);
    }
  }
  if (framesByUrl.size === 0) return null;
  const conns = [...framesByUrl.entries()].map(([u, n]) => `${u} (${n} frames)`).join(', ');
  return `WebSocket traffic observed (Pattern E): ${conns}. Raw WS is not synthesizable to an HTTP endpoint — find the underlying HTTP poll/long-poll endpoint, or build a WS-aware adapter.`;
}

export function rankSamples(input: RankInput, profile: ScoringProfile = DEFAULT_SCORING_PROFILE): RankResult {
  const samples = input.samples ?? [];

  // 1. canonicalize each sample's raw entries (drop hard-reject-at-parse entries,
  //    but remember if everything dropped → insufficient).
  const canonical: RecorderNetworkEntry[][] = samples.map((s) =>
    (s.entries as unknown as RawNetworkEntry[])
      // WebSocket(Pattern E)不进打分:原始 ws 帧无 request/response 端点语义,见 analyze.ts。
      .filter((e) => (e as { kind?: string }).kind !== 'cdp-websocket')
      .map(canonicalizeEntry)
      .filter((r) => r.ok && r.entry)
      .map((r) => r.entry!),
  );

  // 2. pair (handles single-sample / insufficient fallbacks).
  const paired = pairSamples(samples, canonical);
  if (!paired.ok) {
    // No usable HTTP endpoint — but if WS frames were captured, say so (Pattern E)
    // instead of the misleading "no entries captured".
    const ws = describeWebSocketTraffic(samples);
    return ws ? { ...paired, reason: `${paired.reason} — ${ws}` } : paired;
  }

  // 3. aggregate pairs into one group per endpoint (method+host+pathname), then score
  //    each group's representative (primaryPair) → ONE RankCandidate per endpoint.
  //    The existing scoreCandidate/normalize path runs on primaryPair.a so scoring
  //    behavior is UNCHANGED for the representative request; aggregation only ADDS facts.
  const groups = groupPairsByEndpoint(paired.pairs);
  const candidates: RankCandidate[] = [];
  groups.forEach((group, i) => {
    const pair = group.primaryPair;
    const a = pair.a;
    const norm = normalizeEntry(a);
    const paramNames = norm.paramCandidates.map((p) => p.name);
    const seedArgMapped = hasSeedArgMapping(samples[0], paramNames);

    // response weakly echoes seed: an item key equals a seed arg name.
    const seedKeys = Object.keys(samples[0]?.seedArgsEvidence ?? {});
    const responseEchoesSeed = (norm.responseShape.itemKeys ?? []).some((k) => seedKeys.includes(k));

    const scored = scoreCandidate(
      { entry: a, normalized: norm, paired: pair.kind === 'paired', seedArgMapped, responseEchoesSeed },
      profile,
    );

    const args = seedArgMapped ? buildArgMappings(norm.paramCandidates, samples[0]?.seedArgsEvidence) : [];

    // missing response body caps confidence at manual review (medium).
    const respMissing = a.sourceCompleteness.responseBody === 'missing';
    let confidence = scored.confidence;
    if (respMissing && confidence !== 'rejected') confidence = capAtMedium(confidence);
    // A write-method read (POST/PUT returning a list) is not a hard reject but always
    // warrants manual review (06 search-post-json-read: "manual review POST read-like").
    const writeReadLike = ['POST', 'PUT', 'PATCH'].includes(a.method) && confidence !== 'rejected';
    // group.reviewRequired already folds member pairs' reviewRequired + mixedResponseShape.
    const reviewRequired = group.reviewRequired || confidence === 'medium' || respMissing || writeReadLike;

    const candidate: RankCandidate = {
      id: candidateId(a, i),
      endpoint: norm.endpoint,
      score: scored.score,
      confidence,
      reviewRequired,
    };
    if (args.length) candidate.args = args;
    if (norm.endpoint.excludedParams?.length) candidate.excludedParams = norm.endpoint.excludedParams;
    if (Object.keys(norm.responseShape).length) candidate.responseShape = norm.responseShape;
    if (scored.scoreExplanation.length) candidate.scoreExplanation = scored.scoreExplanation;
    const risks = [...scored.risks];
    if (pair.kind === 'single' && pair.reason) risks.push(`single_sample:${pair.reason}`);
    if (scored.hardReject) risks.push(`hard_reject:${scored.hardReject}`);
    if (risks.length) candidate.risks = risks;
    // evidenceIds stays the representative request (backward-compat); mergedRequestIds
    // carries the full group provenance.
    if (a.requestId) candidate.evidenceIds = [a.requestId];

    // ── endpoint-aggregation facts (additive; FACTS ONLY, no semantic inference) ──
    if (group.paramObservations.length) candidate.paramObservations = group.paramObservations;
    if (group.responseShapeVariants.length) candidate.responseShapeVariants = group.responseShapeVariants;
    if (group.mergedRequestIds.length) candidate.mergedRequestIds = group.mergedRequestIds;

    candidates.push(candidate);
  });

  // stable order: score desc, then id asc (deterministic).
  candidates.sort((x, y) => (y.score - x.score) || x.id.localeCompare(y.id));
  return { ok: true, candidates };
}
