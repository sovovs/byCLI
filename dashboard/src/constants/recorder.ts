// 状态机常量、step 顺序、颜色映射 —— 对齐 05 State Machine + MASTER.md 图表语义
import type { SessionState, Confidence, ErrorCode } from '@/types/recorder';

/** 8 步主流程(capture→rank→init→verify 链),用于 Steps 进度与 FlowGraph */
export const FLOW_STEPS: Array<{
  key: string;
  title: string;
  /** 进入该 step 前应处的状态 */
  enterState: SessionState;
  /** 完成后应到达的状态 */
  doneState: SessionState;
}> = [
  { key: 'health', title: '健康检查', enterState: 'idle', doneState: 'health_checked' },
  { key: 'bind', title: '绑定会话', enterState: 'health_checked', doneState: 'session_bound' },
  { key: 'navigate', title: '导航 / 登录', enterState: 'session_bound', doneState: 'page_ready' },
  { key: 'capture', title: '采集 A/B', enterState: 'page_ready', doneState: 'capture_b' },
  { key: 'rank', title: '排序候选', enterState: 'capture_b', doneState: 'ranked' },
  { key: 'init', title: '生成草稿', enterState: 'ranked', doneState: 'draft_created' },
  { key: 'verify', title: '执行 Verify', enterState: 'draft_created', doneState: 'done' },
];

/** 状态在主流程中的序号(用于 Steps current 计算);终态/分支态返回特殊值 */
export const STATE_ORDER: Record<SessionState, number> = {
  idle: 0,
  health_checked: 1,
  session_bound: 2,
  awaiting_user_login: 2,
  auth_confirmed: 2,
  page_ready: 3,
  capture_a: 3,
  capture_b: 4,
  ranked: 5,
  draft_created: 6,
  verifying: 7,
  done: 7,
  failed: -1,
  cancelled: -1,
};

/** 终态判定 */
export const TERMINAL_STATES: SessionState[] = ['done', 'failed', 'cancelled'];
export const isTerminal = (s: SessionState) => TERMINAL_STATES.includes(s);
export const isFailed = (s: SessionState) => s === 'failed';

/**
 * 终止性错误码:收到即会话不可恢复,model 推进 failed(单一来源,勿在 model 内联重复)。
 * **必须与 be 实际对前端发的终态 ErrorCode 一致**——be 已把所有 lease-loss(页面/扩展/会话丢失,
 * 含 daemon 侧 command_result_unknown/extension_not_connected/profile_disconnected 等)统一归成
 * `page_lost`、daemon 不可达归 `daemon_unavailable`(见 be mapDaemonError / isLeaseLossCode)。故这里
 * 只列前端真会收到的终态码,不重复 be 的内部 daemon 码清单(那是 be 侧职责)。
 */
export const TERMINAL_ERROR_CODES: ErrorCode[] = ['page_lost', 'daemon_unavailable', 'verify_timeout'];
export const isTerminalError = (code: string): boolean => (TERMINAL_ERROR_CODES as string[]).includes(code);

// confidence → 主题 token 配色已下放到 CandidateCard(theme.useToken),不再在此硬编码 hex。
export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: '高',
  medium: '中',
  low: '低',
  rejected: '已拒绝',
};

/** 状态机非法转移时的统一文案 */
export const INVALID_STATE_HINT = '当前会话状态不允许此操作,请按流程顺序推进。';
