/**
 * @sovovs/bycli-recorder-core — public API.
 *
 * Pure-domain Recorder Core Engine: canonical capture → normalize → pair → score → rank.
 * No IO, no HTTP, no file writes (02 architecture boundaries). Consumed by the main repo
 * and by dashboard-be (which may import this pure package without breaking the "no main-repo
 * src/ import" rule — this is a standalone domain package, not main-repo source).
 */

export { rankSamples } from './rank.js';
export { canonicalizeEntry, CANONICAL_SCORING_RAW_FIELDS, type RawNetworkEntry, type CanonicalResult } from './canonical.js';
export { normalizeEntry, buildArgMappings, resolveSeedParams, type NormalizedEntry } from './normalize.js';
export { pairSamples, type Pair, type PairingResult } from './pairing.js';
export { groupPairsByEndpoint, type EndpointGroup } from './aggregate.js';
export { scoreCandidate, type ScoreContext, type ScoreResult, type HardReject } from './score.js';
export {
  analyzeSite, detectAntiBot, classifyPattern, findNearestAdapter,
  type PageSignals, type AnalyzeReport, type AdapterRef,
  type AntiBotVerdict, type AntiBotVendor, type PatternVerdict, type Pattern, type NearestAdapter,
} from './analyze.js';
export {
  validateAdapterName, renderAdapterTemplate, buildProvenanceHeader, computeDryRunDiff,
  decideInitRecovery,
  type AdapterNameParts, type NameValidation, type AdapterTemplateInput,
  type ProvenanceInput, type DryRunDiff,
  type InitRecoveryAction, type InitRecoveryState,
} from './init.js';
export {
  deriveEvidenceSeedArgs, parseRunnerEvent, normalizeRunnerResult,
  validateRunnerConfig, buildRunnerArgs,
  type SeedArgEvidence, type RunnerStartedEvent, type RunnerProgressEvent,
  type RunnerResultEvent, type RunnerEvent, type ParseEventResult, type VerifySummary,
  type RunnerConfig, type RunnerConfigResult,
} from './verify.js';
export {
  resolveScoringProfile, resolveFeatureFlags, DEFAULT_FEATURE_FLAGS,
  validateTempCapacity, DEFAULT_TEMP_CAPACITY,
  RECORDING_MODES, DEFAULT_RECORDING_MODE,
  type FeatureFlags, type ConfigResolveError, type TempCapacity, type RecordingMode,
} from './config.js';
export { randomToken, safeEqual } from './transport-crypto.js';
export { type ErrorCode, type RecorderError } from './errors.js';
export { createMetrics, type Metrics, type MetricsSnapshot, type HistogramStat } from './metrics.js';
export {
  correlateTimeline,
  type RawAction, type RawNetEntry, type CorrelateOptions,
  type CorrelatedTimeline, type CorrelatedNetEntry, type TimelineAction,
} from './timeline.js';
export {
  createLogger,
  type Logger, type LogLevel, type LogFields, type LoggerOptions,
} from './logging.js';
export {
  DEFAULT_SCORING_PROFILE,
  validateScoringProfile,
  type ScoringProfile,
  type RankInput,
  type RankResult,
  type RankCandidate,
  type ParamObservation,
  type ParamUnionItem,
  type CaptureSample,
  type RecorderNetworkEntry,
  type SourceCompleteness,
  type EndpointDescriptor,
  type ArgMapping,
  type ResponseShape,
  type ScoreExplanationItem,
  type Confidence,
  type SampleName,
  type EvidenceSeedArg,
} from './types.js';
