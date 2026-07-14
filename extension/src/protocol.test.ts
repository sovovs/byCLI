import { describe, expect, it } from 'vitest';
import type { Command } from './protocol';

describe('tabs focus protocol', () => {
  it('represents focus as a session and page scoped tabs command', () => {
    const command = {
      id: 'focus-1',
      action: 'tabs',
      op: 'focus',
      session: 'wechat',
      surface: 'adapter',
      page: 'target-1',
    } satisfies Command;

    expect(command).toMatchObject({ action: 'tabs', op: 'focus', session: 'wechat', page: 'target-1' });
  });
});
