// LLM 合成(MVP):把选定候选 + A/B 真实请求/响应 + 页面截图喂 Claude,产出可执行的 adapter
// `func` 体与 `columns`。这是 init 模板留白(func: return [] / columns: [])的填充器。
//
// feature-gated:无 RECORDER_LLM_API_KEY / 关闭 / 调用失败 → synthesize 返回 null,调用方退回空模板
// (行为与现状字节级一致)。客户端可注入(测试用 fake),生产用真 @anthropic-ai/sdk。
//
// 安全:LLM 生成的 funcBody 是「代码注入」,刻意打破 init 的 no-raw-user-code 约束。缓解靠
// ① verify-runner 子进程隔离执行 ② 前端 dry-run 人工审阅关卡 ③ provenance 标注 AI 生成。
import Anthropic from '@anthropic-ai/sdk';
import { correlateTimeline, type RawAction, type RawNetEntry, type RankCandidate } from '@sovovs/bycli-recorder-core';
import { buildMergedResponseSummary, type ResponseSummary } from './responseSummary.js';

export interface SynthesisSample {
  sampleName: 'A' | 'B';
  /** 原始 daemon network entries(含 responsePreview 真实响应体),非 rank 用的脱敏版。 */
  entries: unknown[];
  /** 录制结束时抓的页面截图 base64(jpeg),可选。 */
  screenshot?: string;
  /** M-UI-4:用户操作事件(click/input/...,user-action 轨),用于因果时间线。 */
  actions?: unknown[];
}

export interface SynthesisInput {
  candidate: RankCandidate;
  samples: SynthesisSample[];
}

export interface SynthesisColumn {
  name: string;
  path: string;
  type: string;
}

export interface SynthesisResult {
  /** `async (kwargs) => { ... }` 的**函数体**(不含签名/包裹),由模板插入。 */
  funcBody: string;
  columns: SynthesisColumn[];
  description: string;
  access: 'read' | 'write';
}

/** 最小客户端接缝:便于测试注入 fake,不绑定完整 SDK 类型(0.106 的 output_config 类型未必齐)。 */
export interface LlmClient {
  messages: {
    // usage/stop_reason:Anthropic 兼容网关通常回传,用于诊断输出瓶颈(stop_reason='max_tokens' → 输出打满)。
    // 可选,不保证有(不同网关差异);诊断代码需 optional 读取。
    create(params: Record<string, unknown>): Promise<{
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
    }>;
  };
}

export interface Synthesizer {
  synthesize(input: SynthesisInput): Promise<SynthesisResult | null>;
}

/**
 * 从模型回复里抽出 JSON 对象(可移植:不依赖 output_config structured-output —— 第三方 Anthropic 兼容
 * 网关多不支持)。剥 ```json``` 围栏 + 取首个 `{` 到末个 `}`,失败返回 null。
 */
/** 共享:建 Anthropic client（authToken:null 隔离 ANTHROPIC_AUTH_TOKEN）；无 key 且无注入 → null。
 *  timeoutMs:单次调用超时(默认 180s,由 be config RECORDER_LLM_TIMEOUT_MS 注入)。SDK 默认 600s+2 retries,
 *  第三方兼容网关偶发高延迟会把调用挂满 10min 再抛(实测 rank 618s)→ 静默退回规则分误导用户;显式收窄 +
 *  maxRetries:1(默认 2 成倍放大挂起时长)让它快速失败。注入 client(测试)不受影响。 */
export function makeLlmClient(opts: { apiKey?: string; baseURL?: string; client?: LlmClient; timeoutMs?: number }): LlmClient | null {
  const timeout = opts.timeoutMs ?? 180_000;
  return (
    opts.client ??
    (opts.apiKey
      ? (new Anthropic({ apiKey: opts.apiKey, authToken: null, timeout, maxRetries: 1, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) }) as unknown as LlmClient)
      : null)
  );
}

export function extractJson(text: string): string | null {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence && fence[1]) ? fence[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return body.slice(start, end + 1);
}

interface RawEntry {
  method?: unknown;
  url?: unknown;
  responseStatus?: unknown;
  responsePreview?: unknown;
  timestamp?: unknown;
  initiatorType?: unknown;
  frameId?: unknown;
  frameSessionId?: unknown;
  frameUrl?: unknown;
}
interface RawUiAction {
  type?: unknown;
  selector?: unknown;
  ts?: unknown;
  valueShape?: unknown;
  text?: unknown;
  key?: unknown;
  frameId?: unknown;
  frameSessionId?: unknown;
  frameUrl?: unknown;
  url?: unknown; // type==='navigate' 的页面 URL(已脱敏)
}

