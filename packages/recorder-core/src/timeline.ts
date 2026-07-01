/**
 * 因果时间线对齐(M-UI-3,纯函数,零 IO)。
 *
 * 把一次录制的「用户操作(user-action)」与「网络请求(network)」按因果关联起来:每条 network 标注
 * 是哪个 user-action **触发**的(triggeredBy)+ 置信度。喂 LLM 时模型看到的是「点搜索按钮 → 触发
 * GET /api/search → 响应 list」的因果链,而非一堆孤立请求(见 12 模块 B/F2)。
 *
 * 关联信号(Codex F2:别只靠时间窗):
 *  - **时间邻近**:action.ts ≤ entry.ts 且差 ≤ windowMs,取最近的前置 action。
 *  - **CDP initiator 类型**(权重):script(用户交互→JS fetch)最高;parser/preload(旁路:预取/解析
 *    插入/analytics)大幅降权;缺失给中性权重。→ 把 autosuggest/analytics/preload 错配压下去。
 *  - **frameId**:两侧都有时要求同 frame(user-action 暂未带 frameId,缺则跳过此约束)。
 *  - **frameSessionId**(OOPIF 跨源 iframe):标识事件来自哪个 CDP 子 session;顶层事件无此字段。
 *    归一成 `?? 'top'` 后**强相等**比较——iframe 内的 user-action 绝不关联到顶层(或别的 iframe)
 *    的请求,反之亦然(防错关联;弱版本「两侧都有才约束」会被顶层缺字段绕过)。
 * 所有字段都可缺失 → 优雅降级(只用现有信号)。action.ts / entry.ts 均为 wall-clock Date.now() ms,可比。
 */

export interface RawAction {
  ts?: number;
  type?: string;
  selector?: string;
  frameId?: string;
  /** OOPIF:user-action 来自的跨源 iframe 子 session(顶层 action 无此字段)。 */
  frameSessionId?: string;
}

export interface RawNetEntry {
  /** 抓包时刻(扩展 Date.now() ms,= NetworkCaptureEntry.timestamp)。 */
  timestamp?: number;
  method?: string;
  url?: string;
  pathname?: string;
  initiatorType?: string;
  frameId?: string;
  /** OOPIF:请求来自的跨源 iframe 子 session(顶层请求无此字段)。 */
  frameSessionId?: string;
}

export interface CorrelateOptions {
  /** action → 其触发的请求的最大时间跨度(ms)。默认 5s。 */
  windowMs?: number;
}

/** initiator 类型权重(0..1):script 最可能是用户交互触发;parser/preload 多为旁路。 */
const INITIATOR_WEIGHT: Record<string, number> = {
  script: 1,
  other: 0.6,
  parser: 0.25,
  preload: 0.1,
  preflight: 0.1,
  signedexchange: 0.2,
};
const DEFAULT_INITIATOR_WEIGHT = 0.7; // initiatorType 缺失(旧扩展/未知)→ 中性

export interface CorrelatedNetEntry {
  index: number;
  ts: number | null;
  method?: string;
  pathname?: string;
  /** 触发它的 action id(`act_<i>`),无则 null。 */
  triggeredBy: string | null;
  /** 0..1;越高越确信这条是该 action 触发的数据请求。 */
  confidence: number;
}

export interface TimelineAction {
  id: string;
  ts: number | null;
  type?: string;
  selector?: string;
}

export interface CorrelatedTimeline {
  actions: TimelineAction[];
  entries: CorrelatedNetEntry[];
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 把 (actions, entries) 关联成因果时间线。纯函数,不改入参。 */
export function correlateTimeline(
  actions: RawAction[],
  entries: RawNetEntry[],
  opts: CorrelateOptions = {},
): CorrelatedTimeline {
  const windowMs = opts.windowMs ?? 5000;
  const acts: TimelineAction[] = actions.map((a, i) => ({
    id: `act_${i}`,
    ts: numOrNull(a.ts),
    type: a.type,
    selector: a.selector,
  }));
  // 带原始 frameId 的索引(用于 frame 约束)。
  const actFrame = actions.map((a) => (typeof a.frameId === 'string' ? a.frameId : undefined));
  // OOPIF 子 session 归一(顶层 = 'top'):强相等约束,防 iframe 内操作错关联到顶层请求。
  const actFrameSession = actions.map((a) => (typeof a.frameSessionId === 'string' ? a.frameSessionId : 'top'));

  const out: CorrelatedNetEntry[] = entries.map((e, index) => {
    const ts = numOrNull(e.timestamp);
    const base: CorrelatedNetEntry = { index, ts, method: e.method, pathname: e.pathname, triggeredBy: null, confidence: 0 };
    if (ts === null) return base;
    const entryFrameSession = typeof e.frameSessionId === 'string' ? e.frameSessionId : 'top';

    let best: { id: string; confidence: number } | null = null;
    for (let i = 0; i < acts.length; i++) {
      const a = acts[i];
      if (a.ts === null) continue;
      const dt = ts - a.ts;
      if (dt < 0 || dt > windowMs) continue; // 只认前置且在窗口内
      // OOPIF 强约束:归一后 frame session 必须相等(顶层↔顶层、同一 iframe↔同一 iframe)。
      if (entryFrameSession !== actFrameSession[i]) continue;
      // 同 frame 约束(两侧都有 frameId 才生效)
      if (e.frameId && actFrame[i] && e.frameId !== actFrame[i]) continue;
      const proximity = 1 - dt / windowMs; // 越近越高(0..1)
      const initWeight = e.initiatorType ? (INITIATOR_WEIGHT[e.initiatorType] ?? DEFAULT_INITIATOR_WEIGHT) : DEFAULT_INITIATOR_WEIGHT;
      const confidence = proximity * initWeight;
      // 取置信度最高;并列时取更近(后出现的 action,i 更大 = 更近,因 actions 按时间序)
      if (!best || confidence >= best.confidence) best = { id: a.id, confidence };
    }
    if (best && best.confidence > 0) {
      base.triggeredBy = best.id;
      base.confidence = Math.round(best.confidence * 1000) / 1000;
    }
    return base;
  });

  return { actions: acts, entries: out };
}
