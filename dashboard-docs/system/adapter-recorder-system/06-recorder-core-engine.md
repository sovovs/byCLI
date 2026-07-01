# 06 · Recorder Core Engine

## Purpose

The Core Engine turns A/B network samples into ranked adapter candidates. Browser capture and site-level analyze only provide raw material; endpoint selection requires explicit normalize/rank/diff logic.

Machine-readable definitions for `RecorderNetworkEntry`, `SourceCompleteness`, `CaptureSample`, `RankCandidate`, `ScoreExplanationItem` and `AnalyzeReport` live in `schemas/adapter-recorder.bundle.json` (under `$defs`). Prose and schema must be updated together.

## Input Shape

```json
{
  "sessionId": "rec_...",
  "samples": [
    {
      "sampleName": "A",
      "seedArgsEvidence": {
        "keyword": { "placeholder": "kw_1", "type": "string", "hmac": "..." }
      },
      "entries": [
        {
          "requestId": "net_...",
          "page": "TARGET_ID",
          "method": "GET",
          "url": "https://example.com/api/search?q=...",
          "requestHeadersShape": { "authorization": "present", "cookie": "present" },
          "requestBodyShape": { "type": "json|form|empty", "keys": ["q", "page"] },
          "response": {
            "status": 200,
            "mime": "application/json",
            "bodyShape": { "kind": "array", "itemKeys": ["title", "url"] }
          },
          "timing": { "startedAt": 0, "durationMs": 123 }
        }
      ]
    }
  ]
}
```

Inputs may not depend on raw large response bodies or full sensitive headers.

## Canonical Capture Schema

Raw extension/CDP/daemon entries map to `RecorderNetworkEntry` with `sourceCompleteness`.

| Raw field | Canonical field | Rule |
| --- | --- | --- |
| `url` | `url`, `host`, `pathname`, `queryParams` | parseable URL required, sorted query keys |
| `method` | `method` | uppercase; missing method rejected |
| `requestHeaders` | `requestHeadersShape`, `authSignals` | lower-case keys, presence and sensitive class only |
| `requestBodyPreview` | `requestBodyShape`, `bodyParamCandidates` | json/form keys parsed when possible; values type/HMAC/length only |
| `responseStatus` | `response.status` | 401/403/302/login HTML kept as auth signal |
| `responseContentType` | `response.mime` | type only |
| `responsePreview` | `response.bodyShape`, `shapeConfidence` | parse JSON shape; truncated lowers confidence |
| `startedAt/durationMs` | `timing` | used for pairing; missing lowers confidence |

`sourceCompleteness`:

```json
{
  "requestHeaders": "present|missing",
  "requestBody": "present|missing|truncated",
  "responseBody": "present|missing|truncated",
  "timing": "present|missing"
}
```

Missing fields must never be mapped as empty. Missing request body prevents body arg inference; missing response body caps confidence at manual review.

## Normalize

This is a rank-internal engine phase (run inside `POST /recorder/rank`), not a top-level session state.

The normalized outputs below are formalized as machine contracts in `adapter-recorder.bundle.json`: the endpoint shape is `$defs/EndpointDescriptor` (`urlTemplate`/`host`/`pathname`/`queryParams`/`dynamicParams`/`excludedParams`/`requestBodyShape`/`authRequired`), seed-to-param mappings are `$defs/ArgMapping`, and the response shape is `$defs/ResponseShape`. `RankCandidate` and High-Level `InitInput.endpoint` reference the same `EndpointDescriptor` so Core, UI and Init cannot diverge. Prose and schema must be updated together.

`headerShape`, `bodyParamCandidates` and `antiBotSignal` are rank-internal signals, not separate candidate output fields: `bodyParamCandidates` is consumed to build `ArgMapping[]`, while `headerShape` and `antiBotSignal` feed `scoreExplanation`/`risks` (and `authRequired`). They are deliberately not surfaced as standalone `RankCandidate`/`EndpointDescriptor` fields.

### seed→param resolution (where `seedArgsEvidence` comes from)

`seedArgsEvidence` keys are **param names**, but a user only supplies a search **value** ("apple"). `resolveSeedParams(entries, seedValue)` (pure, in `normalize.ts`) recovers the name by scanning captured `queryParams` **values** for an exact (trim + lowercase, never substring) match and returning the matched param name(s). Callers (the dashboard recording flow via `dashboard-be`) pair the resolved name with the raw seed and run it through `deriveEvidenceSeedArgs` — so the ranker's `seed_arg_maps_to_param` (+20) / `response_echoes_seed` (+10) signals can fire. The raw seed value never enters core output (see ADR 0003). Request bodies keep only key names (not values), so only query values are matchable here; values hidden in POST bodies / SSR page URLs are not resolved and fall back to no evidence.