const MAX_ACTIONS_PER_SAMPLE = 50; // 裁剪:操作序列上限(Codex F2 token 预算)
const MAX_NAVS_PER_SAMPLE = 30; // 裁剪:导航序列上限
// 证据去重(14-plan 第2步):core 已按 endpoint(method+host+pathname)聚拢,buildSampleSummary 又精确匹配
// 同 endpoint 的调用,组内成员的 responseBody 高度相似且体量大。只保留少数代表响应体(够判「参数变化→响应变化」
// 的 seed 证据即可),其余 endpointCall 仍列出但不带 responseBody —— 省 token 又不丢 seed 判定依据。
const MAX_RESPONSE_BODIES_PER_SAMPLE = 3;
const MAX_RESPONSE_BODY_LEN = 4000;

/**
 * 精确匹配:把候选 endpoint 与一条 raw network entry 比对(14-plan 第2步,Codex High 3)。
 * 解析 entry.url 后按 method + host + pathname 精确比对(host 仅在候选带 host 时校验);
 * URL 解析失败才回退到旧的 pathname 子串匹配。避免「同 path 不同 host / GET vs POST /
 * `/api/article` 误召回 `/api/articles`」—— 聚拢后这类污染会被放大。
 */
function entryMatchesEndpoint(
  rawMethod: unknown,
  url: string,
  ep: { method?: string; host?: string; pathname?: string } | undefined,
): boolean {
  const pathname = ep?.pathname;
  if (!pathname) return true; // 无 endpoint 约束 → 不过滤(保持旧行为)
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed) return url.includes(pathname); // 解析失败 → 子串兜底
  if (parsed.pathname !== pathname) return false;
  if (ep?.method && typeof rawMethod === 'string' && rawMethod.toUpperCase() !== ep.method.toUpperCase()) return false;
  if (ep?.host && parsed.host !== ep.host) return false;
  return true;
}

/**
 * 收集一个候选 endpoint(method+host+pathname 精确匹配)的组内调用响应体,供 buildMergedResponseSummary 做
 * bounded-union。core 已按 endpoint 聚拢 → 组内多次调用(type=hot vs new / 不同 category_id/sort)返回**互补**
 * 字段;合并才能让 columns 覆盖全字段。跨所有 sample 收集,每条带 status + query-param 签名(去重用:同参重复
 * 折叠、不同参保留)。WebSocket(kind='cdp-websocket')排除。有界:最多 limit 条(默认 6,合并器再各自设上限)。
 */
export function collectEndpointResponseBodies(
  samples: SynthesisSample[],
  candidate: RankCandidate,
  limit = 6,
): Array<{ body: string; status?: number; paramSig?: string }> {
  const ep = candidate.endpoint;
  const out: Array<{ body: string; status?: number; paramSig?: string }> = [];
  for (const sample of samples) {
    const entries = ((sample.entries ?? []) as RawEntry[]).filter(
      (e) => (e as { kind?: string }).kind !== 'cdp-websocket',
    );
    for (const e of entries) {
      if (out.length >= limit) return out;
      const url = typeof e.url === 'string' ? e.url : '';
      if (!entryMatchesEndpoint(e.method, url, ep)) continue;
      if (typeof e.responsePreview !== 'string') continue;
      out.push({
        body: e.responsePreview,
        status: typeof e.responseStatus === 'number' ? e.responseStatus : undefined,
        paramSig: paramSignature(url),
      });
    }
  }
  return out;
}

