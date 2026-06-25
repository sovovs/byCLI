// 进程内 metrics 注册表(M8c · 09 Metrics)。计数器 + 直方图(count/sum/min/max)。
// 标签只放非敏感 enum(operation / status / errorCode);counts 本身无敏感值(09:"Metrics must
// not contain sensitive values")。无外部依赖、无 HTTP 暴露面 —— snapshot() 供测试/信号 dump,
// 未来 /metrics loopback 端点属 M9(可选 HTTP wrapper)。

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