| Object | Rule | Output |
| --- | --- | --- |
| URL | split host/path/query, sort keys, remove cache-buster | `urlTemplate`, `queryParams`, `dynamicParams` |
| headers | shape/presence only | `authSignals`, `headerShape` |
| body | parse json/form/text shape | `bodyShape`, `bodyParamCandidates` |
| dynamic fields | detect timestamp, nonce, uuid, sign, csrf, `_t`, callback, cursor | `excludedParams` |
| response | status, mime, list/object shape, item keys, count, echo signals | `responseShape`, `shapeConfidence` |
| auth/errors | retain 401/403/302/login HTML as signals | `authRequired`, `antiBotSignal` |

## A/B Pairing

Pair first by `method + host + pathname + response.mime + response.bodyShape.kind`, then by query/body key overlap, timing window and response item key similarity.

Fallback:

| Scenario | Output |
| --- | --- |
| paired A/B | normal rank/diff |
| pairing failed but one sample has stable shape | low confidence single-sample candidate, `reviewRequired: true` |
| no usable shape | `insufficient_samples` error |

Never return silent empty `candidates: []` without reason.

Paired A/B candidates assume both samples used the same trigger family and **different** seed evidence. If A and B share seed values, the pairing cannot prove a seed-to-param mapping, so it degrades to a single-sample candidate with `reviewRequired: true` and an explicit reason.

## Scoring (Default ScoringProfile)

The deltas and bands below are the **default** ScoringProfile. At runtime the ranker reads them from the validated `ScoringProfile` (see `09`); implementations must not inline these numbers. Hard rejects are not part of the profile.

| Signal | Delta |
| --- | --- |
| stable JSON list/object | +25 |
| seed arg maps to query/body | +20 |
| response weakly echoes seed arg | +10 |
| requires cookie/session | +5 |
| timestamp/nonce/sign | -10 |
| weak HTML/static-like signal (not confirmed) | -25 |
| suspected mutation | -100 |

Bands:

| Score | Confidence | Behavior |
| --- | --- | --- |
| `>=70` no hard risk | high | default candidate, verify required |
| `45-69` or explainable dynamic fields | medium | manual review |
| `20-44` | low | backup evidence only |
| `<20` or hard reject | rejected | hidden by default with reason |

> **Default-profile ceiling (v1).** Positive deltas are non-stacking (each at most once per candidate), so the pure-core positive sum is at most `60` — above `medium`'s `>=45` but below `high`'s `>=70`. Under the **default** ScoringProfile, the pure-core rank track alone caps a strong read endpoint at `medium`. `high` is reachable via the dashboard-be **dual-track** path (deterministic rule score + a capped semantic bonus, max +25, from the LLM's semanticSignals — see `09`/`13`), or via an operator-tuned ScoringProfile. The fixture corpus below asserts pure-core default-profile bands.

Hard rejects: mutation, confirmed third-party analytics, unparseable URL, missing method, confirmed static resource, pairing failed without response shape. The `-25` weak HTML/static-like delta applies only to *suspected* (not confirmed) cases; a confirmed static/analytics resource is a hard reject and overrides the profile.

These score deltas and band thresholds are the default `ScoringProfile` values (see `09`); the ranker loads them from validated config at runtime and must not inline them. Hard rejects are security/domain invariants that override the profile and are not configurable.

## Output

Each candidate includes a stable `id`, endpoint, score, confidence, reviewRequired, args, excludedParams, responseShape, stable `scoreExplanation`, risks and evidence ids. Candidates are produced by `POST /recorder/rank` and surfaced in that request's redacted result as `RankCandidate[]` (`adapter-recorder.bundle.json#/$defs/RankCandidate`); `POST /recorder/init` selects one by `selectedCandidateId`.

Only `id/endpoint/score/confidence/reviewRequired` are schema-required (always present). `args/excludedParams/responseShape/scoreExplanation/risks/evidenceIds` are conditionally present — e.g. a `rejected` candidate or a single-sample fallback may omit `args`/`responseShape` — so they are optional in the schema, not missing-by-error.

`scoreExplanation` item:

```json
{ "signal": "stable_json_shape", "delta": 25, "detail": "A/B item keys match" }
```

`signal` keys are stable and suitable for UI i18n mapping.

## Fixture Corpus

Required 10 fixtures:

| Fixture | Expected |
| --- | --- |
| `search-get-json-list` | low band (score 45 = stable_json 25 + seed_arg 20) under default profile; GET query endpoint, args mapped |
| `search-post-json-read` | manual review POST read-like endpoint |
| `signed-timestamp-endpoint` | excludes timestamp/nonce, risk on unexplained sign |
| `cursor-pagination` | separates search arg and pagination cursor |
| `auth-redirect` | no endpoint, auth/login risk |
| `mutation-post` | hard reject mutation |
| `analytics-noise` | tracking rejected |
| `missing-request-body` | no body args inferred, max medium |
| `pairing-failed-single-sample` | low confidence single sample |
| `insufficient-samples` | explicit error |

All fixtures assert candidate `id` (present, stable, unique within result, usable as `InitRequest.selectedCandidateId`), endpoint, args mapping, dynamic params, score band, reviewRequired, rejected reasons and scoreExplanation signals.