/** query-param 去重签名:排序后的 key=value 串(去 origin);解析失败 → undefined(合并器按结构签名兜底)。 */
function paramSignature(url: string): string | undefined {
  try {
    const u = new URL(url);
    const pairs = [...u.searchParams.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return pairs.map(([k, v]) => `${k}=${v}`).join('&');
  } catch {
    return undefined;
  }
}

/**
 * 把一个样本组织成「因果时间线摘要」:用户操作序列 + 与候选 endpoint 同 path 的请求(标 triggeredBy)。
 * 用 correlateTimeline 把 network 关联到触发它的操作(ts 邻近 × initiator 权重),让模型看到因果链。
 *
 * 现仅 createSynthesizer(handleInit 单候选 LLM 合成路径)在用;score/generate 两侧已分别迁到
 * buildScoreEvidenceSummary / buildGenerateEvidenceSummary(prompt 压缩,不再喂原始响应体)。 */
export function buildSampleSummary(sample: SynthesisSample, candidate: RankCandidate): Record<string, unknown> {
  // WebSocket(kind='cdp-websocket')不参与 endpoint 因果合成(Pattern E,无端点语义)。
  const entries = ((sample.entries ?? []) as RawEntry[]).filter(
    (e) => (e as { kind?: string }).kind !== 'cdp-websocket',
  );
  const rawActions = (sample.actions ?? []) as RawUiAction[];
  // 拆分:导航(URL 变化)单列;点击/输入等交互进因果时间线。
  const navigations = rawActions.filter((a) => a.type === 'navigate');
  const interactions = rawActions.filter((a) => a.type !== 'navigate');
  // correlate 需要的精简形状
  const corrActions: RawAction[] = interactions.map((a) => ({
    ts: typeof a.ts === 'number' ? a.ts : undefined,
    type: typeof a.type === 'string' ? a.type : undefined,
    selector: typeof a.selector === 'string' ? a.selector : undefined,
    frameId: typeof a.frameId === 'string' ? a.frameId : undefined,
    frameSessionId: typeof a.frameSessionId === 'string' ? a.frameSessionId : undefined,
  }));
  const corrEntries: RawNetEntry[] = entries.map((e) => ({
    timestamp: typeof e.timestamp === 'number' ? e.timestamp : undefined,
    method: typeof e.method === 'string' ? e.method : undefined,
    url: typeof e.url === 'string' ? e.url : undefined,
    initiatorType: typeof e.initiatorType === 'string' ? e.initiatorType : undefined,
    frameId: typeof e.frameId === 'string' ? e.frameId : undefined,
    frameSessionId: typeof e.frameSessionId === 'string' ? e.frameSessionId : undefined,
  }));
  const corr = correlateTimeline(corrActions, corrEntries);
  const actionLabel = (id: string | null): string | null => {
    if (!id) return null;
    const a = corr.actions.find((x) => x.id === id);
    return a ? `${a.id}:${a.type ?? '?'} ${a.selector ?? ''}`.trim() : id;
  };

  // 用户操作序列(带 valueShape/text/key,裁剪上限)
  const actionSeq = corr.actions.slice(0, MAX_ACTIONS_PER_SAMPLE).map((a, i) => {
    const raw = interactions[i] ?? {};
    return {
      id: a.id, type: a.type, selector: a.selector,
      ...(raw.valueShape ? { valueShape: raw.valueShape } : {}),
      ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
      ...(typeof raw.key === 'string' ? { key: raw.key } : {}),
      ...(typeof raw.frameUrl === 'string' ? { frameUrl: raw.frameUrl } : {}), // OOPIF:操作所在 iframe 来源
    };
  });

  // 页面 URL 序列(地址栏/SPA 路由变化):A/B 对照可暴露 seed 藏在 URL 参数里(SSR/页面驱动的关键信号)。
  const navSeq = navigations
    .slice(0, MAX_NAVS_PER_SAMPLE)
    .map((n) => ({ ts: typeof n.ts === 'number' ? n.ts : undefined, url: typeof n.url === 'string' ? n.url : undefined }))
    .filter((n): n is { ts: number | undefined; url: string } => !!n.url);

  // 与候选 endpoint 精确匹配(method+host+pathname)的请求 + 因果标注(只留候选相关,裁掉旁路 —— Codex F2)。
  // 14-plan 第2步:不再用 pathname 子串当主路径(同 path 不同 host / GET vs POST / `/api/article`
  // 误召回 `/api/articles` 会在聚拢后污染),解析失败才回退子串。
  const ep = candidate.endpoint;
  let bodiesKept = 0;
  const endpointCalls: Array<Record<string, unknown>> = [];
  entries.forEach((e, i) => {
    const url = typeof e.url === 'string' ? e.url : '';
    if (!entryMatchesEndpoint(e.method, url, ep)) return;
    const c = corr.entries[i];
    // 证据去重:同 endpoint 已聚拢,只保留前 N 条响应体(够判 seed→响应变化),其余省略 responseBody。
    const rawBody = typeof e.responsePreview === 'string' ? e.responsePreview : undefined;
    const keepBody = rawBody !== undefined && bodiesKept < MAX_RESPONSE_BODIES_PER_SAMPLE;
    if (keepBody) bodiesKept += 1;
    endpointCalls.push({
      method: e.method,
      url,
      status: e.responseStatus,
      ...(keepBody ? { responseBody: rawBody!.slice(0, MAX_RESPONSE_BODY_LEN) } : {}),
      triggeredBy: actionLabel(c?.triggeredBy ?? null),
      triggerConfidence: c?.confidence,
      ...(typeof e.frameUrl === 'string' ? { frameUrl: e.frameUrl } : {}), // OOPIF:请求所在 iframe 来源
    });
  });

  return { sample: sample.sampleName, navigations: navSeq, actions: actionSeq, endpointCalls };
}

// ── score 侧证据裁剪上限(prompt 压缩,第1步)──
// score 阶段只判「接口是不是数据命令」,不需要原始响应体/完整 URL/长操作序列。极致收窄:
const SCORE_MAX_NAVS = 3;        // A/B 差异导航,末 ≤3 条
const SCORE_MAX_ACTIONS = 5;     // endpoint 调用附近末 ≤5 个操作
const SCORE_MAX_QUERY_VAL_LEN = 40; // 导航 query value 截断
// (SCORE_MAX_SELECTOR_LEN 已删:score 侧 actions 不再带 selector,见 buildScoreEvidenceSummary)

/** 只留 path+query(去 origin),query value 截断 —— 供 score 侧导航序列。 */
function stripToPathQuery(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const params = [...u.searchParams.entries()]
      .map(([k, v]) => `${k}=${v.length > SCORE_MAX_QUERY_VAL_LEN ? v.slice(0, SCORE_MAX_QUERY_VAL_LEN) + '…' : v}`)
      .join('&');
    return params ? `${u.pathname}?${params}` : u.pathname;
  } catch {
    // 相对 URL / 解析失败:整体截断兜底(不喂超长串)。
    return url.length > 200 ? url.slice(0, 200) + '…' : url;
  }
}

