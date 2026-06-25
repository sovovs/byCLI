// 录制会话状态机 model(@umijs/max model)。
// 持有 SessionState + stateVersion,每个动作按 05 State Machine 校验当前态,
// 非法转移返回 invalid_state(不真正调用 mock),错误态走 failed。
import { useCallback, useMemo, useState } from 'react';
import { getRecorderClient } from '@/services/recorderClient';
import { INVALID_STATE_HINT, isTerminalError } from '@/constants/recorder';
import { deriveAdapterName } from './adapterName';
import { isActionAllowed, type RecorderAction } from './transitions';
import type {
  CaptureSample,
  HealthReport,
  InitResult,
  RankCandidate,
  RecorderError,
  RequestEnvelope,
  SessionState,
  VerifySummary,
} from '@/types/recorder';

interface SessionData {
  sessionId?: string;
  health?: HealthReport;
  targetUrl?: string;
  sampleA?: CaptureSample;
  sampleB?: CaptureSample;
  candidates?: RankCandidate[];
  selectedCandidateId?: string;
  /** 从选定候选派生并固化的 adapter 名(site/command);init 预览/写入与 verify 复用同一个 */
  adapterName?: string;
  /** dry-run 预览结果(不推进会话) */
  draftPreview?: InitResult;
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
      // 合并动作(如 bindAndNavigate)串联两步时,setState 异步、闭包 state 仍是旧值,
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
    // bind 两种模式(05 章 Authentication Session Binding):
    // 已登录标签页 → session_bound;新建页面待登录 → awaiting_user_login。
    bind: (mode: 'existing' | 'await_login' = 'existing') =>
      run('bind', () => client.bind(mode), (d) => ({
        next: d.awaitingLogin ? 'awaiting_user_login' : 'session_bound',
        patch: { sessionId: d.sessionId },
      })),
    // awaiting_user_login → auth_confirmed(用户手动登录后确认)。
    confirmAuth: () =>
      run('confirmAuth', () => client.confirmAuth(), () => ({ next: 'auth_confirmed' })),
    navigate: (url: string) =>
      run('navigate', () => client.navigate(url), (d) => ({ next: 'page_ready', patch: { targetUrl: d.url } })),
    // 一步合并:新建录制会话 + 自动导航打开录制页(用户只需输 URL、点一次)。在 model 内串联 bind→navigate,
    // 给 navigate 显式传 bind 后的 'session_bound' 作校验起点(避免 setState 异步导致的 stale-state invalid_state)。
    bindAndNavigate: async (url: string) => {
      const bound = await run('bind', () => client.bind('existing'), (d) => ({
        next: d.awaitingLogin ? 'awaiting_user_login' : 'session_bound',
        patch: { sessionId: d.sessionId },
      }));
      if (!bound) return false;
      return run(
        'navigate',
        () => client.navigate(url),
        (d) => ({ next: 'page_ready', patch: { targetUrl: d.url } }),
        'session_bound',
      );
    },
    // 每个样本两步驱动(05 章 line 50 + Capture Sample Protocol):capture/start 开窗 → capture/read 关窗冻结。
    captureA: async () => {
      const started = await run('captureStart', () => client.captureStart('A'), () => ({ next: state }));
      if (!started) return false;
      return run('captureA', () => client.captureRead('A'), (d) => ({ next: 'capture_a', patch: { sampleA: d } }));
    },
    captureB: async () => {
      const started = await run('captureStart', () => client.captureStart('B'), () => ({ next: state }));
      if (!started) return false;
      return run('captureB', () => client.captureRead('B'), (d) => ({ next: 'capture_b', patch: { sampleB: d } }));
    },
    rank: () => run('rank', () => client.rank(), (d) => ({ next: 'ranked', patch: { candidates: d } })),
    // 选定候选时即派生并固化 adapter 名(init 预览/写入与 verify 复用同一个,避免漂移)。
    selectCandidate: (id: string) =>
      setData((d) => {
        const cand = d.candidates?.find((c) => c.id === id);
        return { ...d, selectedCandidateId: id, adapterName: cand ? deriveAdapterName(cand) : d.adapterName };
      }),
    // dry-run 预览:不推进会话,产出 {report,dryRun} 供用户审阅。
    previewInit: () => {
      const id = data.selectedCandidateId;
      const name = data.adapterName;
      if (!id || !name) {
        setError({ code: 'validation_failed', message: '请先选择一个候选', hint: INVALID_STATE_HINT });
        return Promise.resolve(false);
      }
      return run('previewInit', () => client.init(name, id, 'dry-run'), (d) => ({ next: 'ranked', patch: { draftPreview: d } }));
    },
    // 确认写入:带 ADR-0005 责任声明确认,推进 ranked→draft_created。
    writeInit: () => {
      const id = data.selectedCandidateId;
      const name = data.adapterName;
      if (!id || !name) {
        setError({ code: 'validation_failed', message: '请先选择一个候选', hint: INVALID_STATE_HINT });
        return Promise.resolve(false);
      }
      return run('writeInit', () => client.init(name, id, 'write', Date.now()), (d) => ({ next: 'draft_created', patch: { draft: d } }));
    },
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
