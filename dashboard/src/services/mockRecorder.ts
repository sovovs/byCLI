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
import type { RecorderClient, WritePolicy } from './recorderClient';

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
    score: 61,
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

// init 结果(契约形状 {report,dryRun});dry-run 预览时 responsibleUseAcknowledgedAt=0,write 时回填。
const initResult = (writePolicy: WritePolicy, ack?: number): InitResult => ({
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
  async bind(mode: 'existing' | 'await_login' = 'existing') {
    await delay(380);
    return ok({
      sessionId: 'rec_demo_01',
      contextId: 'default',
      targetId: 'TARGET_AB12',
      awaitingLogin: mode === 'await_login',
    });
  },

  async confirmAuth() {
    await delay(300);
    return ok({ sessionId: 'mock-session', state: 'auth_confirmed' as const, stateVersion: 1 });
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
      state: (sample === 'A' ? 'capture_a' : 'capture_b') as const,
      stateVersion: 1,
      sampleName: sample,
      started: true,
    });
  },

  async captureRead(sample: 'A' | 'B'): Promise<RequestEnvelope<CaptureSample>> {
    await delay(640);
    return ok({ sampleName: sample, entries: makeEntries(sample) });
  },

  async rank(): Promise<RequestEnvelope<RankCandidate[]>> {
    await delay(880);
    return ok(CANDIDATES);
  },

  async init(
    name: string,
    selectedCandidateId: string,
    writePolicy: WritePolicy,
    responsibleUseAcknowledgedAt?: number,
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
    return ok(initResult(writePolicy, responsibleUseAcknowledgedAt));
  },

  async verify(name: string): Promise<RequestEnvelope<VerifySummary>> {
    await delay(1100);
    if (!name) return fail('validation_failed', 'adapter 名缺失');
    return ok(VERIFY_SUMMARY);
  },

  async cancel() {
    await delay(150);
    return ok({ cancelled: true });
  },
};

export type MockRecorder = typeof mockRecorder;