/** 解析 URL query 成对象(供 endpointCalls.urlParams,替代重复整条 URL 字符串)。 */
function parseUrlParams(url: string): Record<string, string> {
  try {
    const u = new URL(url);
    const out: Record<string, string> = {};
    for (const [k, v] of u.searchParams.entries()) {
      out[k] = v.length > SCORE_MAX_QUERY_VAL_LEN ? v.slice(0, SCORE_MAX_QUERY_VAL_LEN) + '…' : v;
    }
    return out;
  } catch {
    return {};
  }
}

/** score 侧证据条形状(供 budget gate 逐级降级操作)。 */
export interface ScoreEvidence {
  sample: 'A' | 'B';
  navigations: string[];
  actions: Array<{ type?: string; selector?: string; valueShape?: unknown; key?: string }>;
  endpointCalls: Array<{ urlParams: Record<string, string>; status?: unknown; triggeredBy: string | null }>;
  /** endpoint 组内多次调用 bounded-union 合并的响应结构摘要(每 endpoint 一份;覆盖组内互补字段)。 */
  responseSummary?: ResponseSummary;
}

/**
 * score 侧证据摘要(prompt 压缩,第1步):替代 buildSampleSummary 在 score.ts 的用法。
 *
 * 与 buildSampleSummary(generate 侧,仍喂原始 responseBody)的关键区别:
 * - navigations:只 path+query(去 origin)、末 ≤3、query value 截断 ~40 字符。
 * - actions:endpoint 附近末 ≤5,selector 截断 ≤60,留 type/valueShape/key。
 * - endpointCalls:**无 responseBody**,改 `{ urlParams(解析 query), status, triggeredBy }`,不重复整条 URL。
 * - responseSummary:对该 endpoint 的**代表调用**(首条匹配)跑 buildResponseSummary(rawBody,'score'),
 *   每 endpoint 只出一份(core 已按 endpoint 聚拢,无需每 call 重复)。
 */
