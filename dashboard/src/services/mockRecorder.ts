// Mock Recorder Local Service —— 模拟 /recorder/* 全部 endpoint(03 契约统一响应包)。
// 后续接真实 Local Service 只需替换本文件的实现,types/契约不变。
import type {
  CaptureSample,
  ErrorCode,
  HealthReport,
  InitResult,
  NetworkEntry,
  RankCandidate,
  RequestEnvelope,
  VerifySummary,
} from '@/types/recorder';
import type { RankResult, RecorderClient, WritePolicy } from './recorderClient';

let reqSeq = 0;
const nextRequestId = () => `req_${(++reqSeq).toString(36).padStart(6, '0')}`;

/** 真实感延迟(无 Date/random 限制:用递增序列做伪抖动) */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ok = <T>(data: T): RequestEnvelope<T> => ({
  ok: true,
  schemaVersion: 'recorder.v1',
  requestId: nextRequestId(),
  data,
  error: null,
});

const fail = (code: ErrorCode, message: string, hint?: string): RequestEnvelope<never> => ({
  ok: false,
  schemaVersion: 'recorder.v1',
  requestId: nextRequestId(),
  data: null,
  error: { code, message, hint },
});

// ---- 固定 mock 数据(贴合 search/列表型站点的录制语义)----

const HEALTH_OK: HealthReport = {
  localService: 'ok',
  daemon: 'ok',
  extension: 'ok',
  highLevel: 'ok',
  llmSynthesis: true, // mock 模拟 LLM 可用 → 走新 pipeline 流程
};

const makeEntries = (sample: 'A' | 'B'): NetworkEntry[] => {
  const base = sample === 'A' ? 0 : 1200;
  return [
    {
      requestId: `net_${sample}_1`,
      method: 'GET',
      url: `https://example.com/api/search?q=${sample === 'A' ? 'shoes' : 'bags'}&page=1`,
      host: 'example.com',
      pathname: '/api/search',
      response: { status: 200, mime: 'application/json', bodyShape: { kind: 'array', itemKeys: ['title', 'url', 'price'] } },
      timing: { startedAt: base, durationMs: sample === 'A' ? 142 : 168 },
    },
    {
      requestId: `net_${sample}_2`,
      method: 'GET',
      url: `https://example.com/api/suggest?term=${sample === 'A' ? 'sh' : 'ba'}&_t=171`,
      host: 'example.com',
      pathname: '/api/suggest',
      response: { status: 200, mime: 'application/json', bodyShape: { kind: 'array', itemKeys: ['text'] } },
      timing: { startedAt: base + 30, durationMs: 54 },
    },
    {
      requestId: `net_${sample}_3`,
      method: 'POST',
      url: 'https://example.com/api/track',
      host: 'example.com',
      pathname: '/api/track',
      response: { status: 204, mime: 'text/plain', bodyShape: { kind: 'unknown' } },
      timing: { startedAt: base + 80, durationMs: 312 },
    },
    {
      // WebSocket 连接(kind='cdp-websocket'):展示数据帧展开行(可观测,不进打分)。
      requestId: `ws_${sample}_1`,
      method: 'GET',
      url: 'wss://example.com/realtime',
      host: 'example.com',
      kind: 'cdp-websocket',
      responseStatus: 101,
      webSocketFrames: [
        { direction: 'sent', opcode: 1, payloadPreview: `{"sub":"prices","q":"${sample === 'A' ? 'shoes' : 'bags'}"}` },
        { direction: 'received', opcode: 1, payloadPreview: '{"price":129,"ts":1710000000}' },
        { direction: 'received', opcode: 1, payloadPreview: '{"price":131,"ts":1710000002}' },
        { direction: 'received', opcode: 2, payloadPreview: 'base64:AAECAwQF', payloadTruncated: true },
      ],
    },
  ];
};

