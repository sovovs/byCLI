// 录制会话状态机 model(@umijs/max model)。
// 持有 SessionState + stateVersion,每个动作按 05 State Machine 校验当前态,
// 非法转移返回 invalid_state(不真正调用 mock),错误态走 failed。
import { useCallback, useMemo, useState } from 'react';
import { getRecorderClient, type RecordingMode } from '@/services/recorderClient';
import { INVALID_STATE_HINT, isTerminalError } from '@/constants/recorder';
import { deriveAdapterName } from './adapterName';
import { isActionAllowed, type RecorderAction } from './transitions';
import type {
  CaptureSample,
  HealthReport,
  InitResult,
  PipelineDraft,
  PipelinePrompts,
  RankCandidate,
  RecorderError,
  RequestEnvelope,
  SavedAdapter,
  SessionState,
  VerifySummary,
} from '@/types/recorder';

interface SessionData {
  sessionId?: string;
  health?: HealthReport;
  targetUrl?: string;
  /** 产品录制形态(bind 时定):tab_projection(投屏,默认)/ embedded_iframe(页内嵌 iframe)/ vnc(容器 noVNC)。驱动 CaptureStep 渲染分支。 */
  recordingMode?: RecordingMode;
  /** vnc 模式:容器 noVNC 画面 URL(bind 返回);驱动 CaptureStep 的 VncFrame iframe src。 */
  vncUrl?: string;
  /** 当前正在录制的样本(captureStart 成功后置位、captureRead 成功后清空);驱动「开始/结束」按钮态 */
  recording?: 'A' | 'B' | null;
  sampleA?: CaptureSample;
  sampleB?: CaptureSample;
  /** A/B 各自声明的搜索关键词(评分识别 seed→param;结束录制时随 captureRead 下发,be 只存 HMAC 证据)。 */
  seedA?: string;
  seedB?: string;
  candidates?: RankCandidate[];
  selectedCandidateId?: string;
  /** 从选定候选派生并固化的 adapter 名(site/command);init 预览/写入与 verify 复用同一个 */
  adapterName?: string;
  /** dry-run 预览结果(不推进会话) */
  draftPreview?: InitResult;
  /** P0-2:LLM 外发同意时刻;一旦同意,后续 preview/write 复用,允许把痕迹发往 Anthropic 合成。 */
  llmEgressAck?: number;
  /** N4/N5:LLM 流水线产出的脚本草稿(verify 后)+ 被拒候选 */
  pipelineDrafts?: PipelineDraft[];
  pipelineRejected?: Array<{ candidateId: string; reason: string }>;
  /** 透明展示:本轮实际发给 LLM 的提示词(score + generate)+ 截图张数 */
  pipelinePrompts?: PipelinePrompts;
  /** 会被喂 LLM 的候选 id(预览时拉取;候选表格据此标「是否传 LLM」) */
  pipelineSentIds?: string[];
  /** pipeline 异步轮询途中的阶段进度(score/generate/verify 耗时),驱动进度展示。 */
  pipelineProgress?: Array<{ stage: string; status: 'running' | 'done'; durationMs?: number; detail?: string }>;
  /** 保存成功后的 adapter 路径(单存兼容字段) */
  savedAdapterPath?: string;
  /** 多选保存成功后的脚本列表(site/名/路径),驱动结果列表展示 */
  savedAdapters?: SavedAdapter[];
  /** write 写入结果(推进 ranked→draft_created) */
  draft?: InitResult;
  verifyResult?: VerifySummary;
}