export function buildScoreEvidenceSummary(sample: SynthesisSample, candidate: RankCandidate): ScoreEvidence {
  const entries = ((sample.entries ?? []) as RawEntry[]).filter(
    (e) => (e as { kind?: string }).kind !== 'cdp-websocket',
  );
  const rawActions = (sample.actions ?? []) as RawUiAction[];
  const navigations = rawActions.filter((a) => a.type === 'navigate');
  const interactions = rawActions.filter((a) => a.type !== 'navigate');

  const corrActions: RawAction[] = interactions.map((a) => ({
    ts: typeof a.ts === 'number' ? a.ts : undefined,
    type: typeof a.type === 'string' ? a.type : undefined,
    selector: typeof a.selector === 'string' ? a.selector : undefined,
    frameId: typeof a.frameId === 'string' ? a.frameId : undefined,
    frameSessionId: typeof a.frameSessionId === 'string' ? a.frameSessionId : undefined,
  }));
  const corrEntries: RawNetEntry[] = entries.map((e) => ({
    timestamp: typeof e.timestamp === 'number' ? e.timestamp : undefined,
    method: typeof e.method === 'string' ? e.method : undefined,
    url: typeof e.url === 'string' ? e.url : undefined,
    initiatorType: typeof e.initiatorType === 'string' ? e.initiatorType : undefined,
    frameId: typeof e.frameId === 'string' ? e.frameId : undefined,
    frameSessionId: typeof e.frameSessionId === 'string' ? e.frameSessionId : undefined,
  }));
  const corr = correlateTimeline(corrActions, corrEntries);
  const actionLabel = (id: string | null): string | null => {
    if (!id) return null;
    const a = corr.actions.find((x) => x.id === id);
    return a ? `${a.id}:${a.type ?? '?'}`.trim() : id;
  };

  // 导航:path+query(去 origin),末 ≤3。
  const navSeq = navigations
    .map((n) => stripToPathQuery(typeof n.url === 'string' ? n.url : undefined))
    .filter((u): u is string => !!u)
    .slice(-SCORE_MAX_NAVS);

  // 操作:末 ≤5(靠近 endpoint 调用的最近操作)。**不带 selector**(15-doc 阶段二 #1):CSS selector 对
  // score 阶段 LLM 判信号完全无用(seed 判定靠 A/B urlParams/navigations 差异,非 CSS 路径),是纯冗余大头。
  // generate 侧 PROMPT_B 也不引用 selector(靠 responseSchema/paramUnion 写脚本),故两侧都砍。
  // 只留 type/valueShape/key —— valueShape.len 承载 A/B 输入长度差异(seed 线索),key 承载 Enter 等提交语义。
  const actionSeq = corr.actions.slice(-SCORE_MAX_ACTIONS).map((a) => {
    const idx = corr.actions.findIndex((x) => x.id === a.id);
    const raw = idx >= 0 ? interactions[idx] ?? {} : {};
    return {
      ...(a.type ? { type: a.type } : {}),
      ...(raw.valueShape ? { valueShape: raw.valueShape } : {}),
      ...(typeof raw.key === 'string' ? { key: raw.key } : {}),
    };
  });

  // endpoint 匹配调用:无 responseBody,只 urlParams/status/triggeredBy。
  // responseSummary:对该 endpoint group 的**多次调用**做 bounded-union 合并(覆盖组内互补字段),而非单代表体。
  //
  // 15-doc 阶段二 #2:urlParams 只留**证明性键**(省重复)。paramObservations(TOON)已覆盖每参数的名字 +
  // observedVariation + 命中标志,urlParams 再列**证实稳定(observedVariation=false)**常量的值是纯重复
  // (那些值对判 seed 映射/分页无证明力)。保守规则:**只删 observedVariation===false 的键**;保留
  //   - true(A/B 值不同 = seed 映射证据,LLM 要看到 apple/java 差异)
  //   - 'unknown'(判不准,不敢删)
  //   - cursorLike(分页证据,要看到 cursor=0 vs 20_... 差异)
  //   - 不在 paramObservations 里的键(无从判断稳定性)
  // 这样 seed_arg_maps_to_param / pagination_supported / response_varies_with_seed 的证明值都保留。
  const obsByName = new Map<string, { observedVariation?: unknown; cursorLike?: unknown }>();
  for (const p of (candidate.paramObservations ?? []) as unknown as Array<Record<string, unknown>>) {
    if (typeof p.name === 'string') obsByName.set(p.name, { observedVariation: p.observedVariation, cursorLike: p.cursorLike });
  }
  const keepProofParams = (params: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      const o = obsByName.get(k);
      // 只删「明确稳定(observedVariation===false)且非 cursor」的常量键;其余一律保留。
      if (o && o.observedVariation === false && !o.cursorLike) continue;
      out[k] = v;
    }
    return out;
  };
  const ep = candidate.endpoint;
  const endpointCalls: ScoreEvidence['endpointCalls'] = [];
  entries.forEach((e, i) => {
    const url = typeof e.url === 'string' ? e.url : '';
    if (!entryMatchesEndpoint(e.method, url, ep)) return;
    const c = corr.entries[i];
    endpointCalls.push({
      urlParams: keepProofParams(parseUrlParams(url)),
      status: e.responseStatus,
      triggeredBy: actionLabel(c?.triggeredBy ?? null),
    });
  });
  const bodies = collectEndpointResponseBodies([sample], candidate);
  const responseSummary: ResponseSummary | undefined = bodies.length
    ? buildMergedResponseSummary(bodies, 'score')
    : undefined;

  return {
    sample: sample.sampleName,
    navigations: navSeq,
    actions: actionSeq,
    endpointCalls,
    ...(responseSummary ? { responseSummary } : {}),
  };
}