const CANDIDATES: RankCandidate[] = [
  {
    id: 'cand_1',
    score: 92,
    confidence: 'high',
    reviewRequired: false,
    endpoint: {
      method: 'GET',
      urlTemplate: 'https://example.com/api/search?q={keyword}&page={page}',
      host: 'example.com',
      pathname: '/api/search',
      queryParams: { q: '{keyword}', page: '1' },
      dynamicParams: [],
      excludedParams: [],
      requestBodyShape: { type: 'empty', keys: [] },
      authRequired: false,
    },
    args: [
      { argName: 'keyword', in: 'query', paramName: 'q', valueType: 'string' },
      { argName: 'page', in: 'query', paramName: 'page', valueType: 'number' },
    ],
    responseShape: { kind: 'array', itemKeys: ['title', 'url', 'price'], count: 20, shapeConfidence: 0.95, echoesSeedArg: true },
    responseShapeVariants: ['array'],
    mergedRequestIds: ['req_a1', 'req_a2', 'req_b1'],
    scoredBy: 'llm',
    llmUtilityScore: 90,
    inferredFunction: '按关键词搜索商品并返回结果列表(含标题、链接、价格)',
    paramUnion: [
      { name: 'q', in: 'query', requiredness: 'always', observedVariation: true, paramRole: 'seed_argument', exposeAsArg: 'yes', inferredMeaning: '搜索关键词', why: 'A/B 随用户输入变化' },
      { name: 'page', in: 'query', requiredness: 'optional', observedVariation: true, paramRole: 'pagination', exposeAsArg: 'optional_candidate', inferredMeaning: '结果分页页码', why: 'page 命中翻页参数模式' },
    ],
    paramObservations: [
      { name: 'q', in: 'query', observedCount: 3, totalCalls: 3, observedSamples: ['A', 'B'], observedAlways: true, observedVariation: true, valueKinds: ['string'], dynamicLike: false, cursorLike: false },
      { name: 'page', in: 'query', observedCount: 3, totalCalls: 3, observedSamples: ['A', 'B'], observedAlways: true, observedVariation: true, valueKinds: ['number'], dynamicLike: false, cursorLike: true },
    ],
    columns: [
      { name: 'title', path: '$[].title', type: 'string' },
      { name: 'url', path: '$[].url', type: 'string' },
      { name: 'price', path: '$[].price', type: 'number' },
    ],
    scoreExplanation: [
      { signal: 'response_is_list', delta: 35, detail: '响应是稳定的对象数组' },
      { signal: 'seed_echoed_in_query', delta: 28, detail: 'keyword 出现在 q 参数' },
      { signal: 'ab_diff_consistent', delta: 20, detail: 'A/B 样本结构一致,仅查询值变化' },
      { signal: 'no_anti_bot', delta: 9, detail: '未检测到反爬信号' },
    ],
    risks: [],
    evidenceIds: ['ev_keyword'],
  },
  {
    id: 'cand_2',
    score: 65,
    confidence: 'medium',
    reviewRequired: true,
    endpoint: {
      method: 'GET',
      urlTemplate: 'https://example.com/api/suggest?term={keyword}',
      host: 'example.com',
      pathname: '/api/suggest',
      queryParams: { term: '{keyword}' },
      dynamicParams: ['_t'],
      excludedParams: ['_t'],
      requestBodyShape: { type: 'empty', keys: [] },
      authRequired: false,
    },
    args: [{ argName: 'keyword', in: 'query', paramName: 'term', valueType: 'string' }],
    responseShape: { kind: 'array', itemKeys: ['text'], count: 8, shapeConfidence: 0.7 },
    responseShapeVariants: ['array', 'object'],
    mergedRequestIds: ['req_s1', 'req_s2'],
    scoredBy: 'llm',
    // 演示「两数不一致」:权威 rank=65/medium,但 LLM 自报效用 84/high(仅供参考,不改排序)。
    llmUtilityScore: 84,
    inferredFunction: '按输入词返回搜索建议词列表(输入联想)',
    paramUnion: [
      { name: 'term', in: 'query', requiredness: 'always', observedVariation: true, paramRole: 'seed_argument', exposeAsArg: 'yes', inferredMeaning: '联想输入词', why: 'A/B 随用户输入变化' },
      { name: '_t', in: 'query', requiredness: 'optional', observedVariation: true, paramRole: 'dynamic', exposeAsArg: 'no', inferredMeaning: '时间戳缓存破坏', why: '命中动态参数模式 _t,不应暴露' },
    ],
    paramObservations: [
      { name: 'term', in: 'query', observedCount: 2, totalCalls: 2, observedSamples: ['A', 'B'], observedAlways: true, observedVariation: true, valueKinds: ['string'], dynamicLike: false, cursorLike: false },
      { name: '_t', in: 'query', observedCount: 2, totalCalls: 2, observedSamples: ['A', 'B'], observedAlways: true, observedVariation: true, valueKinds: ['number'], dynamicLike: true, cursorLike: false },
    ],
    columns: [{ name: 'text', path: '$[].text', type: 'string' }],
    scoreExplanation: [
      { signal: 'response_is_list', delta: 30, detail: '响应是字符串建议列表' },
      { signal: 'cache_buster_excluded', delta: 16, detail: '_t 被识别为时间戳并排除' },
      { signal: 'fewer_columns', delta: -10, detail: '仅单列,信息量低于主候选' },
    ],
    risks: ['仅返回建议词,非完整列表数据'],
    evidenceIds: ['ev_keyword'],
  },
  {
    id: 'cand_3',
    score: 12,
    confidence: 'rejected',
    reviewRequired: true,
    endpoint: {
      method: 'POST',
      urlTemplate: 'https://example.com/api/track',
      host: 'example.com',
      pathname: '/api/track',
      requestBodyShape: { type: 'json', keys: ['event', 'ts'] },
      authRequired: false,
    },
    responseShape: { kind: 'unknown', shapeConfidence: 0.1 },
    scoreExplanation: [
      { signal: 'no_response_body', delta: -40, detail: '204 无响应体' },
      { signal: 'telemetry_endpoint', delta: -30, detail: '疑似埋点上报,非数据接口' },
    ],
    risks: ['埋点接口,不含可抓取数据', '响应为空'],
    evidenceIds: [],
  },
];

