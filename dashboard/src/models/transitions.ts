// model 动作的状态门禁(05 State Machine 的前端镜像)。抽成纯模块以便单测 + 单一来源。
// 注:be 侧 stateMachine 是**权威**门禁,前端这层是 UX 守卫(非法转移就地提示,不发请求)。
import type { SessionState } from '@/types/recorder';

/** model 动作 → 允许触发的来源态。 */
export const ALLOWED_FROM = {
  health: ['idle', 'health_checked'],
  bind: ['health_checked'],
  confirmAuth: ['awaiting_user_login'],
  navigate: ['session_bound', 'auth_confirmed', 'page_ready'],
  // 每个样本两步:captureStart(开窗)可从 page_ready/capture_a;captureA/B(读窗冻结)各自来源态。
  captureStart: ['page_ready', 'capture_a'],
  captureA: ['page_ready'],
  captureB: ['capture_a'],
  rank: ['capture_b'],
  // init 拆两动作:dry-run 预览(不推进)与 write 写入(推进 ranked→draft_created),均自 ranked。
  previewInit: ['ranked'],
  writeInit: ['ranked'],
  verify: ['draft_created'],
} satisfies Record<string, SessionState[]>;

export type RecorderAction = keyof typeof ALLOWED_FROM;

/** 当前态能否触发该动作(model run() 的状态门禁)。 */
export const isActionAllowed = (action: RecorderAction, state: SessionState): boolean =>
  (ALLOWED_FROM[action] as SessionState[]).includes(state);
