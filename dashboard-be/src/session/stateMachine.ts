// 会话状态机(05 章 State Machine)。每个转移由显式动作驱动,无隐式自动推进。
// 校验「当前态 → 动作」是否合法;非法返回 false(调用方转 invalid_state)。
export type SessionState =
  | 'idle'
  | 'health_checked'
  | 'session_bound'
  | 'awaiting_user_login'
  | 'auth_confirmed'
  | 'page_ready'
  | 'capture_a'
  | 'capture_b'
  | 'ranked'
  | 'draft_created'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled';

export type SessionAction =
  | 'bind'
  | 'confirmAuth'
  | 'navigate'
  | 'captureStart'
  | 'captureRead'
  | 'rank'
  | 'init'
  | 'verify'
  | 'completeVerify'
  | 'failVerify'
  | 'cancel';

/** 动作允许的来源态(05 章 state→driving-endpoint 表)。 */
const ALLOWED_FROM: Record<SessionAction, SessionState[]> = {
  bind: ['idle', 'health_checked'],
  confirmAuth: ['awaiting_user_login'],
  navigate: ['session_bound', 'auth_confirmed', 'page_ready'],
  captureStart: ['page_ready', 'capture_a'],
  captureRead: ['page_ready', 'capture_a', 'capture_b'],
  rank: ['capture_b'],
  init: ['ranked'],
  verify: ['draft_created'],
  // verify 终态:verifying → done|failed(由轮询到的 runner 终态驱动,05:63)
  completeVerify: ['verifying'],
  failVerify: ['verifying'],
  // cancel:任意非终态可取消
  cancel: [
    'idle', 'health_checked', 'session_bound', 'awaiting_user_login', 'auth_confirmed',
    'page_ready', 'capture_a', 'capture_b', 'ranked', 'draft_created', 'verifying',
  ],
};

const TERMINAL: SessionState[] = ['done', 'failed', 'cancelled'];
export const isTerminal = (s: SessionState): boolean => TERMINAL.includes(s);

export const canTransition = (from: SessionState, action: SessionAction): boolean =>
  ALLOWED_FROM[action].includes(from);

/** 异常租约丢失驱动 failed(05 章:page_lost/daemon disconnect/tab close/capture timeout)。 */
export const isLeaseLossCode = (code: string): boolean =>
  [
    'page_lost', 'daemon_unavailable', 'extension_disconnected', 'verify_timeout',
    // 真 daemon/扩展实际产出的「页面/扩展/会话没了」码(真栈实测)。之前 be 只列了凭空假设的
    // page_lost/extension_disconnected,而生产端从不发那两个 → 丢页/断连时不 fail-fast、会话卡死。
    'command_result_unknown', 'extension_not_connected', 'profile_disconnected', 'bound_tab_not_found',
  ].includes(code);