// mock 里模拟「AI 可用」:无 egress 同意时只回空骨架 + llmSynthesisOffered:true(演示同意 CTA),
// 带 egress 同意(llmAcked)才回 LLM 合成源码,模拟 P0-2 外发前置同意。
const LLM_SOURCE = [
  '// @generated-by adapter-recorder-llm',
  '// @model claude-opus-4-8',
  "import { cli, Strategy } from '@sovovs/bycli/registry';",
  '',
  'cli({',
  '  site: "example-com",',
  '  name: "search",',
  '  description: "Search example.com listings by keyword",',
  "  access: 'read',",
  '  domain: "example.com",',
  '  strategy: Strategy.PUBLIC,',
  '  args: [{ name: "keyword", type: "string", help: "Search keyword" }],',
  '  columns: ["title","url","price"],',
  '  func: async (kwargs) => {',
  '    const r = await fetch(`https://example.com/api/search?q=${encodeURIComponent(kwargs.keyword)}&page=1`);',
  '    const data = await r.json();',
  '    return data.map((x) => ({ title: x.title, url: x.url, price: x.price }));',
  '  },',
  '});',
].join('\n');
const EMPTY_SOURCE = [
  '// @generated-by adapter-recorder',
  "import { cli, Strategy } from '@sovovs/bycli/registry';",
  '',
  'cli({',
  '  site: "example-com",',
  '  name: "search",',
  "  columns: [], // TODO: field names for table output",
  '  func: async (kwargs) => {',
  '    // TODO: implement data fetching (prefer fetch over browser automation)',
  '    return [];',
  '  },',
  '});',
].join('\n');