// ── generate 侧证据裁剪上限(prompt 压缩,第2步)──
// generate 阶段要**写抽取代码**,比 score 需要更多结构(样本值/itemFields),但仍不喂原始响应体
// (Cloudflare 120s 同因)。改喂 buildResponseSummary(rawBody,'generate')的详细 schema。
const GEN_MAX_NAVS = 5;         // A/B 差异导航,末 ≤5 条(比 score 的 3 略多,给参数映射更多线索)
const GEN_MAX_ACTIONS = 5;      // endpoint 调用附近末 ≤5 个操作
const GEN_MAX_QUERY_VAL_LEN = 40;
const GEN_MAX_SELECTOR_LEN = 60;

/** generate 侧证据条形状(供 budget gate 逐级降级操作)。 */
export interface GenerateEvidence {
  sample: 'A' | 'B';
  navigations: string[];
  actions: Array<{ type?: string; selector?: string; valueShape?: unknown; key?: string }>;
  endpointCalls: Array<{ urlParams: Record<string, string>; status?: unknown; triggeredBy: string | null }>;
  /** endpoint 组内多次调用 bounded-union 合并的**详细**响应 schema(带样本值 + 类型并集 itemFields + 覆盖率 + recommendedColumns)。 */
  responseSchema?: ResponseSummary;
}

/** 只留 path+query(去 origin),query value 截断 —— 供 generate 侧导航序列。 */
function genStripToPathQuery(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const params = [...u.searchParams.entries()]
      .map(([k, v]) => `${k}=${v.length > GEN_MAX_QUERY_VAL_LEN ? v.slice(0, GEN_MAX_QUERY_VAL_LEN) + '…' : v}`)
      .join('&');
    return params ? `${u.pathname}?${params}` : u.pathname;
  } catch {
    return url.length > 200 ? url.slice(0, 200) + '…' : url;
  }
}

