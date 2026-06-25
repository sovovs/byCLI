// M9 High-Level HTTP wrapper —— 进程内 metrics(09 Metrics)。实现已抽进 recorder-core(#3,Q2 改良A
// 原则下:纯内存计数器、零 IO/HTTP,合 charter,与 transport-crypto 同构)——这里 re-export,消除原
// copy-port 自 dashboard-be 的副本 drift(be 同样 re-export 同一源)。GET /metrics scrape 端点(绑 http
// 类型)仍留 wrapper 传输层(wrapper-server.ts),不进 core。
export {
  createMetrics,
  type Metrics,
  type MetricsSnapshot,
  type HistogramStat,
} from '@sovovs/bycli-recorder-core';
