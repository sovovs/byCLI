/**
 * `browser analyze <url>` — site-recon classification.
 *
 * The pure analysis logic moved to the shared package `@sovovs/bycli-recorder-core`
 * (M5a, same pure-domain split as rank/M4) so dashboard-be can reuse it too. This
 * module re-exports it so existing main-repo importers (cli.ts, the high-level
 * analyze module) are unchanged. The CLI wrapper drives a real page, feeds the
 * resulting PageSignals here, and prints the verdict.
 *
 * Note: the package types the registry as a structural `AdapterRef` ({site,name,
 * domain?}); the main-repo `CliCommand` is assignable to it, so callers can keep
 * passing `getRegistry()` (Map<string, CliCommand>) unchanged.
 */

export {
  analyzeSite,
  detectAntiBot,
  classifyPattern,
  findNearestAdapter,
  type PageSignals,
  type AnalyzeReport,
  type AntiBotVerdict,
  type AntiBotVendor,
  type PatternVerdict,
  type Pattern,
  type NearestAdapter,
} from '@sovovs/bycli-recorder-core';