/** 解析 URL query 成对象(供 generate 侧 endpointCalls.urlParams)。 */
function genParseUrlParams(url: string): Record<string, string> {
  try {
    const u = new URL(url);
    const out: Record<string, string> = {};
    for (const [k, v] of u.searchParams.entries()) {
      out[k] = v.length > GEN_MAX_QUERY_VAL_LEN ? v.slice(0, GEN_MAX_QUERY_VAL_LEN) + '…' : v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * generate 侧证据摘要(prompt 压缩,第2步):替代 buildSampleSummary 在 generate.ts 的用法。
 *
 * 与 buildScoreEvidenceSummary(score 侧)的关键区别:generate 要**写抽取代码**,故:
 * - responseSchema:对该 endpoint 的**代表调用**跑 buildResponseSummary(rawBody,'generate') —— 详细 schema
 *   (wrappers/arrays/itemFields/recommendedRowPath/recommendedColumns + 样本值),而非 score 的浅摘要。
 * - endpointCalls:仍**无 responseBody**(原始体只在 verify-repair 才注入),只 urlParams/status/triggeredBy。
 * - navigations:path+query(去 origin)、末 ≤5;actions:末 ≤5,selector 截断 ≤60。
 * 每 endpoint 只出一份 schema(core 已按 endpoint 聚拢)。
 * opts.schema 可透传给 buildResponseSummary(budget gate 降级 field paths / sample str)。
 */
export function buildGenerateEvidenceSummary(
  sample: SynthesisSample,
  candidate: RankCandidate,
  opts?: { schema?: { maxFieldPaths?: number; maxSampleStr?: number } },
): GenerateEvidence {
  const entries = ((sample.entries ?? []) as RawEntry[]).filter(
    (e) => (e as { kind?: string }).kind !== 'cdp-websocket',
  );
  const rawActions = (sample.actions ?? []) as RawUiAction[];
  const navigations = rawActions.filter((a) => a.type === 'navigate');
  const interactions = rawActions.filter((a) => a.type !== 'navigate');

  const corrActions: RawAction[] = interactions.map((a) => ({
    ts: typeof a.ts === 'number' ? a.ts : undefined,
    type: typeof a.type === 'string' ? a.type : undefined,
    selector: typeof a.selector === 'string' ? a.selector : undefined,
    frameId: typeof a.frameId === 'string' ? a.frameId : undefined,
    frameSessionId: typeof a.frameSessionId === 'string' ? a.frameSessionId : undefined,
  }));
  const corrEntries: RawNetEntry[] = entries.map((e) => ({
    timestamp: typeof e.timestamp === 'number' ? e.timestamp : undefined,
    method: typeof e.method === 'string' ? e.method : undefined,
    url: typeof e.url === 'string' ? e.url : undefined,
    initiatorType: typeof e.initiatorType === 'string' ? e.initiatorType : undefined,
    frameId: typeof e.frameId === 'string' ? e.frameId : undefined,
    frameSessionId: typeof e.frameSessionId === 'string' ? e.frameSessionId : undefined,
  }));
  const corr = correlateTimeline(corrActions, corrEntries);
  const actionLabel = (id: string | null): string | null => {
    if (!id) return null;
    const a = corr.actions.find((x) => x.id === id);
    return a ? `${a.id}:${a.type ?? '?'}`.trim() : id;
  };

  // 导航:path+query(去 origin),末 ≤5。
  const navSeq = navigations
    .map((n) => genStripToPathQuery(typeof n.url === 'string' ? n.url : undefined))
    .filter((u): u is string => !!u)
    .slice(-GEN_MAX_NAVS);

  // 操作:末 ≤5,selector 截断。
  const actionSeq = corr.actions.slice(-GEN_MAX_ACTIONS).map((a) => {
    const idx = corr.actions.findIndex((x) => x.id === a.id);
    const raw = idx >= 0 ? interactions[idx] ?? {} : {};
    const selector = typeof a.selector === 'string' && a.selector.length > GEN_MAX_SELECTOR_LEN
      ? a.selector.slice(0, GEN_MAX_SELECTOR_LEN) + '…'
      : a.selector;
    return {
      ...(a.type ? { type: a.type } : {}),
      ...(selector ? { selector } : {}),
      ...(raw.valueShape ? { valueShape: raw.valueShape } : {}),
      ...(typeof raw.key === 'string' ? { key: raw.key } : {}),
    };
  });

  // endpoint 匹配调用:无 responseBody,只 urlParams/status/triggeredBy。
  // responseSchema:对该 endpoint group 的**多次调用**做 bounded-union 合并(覆盖组内互补字段 → columns 覆盖全字段)。
  const ep = candidate.endpoint;
  const endpointCalls: GenerateEvidence['endpointCalls'] = [];
  entries.forEach((e, i) => {
    const url = typeof e.url === 'string' ? e.url : '';
    if (!entryMatchesEndpoint(e.method, url, ep)) return;
    const c = corr.entries[i];
    endpointCalls.push({
      urlParams: genParseUrlParams(url),
      status: e.responseStatus,
      triggeredBy: actionLabel(c?.triggeredBy ?? null),
    });
  });
  const bodies = collectEndpointResponseBodies([sample], candidate);
  const responseSchema: ResponseSummary | undefined = bodies.length
    ? buildMergedResponseSummary(bodies, 'generate', opts?.schema)
    : undefined;

  return {
    sample: sample.sampleName,
    navigations: navSeq,
    actions: actionSeq,
    endpointCalls,
    ...(responseSchema ? { responseSchema } : {}),
  };
}

/** 取候选代表调用的原始响应体(供 verify-repair 抽 row 样本)。首条与 endpoint 匹配且带 responsePreview 的。 */
export function findRepresentativeRawBody(samples: SynthesisSample[], candidate: RankCandidate): string | undefined {
  const ep = candidate.endpoint;
  for (const sample of samples) {
    const entries = ((sample.entries ?? []) as RawEntry[]).filter(
      (e) => (e as { kind?: string }).kind !== 'cdp-websocket',
    );
    for (const e of entries) {
      const url = typeof e.url === 'string' ? e.url : '';
      if (!entryMatchesEndpoint(e.method, url, ep)) continue;
      if (typeof e.responsePreview === 'string') return e.responsePreview;
    }
  }
  return undefined;
}

function buildPrompt(input: SynthesisInput): string {
  const c = input.candidate;
  const ep = c.endpoint;
  return [
    'You generate the data-fetching `func` body for a byCLI adapter command.',
    'A byCLI adapter calls one HTTP data endpoint and returns an array of plain row objects.',
    '',
    'The recorder ranker already selected this endpoint as the data source:',
    JSON.stringify({ method: ep?.method, urlTemplate: ep?.urlTemplate, queryParams: ep?.queryParams, args: c.args, responseShape: c.responseShape }),
    '',
    'Causal timeline per recording (A and B used different inputs so you can tell which query params are',
    'dynamic args vs fixed). Each sample lists `navigations` (the page URL sequence — address-bar/SPA route',
    'changes; the seed often appears here, e.g. /search?q=apple vs /search?q=banana — use A/B navigation diff',
    'to map the user input to a param even when the XHR hides it), the user action sequence, and the',
    'candidate-endpoint calls, with `triggeredBy` linking a request to the user action that caused it:',
    JSON.stringify(input.samples.map((s) => buildSampleSummary(s, input.candidate))),
    '',
    'Screenshots of the page at the end of each recording may be attached as images.',
    '',
    'Respond with ONLY a single raw JSON object — no prose, no markdown code fences — with exactly these keys:',
    '- funcBody (string): the BODY ONLY of `async (kwargs) => { ... }` (no signature, no wrapping, no import,',
    '  no cli({...}) — those are added by the template). Use the global `fetch`. Read inputs from `kwargs`',
    '  (the args listed above). Parse the response and `return` an array of row objects. Prefer fetch over',
    '  browser automation. Keep it self-contained and side-effect-free.',
    '- columns (array): row field names for table output, each { "name": string, "path": string (e.g. "$[].title"), "type": string }.',
    '- description (string): one concise sentence describing what this command fetches.',
    '- access (string): "read" for queries (almost always); "write" only if it mutates remote/account state.',
    '',
    'Example shape: {"funcBody":"const r=await fetch(...);return await r.json();","columns":[{"name":"title","path":"$[].title","type":"string"}],"description":"...","access":"read"}',
  ].join('\n');
}

/** 创建合成器。client 优先注入(测试);否则有 apiKey 时建真 SDK 客户端(可指向第三方兼容网关 baseURL);
 *  都没有 → 永远返回 null。 */
export function createSynthesizer(opts: { apiKey?: string; baseURL?: string; model: string; client?: LlmClient; timeoutMs?: number }): Synthesizer {
  const client: LlmClient | null = makeLlmClient(opts);

  return {
    async synthesize(input) {
      if (!client) return null;
      try {
        const content: Array<Record<string, unknown>> = [{ type: 'text', text: buildPrompt(input) }];
        for (const s of input.samples) {
          if (s.screenshot) {
            content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.screenshot } });
          }
        }
        // 可移植参数集:不用 output_config(structured output)/thinking —— 第三方 Anthropic 兼容网关
        // 多不支持,会整调失败。改用「prompt 要求只输出 JSON + extractJson 稳健解析」(真 Anthropic 也通)。
        const res = await client.messages.create({
          model: opts.model,
          max_tokens: 8000,
          messages: [{ role: 'user', content }],
        });
        const text = res.content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
        const json = extractJson(text);
        if (!json) return null;
        const parsed = JSON.parse(json) as Partial<SynthesisResult>;
        if (typeof parsed.funcBody !== 'string' || !parsed.funcBody.trim()) return null;
        return {
          funcBody: parsed.funcBody,
          columns: Array.isArray(parsed.columns) ? parsed.columns : [],
          description: typeof parsed.description === 'string' ? parsed.description : '',
          access: parsed.access === 'write' ? 'write' : 'read',
        };
      } catch {
        // 任何失败(网络/限流/解析/无效输出)→ 退回空模板,不阻断 init。
        return null;
      }
    },
  };
}
