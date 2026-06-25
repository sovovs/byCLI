// In-process metrics registry (M8c · 09 Metrics). The implementation moved to recorder-core
// (#3) — a pure in-memory counter, charter-legal (same nature as transport-crypto). This module
// re-exports it so dashboard-be consumers (server.ts) are unchanged and there is no copy drift
// with the M9 wrapper, which re-exports the same source. The HTTP `/metrics` scrape endpoint
// (binds http types) stays in the transport layer, never in core.
export {
  createMetrics,
  type Metrics,
  type MetricsSnapshot,
  type HistogramStat,
} from '@sovovs/bycli-recorder-core';
