// M9 High-Level HTTP wrapper —— 进程内 metrics(09 Metrics)。计数器 + 直方图(count/sum/min/max)。
// 标签只放非敏感 enum(operation/status/errorCode);counts 无敏感值(09:"Metrics must not contain
// sensitive values")。形态 copy-port 自 dashboard-be/src/metrics.ts —— 当前自包含(不碰 be、不碰
// recorder-core),因 Q2 改良A 的 be 迁移仍待 Codex 复核,不把 be 迁移面再扩大。
// ⏳ FOLLOW-UP(随 Q2 Codex 复核):若 改良A 获确认,把 be+wrapper 的 metrics 一并抽进 recorder-core
// (纯数据、合 charter)消除这份副本 drift。
export interface HistogramStat {
  count: number;
  sum: number;
  min: number;
  max: number;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  histograms: Record<string, HistogramStat>;
}

export interface Metrics {
  /** 计数器自增;labels 折成稳定 `name{k=v,...}` 键(undefined/空 label 丢弃)。 */
  inc(name: string, labels?: Record<string, string | undefined>, by?: number): void;
  /** 观测一个值进直方图(count/sum/min/max)。 */
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
        h.count += 1;
        h.sum += value;
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
