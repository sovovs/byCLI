// In-process metrics registry (09 Metrics) — the single shared implementation.
// Counters + histograms (count/sum/min/max). Labels carry only non-sensitive enums
// (operation / status / errorCode); counts themselves hold no sensitive values
// (09: "Metrics must not contain sensitive values").
//
// Charter: pure in-memory counter, **no IO, no HTTP, no file writes** — same nature as
// transport-crypto, so it lives in recorder-core (02 boundaries). The HTTP `GET /metrics`
// scrape endpoint binds `IncomingMessage`/`http` and therefore stays in each transport
// layer (wrapper-server / be), NOT here. dashboard-be and the main-repo M9 wrapper both
// re-export `createMetrics` from this module so there is one implementation, no copy drift.

export interface HistogramStat { count: number; sum: number; min: number; max: number; }

export interface MetricsSnapshot {
  counters: Record<string, number>;
  histograms: Record<string, HistogramStat>;
}

export interface Metrics {
  /** Increment a counter; labels become a stable `name{k=v,...}` key (undefined labels dropped). */
  inc(name: string, labels?: Record<string, string | undefined>, by?: number): void;
  /** Observe a value into a histogram (count/sum/min/max). */
  observe(name: string, value: number): void;
  snapshot(): MetricsSnapshot;
}

function keyOf(name: string, labels?: Record<string, string | undefined>): string {
  if (!labels) return name;
  const parts = Object.keys(labels)
    .sort()
    .filter((k) => labels[k] !== undefined && labels[k] !== '')
    .map((k) => `${k}=${labels[k]}`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
}

export function createMetrics(): Metrics {
  const counters = new Map<string, number>();
  const histograms = new Map<string, HistogramStat>();

  return {
    inc(name, labels, by = 1) {
      const k = keyOf(name, labels);
      counters.set(k, (counters.get(k) ?? 0) + by);
    },
    observe(name, value) {
      const h = histograms.get(name);
      if (!h) histograms.set(name, { count: 1, sum: value, min: value, max: value });
      else {
        h.count += 1; h.sum += value;
        if (value < h.min) h.min = value;
        if (value > h.max) h.max = value;
      }
    },
    snapshot() {
      return {
        counters: Object.fromEntries(counters),
        histograms: Object.fromEntries([...histograms].map(([k, v]) => [k, { ...v }])),
      };
    },
  };
}