export default function useRecorderSession() {
  const [state, setState] = useState<SessionState>('idle');
  const [stateVersion, setStateVersion] = useState(0);
  const [data, setData] = useState<SessionData>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<RecorderError | null>(null);
  // transport 由 bootstrap 决定:默认 mock,FEATURE_LOCALHOST_HTTP_UI + token 注入时切真实 HTTP。
  const client = useMemo(() => getRecorderClient(), []);

  const advance = useCallback((next: SessionState, patch?: Partial<SessionData>) => {
    setState(next);
    setStateVersion((v) => v + 1);
    if (patch) setData((d) => ({ ...d, ...patch }));
  }, []);

  /** 统一动作执行:校验当前态 → 调 mock → 成功推进 / 失败转 failed */
  const run = useCallback(
    async <T>(
      action: RecorderAction,
      call: () => Promise<RequestEnvelope<T>>,
      onSuccess: (data: T) => { next: SessionState; patch?: Partial<SessionData> },
      fromStateOverride?: SessionState,
    ) => {
      // 串联动作(如 startCaptureA = navigate→captureStart)串两步时,setState 异步、闭包 state 仍是旧值,
      // 故允许显式传入第二步的校验起点;默认用当前 state。
      if (!isActionAllowed(action, fromStateOverride ?? state)) {
        setError({ code: 'invalid_state', message: '非法状态转移', hint: INVALID_STATE_HINT });
        return false;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await call();
        if (!res.ok || res.data === null) {
          setError(res.error ?? { code: 'network_error', message: '未知错误' });
          // 终止性错误(page_lost 等租约丢失 / daemon 不可达)→ 会话终止为 failed(05 规则)。
          // 终态码清单是单一来源 isTerminalError(@/constants/recorder),与 be 实际终态码契约对齐。
          if (res.error && isTerminalError(res.error.code)) {
            advance('failed');
          }
          return false;
        }
        const { next, patch } = onSuccess(res.data);
        advance(next, patch);
        return true;
      } catch (e) {
        setError({ code: 'network_error', message: e instanceof Error ? e.message : '请求异常' });
        return false;
      } finally {
        setLoading(false);
      }
    },
    [state, advance],
  );

  const actions = {
    health: () => run('health', () => client.health(), (d) => ({ next: 'health_checked', patch: { health: d } })),
    // 新建录制会话:仅绑定浏览器 + 保存目标 URL,**不导航、不开 tab**(开 tab 推迟到「开始录制」)。
    // 若目标站点需要登录,用户在「开始录制」后打开的 byCLI 标签页内自行完成登录(Recorder 只绑定已有登录)。
    bind: (url: string, recordingMode?: RecordingMode) =>
      run('bind', () => client.bind('existing', url, recordingMode), (d) => ({
        next: 'session_bound',
        patch: { sessionId: d.sessionId, targetUrl: url, recording: null, recordingMode: recordingMode ?? 'tab_projection', vncUrl: d.vncUrl },
      })),
    navigate: (url: string) =>
      run('navigate', () => client.navigate(url), (d) => ({ next: 'page_ready', patch: { targetUrl: d.url || url } })),
    // 「开始/结束」两步录制(治旧的 arm 完立刻 read 抓 0 条):
    // 开始 = navigate 新建 byCLI 标签页(A=页面 a / B=页面 b)→ captureStart 开窗;用户在该页操作。
    // 结束 = captureRead 读窗冻结,产出样本 list。captureStart 后状态留在 page_ready、置 recording 标记。
    startCaptureA: async () => {
      const url = data.targetUrl;
      if (!url) {
        setError({ code: 'validation_failed', message: '缺少目标 URL,请返回上一步重新绑定会话', hint: INVALID_STATE_HINT });
        return false;
      }
      // 从 session_bound 导航开页面 a(默认校验起点即当前 session_bound)。
      // 注:**不要用 navigate 返回的 d.url 覆盖 targetUrl** —— 新建 owned tab 落在 about:blank,
      // 返回的 d.url=about:blank 会污染 targetUrl,导致 B 录制 navigate 到 about:blank 被扩展拒(Blocked URL scheme)。
      const nav = await run('navigate', () => client.navigate(url), () => ({ next: 'page_ready', patch: {} }));
      if (!nav) return false;
      return run('captureStart', () => client.captureStart('A'), () => ({ next: 'page_ready', patch: { recording: 'A' } }), 'page_ready');
    },
    stopCaptureA: () =>
      run('captureA', () => client.captureRead('A', data.seedA), (d) => ({ next: 'capture_a', patch: { sampleA: d, recording: null } })),
    startCaptureB: async () => {
      const url = data.targetUrl;
      if (!url) {
        setError({ code: 'validation_failed', message: '缺少目标 URL,请返回上一步重新绑定会话', hint: INVALID_STATE_HINT });
        return false;
      }
      // 从 capture_a 重新导航开全新页面 b(navigate 已放开 capture_a 来源态)。同上:不覆盖 targetUrl。
      const nav = await run('navigate', () => client.navigate(url), () => ({ next: 'page_ready', patch: {} }), 'capture_a');
      if (!nav) return false;
      return run('captureStart', () => client.captureStart('B'), () => ({ next: 'page_ready', patch: { recording: 'B' } }), 'page_ready');
    },
    stopCaptureB: () =>
      run('captureB', () => client.captureRead('B', data.seedB), (d) => ({ next: 'capture_b', patch: { sampleB: d, recording: null } })),
    /** 设置 A/B 样本的搜索关键词(CaptureStep 输入框驱动;仅前端态,结束录制时随 captureRead 下发)。 */
    setSeed: (sample: 'A' | 'B', seed: string) =>
      setData((d) => (sample === 'A' ? { ...d, seedA: seed } : { ...d, seedB: seed })),
    rank: () => run('rank', () => client.rank(), (d) => ({ next: 'ranked', patch: { candidates: d } })),
    // 选定候选时即派生并固化 adapter 名(init 预览/写入与 verify 复用同一个,避免漂移)。
    selectCandidate: (id: string) =>
      setData((d) => {
        const cand = d.candidates?.find((c) => c.id === id);
        return { ...d, selectedCandidateId: id, adapterName: cand ? deriveAdapterName(cand) : d.adapterName };
      }),
    // dry-run 预览:不推进会话,产出 {report,dryRun} 供用户审阅。
    // egressConsent=true 时(用户点「用 AI 生成」)才带 egress 同意戳 → be 才会把痕迹发模型合成(P0-2);
    // 一旦同意即记入 session,后续重复预览/写入复用,无需再问。
    previewInit: (egressConsent?: boolean) => {
      const id = data.selectedCandidateId;
      const name = data.adapterName;
      if (!id || !name) {
        setError({ code: 'validation_failed', message: '请先选择一个候选', hint: INVALID_STATE_HINT });
        return Promise.resolve(false);
      }
      const egressAck = egressConsent ? Date.now() : data.llmEgressAck;
      return run(
        'previewInit',
        () => client.init(name, id, 'dry-run', undefined, egressAck),
        (d) => ({ next: 'ranked', patch: { draftPreview: d, ...(egressAck ? { llmEgressAck: egressAck } : {}) } }),
      );
    },
    // 确认写入:带 ADR-0005 责任声明确认,推进 ranked→draft_created。复用已记的 egress 同意(若有)。
    writeInit: () => {
      const id = data.selectedCandidateId;
      const name = data.adapterName;
      if (!id || !name) {
        setError({ code: 'validation_failed', message: '请先选择一个候选', hint: INVALID_STATE_HINT });
        return Promise.resolve(false);
      }
      return run('writeInit', () => client.init(name, id, 'write', Date.now(), data.llmEgressAck), (d) => ({ next: 'draft_created', patch: { draft: d } }));
    },
    // N4/N5 verify-then-save:从 ranked 跑 LLM 评分→多脚本→静态检查→草稿→verify→收集(带 egress 同意)。不推进。
    runPipeline: (candidateIds?: string[]) => {
      setData((d) => ({ ...d, pipelineProgress: [] })); // 开跑前清空上轮进度
      return run('pipeline', () => client.pipeline(Date.now(), candidateIds, (phases) => setData((d) => ({ ...d, pipelineProgress: phases }))), (d) => ({ next: 'ranked', patch: { pipelineDrafts: d.drafts, pipelineRejected: d.rejected, pipelinePrompts: d.prompts, llmEgressAck: Date.now() } }));
    },
    // 外发前预览将发送的提示词(不调 LLM、不外发、不改状态);存进 pipelinePrompts 供面板展示。
    previewPrompts: () =>
      run('pipelinePreview', () => client.pipelinePreview(), (d) => ({ next: 'ranked', patch: { pipelinePrompts: d.prompts, pipelineSentIds: d.sentCandidateIds } })),
    // 保存某个(可能编辑过的)草稿 → ranked→done。
    saveDraft: (draftId: string, source?: string) =>
      run('saveAdapter', () => client.saveAdapter(draftId, source), (d) => ({ next: 'done', patch: { savedAdapterPath: d.adapterPath, savedAdapters: d.saved } })),
    // 多选保存:一次保存多个(可能编辑过的)草稿 → 全部存完一次 ranked→done。
    saveDrafts: (drafts: Array<{ draftId: string; source?: string }>) =>
      run('saveAdapter', () => client.saveAdapters(drafts), (d) => ({ next: 'done', patch: { savedAdapterPath: d.adapterPath, savedAdapters: d.saved } })),
    verify: () => {
      const name = data.adapterName;
      if (!name) {
        setError({ code: 'validation_failed', message: 'adapter 名缺失,请重新选择候选', hint: INVALID_STATE_HINT });
        return Promise.resolve(false);
      }
      return run('verify', () => client.verify(name), (d) => ({ next: 'done', patch: { verifyResult: d } }));
    },
    reset: () => {
      setState('idle');
      setStateVersion(0);
      setData({});
      setError(null);
      setLoading(false);
    },
  };

  return { state, stateVersion, data, loading, error, actions };
}