// init 结果(契约形状 {report,dryRun});dry-run 预览时 responsibleUseAcknowledgedAt=0,write 时回填。
const initResult = (writePolicy: WritePolicy, ack?: number, llmAcked?: boolean): InitResult => ({
  report: {
    adapterPath: '~/.bycli/clis/example-com/search.js',
    reportPath: '~/.bycli/sites/example-com/recorder/search-report.json',
    warnings: ['page 参数固定为 1,如需翻页请在 adapter 中参数化'],
    responsibleUseAcknowledgedAt: writePolicy === 'write' ? ack ?? 0 : 0,
    releaseChannel: 'stable',
    localExperimentProfile: 'off',
    configSnapshotVersion: 1,
  },
  dryRun: { exists: false, changedLines: 12 },
  generatedSource: llmAcked ? LLM_SOURCE : EMPTY_SOURCE,
  llmSynthesisOffered: !llmAcked, // 未外发同意 → 提示「用 AI 生成」
});

// verify 摘要(契约 VerifySummary):仅脱敏 shape —— 行数 + 字段数(非列名),无原始行数据。
const VERIFY_SUMMARY: VerifySummary = {
  ok: true,
  stage: 'execute',
  rows: 3,
  fieldCount: 3,
  fixture: { status: 'matched' },
  trace: { retained: false },
};

/**
 * 偶发错误开关:置 true 时 navigate 会触发 page_lost,用于演示 ErrorRecovery。
 * 由 UI 的「模拟故障」开关控制。
 */
export const mockFlags = { injectPageLost: false };

