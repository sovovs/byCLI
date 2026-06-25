// isTerminalError 单测:终态错误码判定是单一来源,且与 be 实际对前端发的终态契约对齐。
import { describe, it, expect } from 'vitest';
import { isTerminalError, TERMINAL_ERROR_CODES } from './recorder';

describe('isTerminalError / TERMINAL_ERROR_CODES', () => {
  it('be 实际终态码 → true(会话不可恢复,推进 failed)', () => {
    expect(isTerminalError('page_lost')).toBe(true);
    expect(isTerminalError('daemon_unavailable')).toBe(true);
    expect(isTerminalError('verify_timeout')).toBe(true);
  });
  it('非终态(可恢复/校验类)→ false(别误判会话死亡)', () => {
    expect(isTerminalError('invalid_state')).toBe(false);
    expect(isTerminalError('validation_failed')).toBe(false);
    expect(isTerminalError('network_error')).toBe(false);
    expect(isTerminalError('request_failed')).toBe(false);
  });
  it('不重复 be 的内部 daemon 码(be 已统一映射成 page_lost)', () => {
    // be mapDaemonError 把 command_result_unknown/extension_not_connected/profile_disconnected 等
    // 归成 page_lost;前端不该再列这些内部码(重复 + 易与 be 映射漂移)。
    expect(TERMINAL_ERROR_CODES).not.toContain('command_result_unknown');
    expect(TERMINAL_ERROR_CODES).not.toContain('extension_disconnected');
  });
});