export const mockRecorder: RecorderClient = {
  async health() {
    await delay(420);
    return ok(HEALTH_OK);
  },

  // mode 对应 05 章 Authentication Session Binding:
  // 'existing' = bind_existing_page(已登录标签页,直接就绪)
  // 'await_login' = create_page_await_user_login(新建页面,等用户手动登录后 confirm-auth)
  async bind(mode: 'existing' | 'await_login' = 'existing', _url?: string, _recordingMode?: 'tab_projection' | 'embedded_iframe') {
    await delay(380);
    // _url:await_login 真实模式下 be 用它开登录 tab;mock 隐式单会话,已带 targetId,忽略即可。
    // _recordingMode:mock 不区分形态(无真投屏/iframe),忽略。
    return ok({
      sessionId: 'rec_demo_01',
      contextId: 'default',
      targetId: 'TARGET_AB12',
      awaitingLogin: mode === 'await_login',
    });
  },

  // 登录确认后直接进 page_ready(复用登录 tab,不重新导航),对齐 be handleConfirmAuth。
  async confirmAuth() {
    await delay(300);
    return ok({ sessionId: 'mock-session', state: 'page_ready' as const, stateVersion: 1 });
  },

  async navigate(url: string): Promise<RequestEnvelope<{ url: string }>> {
    await delay(500);
    if (mockFlags.injectPageLost) {
      mockFlags.injectPageLost = false;
      return fail('page_lost', '目标页面在导航过程中丢失', '请重新绑定会话后重试;录制不会自动切换标签页。');
    }
    if (!/^https?:\/\//i.test(url)) {
      return fail('validation_failed', 'URL 必须以 http(s):// 开头', '请检查输入的目标地址。');
    }
    return ok({ url });
  },

  async captureStart(sample: 'A' | 'B') {
    await delay(260);
    return ok({
      sessionId: 'mock-session',
      state: (sample === 'A' ? 'capture_a' : 'capture_b') as 'capture_a' | 'capture_b',
      stateVersion: 1,
      sampleName: sample,
      started: true,
    });
  },

  async captureRead(sample: 'A' | 'B', _seed?: string): Promise<RequestEnvelope<CaptureSample>> {
    await delay(640);
    // 模拟录到的用户操作(input 仅 valueShape,无原始值),供前端展示 user-action 轨。
    const actions: CaptureSample['actions'] = [
      { type: 'click', selector: '#search-box', tag: 'input', role: 'searchbox' },
      { type: 'input', selector: '#search-box', tag: 'input', valueShape: { len: sample === 'A' ? 5 : 4, kind: 'text' } },
      { type: 'keydown', selector: '#search-box', tag: 'input', key: 'Enter' },
    ];
    return ok({ sampleName: sample, entries: makeEntries(sample), actions, actionsDropped: 0 });
  },

  async screenshot(_quality?: number): Promise<RequestEnvelope<{ format: string; data: string }>> {
    await delay(120);
    // 1x1 透明 jpeg 占位(mock 无真画面);真 HTTP transport 才回目标页帧。
    return ok({ format: 'jpeg', data: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AfwAB/9k=' });
  },

  async sendInput(_cdpMethod: string, _cdpParams: Record<string, unknown>): Promise<RequestEnvelope<{ dispatched: boolean }>> {
    await delay(20);
    return ok({ dispatched: true });
  },

  async rank(): Promise<RequestEnvelope<RankResult>> {
    await delay(880);
    return ok({
      candidates: CANDIDATES,
      scorePrompt: '你是 adapter 评分助手。下面每个候选都是 recorder-core 已按 (method+host+pathname) 聚拢好的 endpoint group…\n[候选 + paramObservations 事实 + A/B 证据 JSON]',
    });
  },

  async init(
    name: string,
    selectedCandidateId: string,
    writePolicy: WritePolicy,
    responsibleUseAcknowledgedAt?: number,
    llmEgressAcknowledgedAt?: number,
  ): Promise<RequestEnvelope<InitResult>> {
    await delay(720);
    if (!name) return fail('validation_failed', 'adapter 名缺失');
    const cand = CANDIDATES.find((c) => c.id === selectedCandidateId);
    if (!cand) return fail('validation_failed', '未找到选定的候选项');
    if (cand.confidence === 'rejected') {
      return fail('validation_failed', '该候选已被判定为不可用', '请选择 confidence 更高的候选项。');
    }
    if (writePolicy === 'write' && responsibleUseAcknowledgedAt === undefined) {
      return fail('responsible_use_required', '写入前须确认责任声明', '请勾选 ADR-0005 责任声明后再写入。');
    }
    // P0-2:带 egress 同意才回 LLM 合成源码(模拟外发);否则空骨架 + 提示同意。
    return ok(initResult(writePolicy, responsibleUseAcknowledgedAt, typeof llmEgressAcknowledgedAt === 'number'));
  },

  async verify(name: string): Promise<RequestEnvelope<VerifySummary>> {
    await delay(1100);
    if (!name) return fail('validation_failed', 'adapter 名缺失');
    return ok(VERIFY_SUMMARY);
  },

  // N4/N5:mock LLM 流水线——返回两个草稿(一个 usable、一个 verify 不达标),演示多脚本结果页。
  async pipeline(
    _llmEgressAcknowledgedAt: number,
    _candidateIds?: string[],
    onProgress?: (phases: Array<{ stage: string; status: 'running' | 'done'; durationMs?: number; detail?: string }>) => void,
    onPartial?: (prompts: { score?: string; generate?: string; screenshotCount?: number }) => void,
  ) {
    // mock 模拟阶段进度 + 分阶段 prompt,让开发态也能看到 score→generate→verify 的实时推进与提示词分阶段出现。
    onProgress?.([{ stage: 'score', status: 'running' }]);
    onPartial?.({ score: '你是 adapter 评分助手。对每个候选接口判断是否值得做成数据命令…\n[候选 + A/B 证据 JSON]', screenshotCount: 2 });
    await delay(500);
    onProgress?.([{ stage: 'score', status: 'done', durationMs: 500 }, { stage: 'generate', status: 'running' }]);
    onPartial?.({ generate: '你是 adapter 代码生成助手。为下列高分接口生成完整 cli 脚本…\n[筛后候选 + 证据 JSON]' });
    await delay(500);
    onProgress?.([{ stage: 'score', status: 'done', durationMs: 500 }, { stage: 'generate', status: 'done', durationMs: 500 }, { stage: 'verify', status: 'running' }]);
    await delay(400);
    return ok({
      drafts: [
        {
          id: 'draft_0', candidateId: 'cand_1', site: 'example-com', name: 'search', score: 55, confidence: 'medium' as const,
          reason: '搜索接口,响应是列表,关键词映射到 q 参数', risks: [], notes: ['page 固定为 1'],
          staticOk: true, staticViolations: [], usable: true,
          verify: { ok: true, rows: 20, fieldCount: 3, reasons: [] },
          source: LLM_SOURCE,
        },
        {
          id: 'draft_1', candidateId: 'cand_2', site: 'example-com', name: 'suggest', score: 35, confidence: 'low' as const,
          reason: '建议词接口,信息量较低', risks: ['仅返回建议词'], notes: [],
          staticOk: true, staticViolations: [], usable: false,
          verify: { ok: true, rows: 0, fieldCount: 1, reasons: ['rows 0 < 期望 1'] },
          source: LLM_SOURCE.replace('search', 'suggest'),
        },
      ],
      rejected: [{ candidateId: 'cand_3', reason: 'mutation(埋点写操作)' }],
      prompts: {
        score: '你是 adapter 评分助手。对每个候选接口判断是否值得做成数据命令…\n[候选 + A/B 证据 JSON]',
        generate: '你是 adapter 代码生成助手。为下列高分接口生成完整 cli 脚本…\n[筛后候选 + 证据 JSON]',
        screenshotCount: 2,
      },
    });
  },
  async pipelinePreview(candidateIds?: string[]) {
    await delay(200);
    return ok({
      prompts: {
        score: '你是 adapter 评分助手。对每个候选接口判断是否值得做成数据命令…\n[候选 + A/B 证据 JSON]',
        // mock:按选中候选回 generate 预览。对齐 be——空 candidateIds→全部 genCands(非空 prompt),
        // 非空→只选中的。避免开发态与真实后端行为不一致(codex Low)。
        generate: candidateIds && candidateIds.length
          ? `你是 adapter 生成器。为选中的 ${candidateIds.length} 个接口生成脚本…\n[${candidateIds.join(', ')} 的结构摘要 JSON]`
          : '你是 adapter 生成器。为全部生成资格候选生成脚本…\n[cand_1, cand_2 的结构摘要 JSON]',
        screenshotCount: 2,
      },
      sentCandidateIds: ['cand_1', 'cand_2'], // mock:前若干候选传 LLM(cand_3 被截/junk)
    });
  },
  // 拆步①评分:score-only。模拟阶段进度 + score 提示词,回候选(含 LLM 语义)+ 双提示词 + 送 LLM 候选 id。
  async pipelineScore(
    _llmEgressAcknowledgedAt: number,
    _candidateIds?: string[],
    onProgress?: (phases: Array<{ stage: string; status: 'running' | 'done'; durationMs?: number; detail?: string }>) => void,
    onPartial?: (prompts: { score?: string; generate?: string; screenshotCount?: number }) => void,
  ) {
    onProgress?.([{ stage: 'score', status: 'running' }]);
    onPartial?.({ score: '你是 adapter 评分助手。对每个候选接口判断是否值得做成数据命令…\n[候选 + A/B 证据 JSON]', screenshotCount: 2 });
    await delay(600);
    onProgress?.([{ stage: 'score', status: 'done', durationMs: 600 }]);
    return ok({
      candidates: CANDIDATES,
      rejected: [{ candidateId: 'cand_3', reason: 'mutation(埋点写操作)' }],
      scorePrompt: '你是 adapter 评分助手。对每个候选接口判断是否值得做成数据命令…\n[候选 + A/B 证据 JSON]',
      generatePrompt: '你是 adapter 代码生成助手。为下列高分接口生成完整 cli 脚本…\n[筛后候选 + 证据 JSON]',
      screenshotCount: 2,
      sentCandidateIds: ['cand_1', 'cand_2'],
      llmRawJson: JSON.stringify({
        interfaces: [
          { candidateId: 'cand_1', inferredFunction: '按关键词搜索商品并返回结果列表(含标题、链接、价格)', isDataEndpoint: true, ruleSignals: [{ name: 'stable_json_shape', present: true, why: '响应是稳定 array 列表' }, { name: 'seed_arg_maps_to_param', present: true, why: 'A/B 关键词映射到 q' }], semanticSignals: [{ name: 'rich_business_data', strength: 'strong', why: '20 条含价格的业务数据' }], paramUnion: [{ name: 'q', paramRole: 'seed_argument', exposeAsArg: 'yes', inferredMeaning: '搜索关键词' }, { name: 'page', paramRole: 'pagination', exposeAsArg: 'optional_candidate', inferredMeaning: '分页页码' }], llmUtilityScore: 90, llmUtilityBand: 'high' },
          { candidateId: 'cand_2', inferredFunction: '搜索建议词接口(返回联想词列表)', isDataEndpoint: true, ruleSignals: [{ name: 'stable_json_shape', present: true, why: '返回建议词数组' }], semanticSignals: [{ name: 'rich_business_data', strength: 'weak', why: '仅建议词、信息量低' }], paramUnion: [{ name: 'q', paramRole: 'seed_argument', exposeAsArg: 'yes', inferredMeaning: '前缀词' }], llmUtilityScore: 40, llmUtilityBand: 'low' },
        ],
      }, null, 2),
    });
  },
  // 拆步②生成:generate-only。模拟生成进度,回草稿(verify 占位「尚未测试」,usable=false,待第③步测)。
  async pipelineGenerate(
    _llmEgressAcknowledgedAt: number,
    _candidateIds?: string[],
    onProgress?: (phases: Array<{ stage: string; status: 'running' | 'done'; durationMs?: number; detail?: string }>) => void,
  ) {
    onProgress?.([{ stage: 'generate', status: 'running' }]);
    await delay(800);
    onProgress?.([{ stage: 'generate', status: 'done', durationMs: 800 }]);
    return ok({
      drafts: [
        {
          id: 'draft_0', candidateId: 'cand_1', site: 'example-com', name: 'search', score: 92, confidence: 'high' as const,
          reason: '搜索接口,响应是列表,关键词映射到 q 参数', risks: [], notes: ['page 固定为 1'],
          staticOk: true, staticViolations: [], usable: false, filePath: '/tmp/bycli-draft/example-com/search.js',
          verify: { ok: false, rows: 0, fieldCount: 0, reasons: ['尚未测试'] },
          source: LLM_SOURCE,
        },
        {
          id: 'draft_1', candidateId: 'cand_2', site: 'example-com', name: 'suggest', score: 35, confidence: 'low' as const,
          reason: '建议词接口,信息量较低', risks: ['仅返回建议词'], notes: [],
          staticOk: true, staticViolations: [], usable: false, filePath: '/tmp/bycli-draft/example-com/suggest.js',
          verify: { ok: false, rows: 0, fieldCount: 0, reasons: ['尚未测试'] },
          source: LLM_SOURCE.replace('search', 'suggest'),
        },
      ],
    });
  },
  // 拆步③单草稿测试:模拟真 verify。draft_0 达标(rows 20),draft_1 不达标(rows 0)。
  async draftVerify(draftId: string) {
    await delay(700);
    const okVerify = draftId === 'draft_0';
    const verify = okVerify
      ? { ok: true, rows: 20, fieldCount: 3, reasons: [] }
      : { ok: false, rows: 0, fieldCount: 1, reasons: ['rows 0 < 期望 1'] };
    return ok({ draftId, verify, usable: okVerify });
  },

  async saveAdapter(_draftId: string, _source?: string) {
    await delay(400);
    return ok({ state: 'done', saved: [{ draftId: _draftId, site: 'example-com', name: 'search', adapterPath: '~/.bycli/clis/example-com/search.js' }], adapterPath: '~/.bycli/clis/example-com/search.js' });
  },

  async saveAdapters(drafts: Array<{ draftId: string; source?: string }>) {
    await delay(500);
    const saved = drafts.map((d, i) => ({ draftId: d.draftId, site: 'example-com', name: i === 0 ? 'search' : `cmd-${i}`, adapterPath: `~/.bycli/clis/example-com/${i === 0 ? 'search' : `cmd-${i}`}.js` }));
    return ok({ state: 'done', saved, adapterPath: saved[0]?.adapterPath });
  },

  async cancel() {
    await delay(150);
    return ok({ cancelled: true });
  },
};

export type MockRecorder = typeof mockRecorder;
