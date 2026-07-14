import { describe, expect, it } from 'vitest';
import {
  FOCUS_WINDOW_CAPABILITY,
  missingRequiredExtensionCapability,
  normalizeExtensionCapabilities,
  requiredExtensionCapability,
} from './extension-capabilities.js';

describe('extension capability negotiation', () => {
  it('normalizes only unique string capabilities from extension hello', () => {
    expect(normalizeExtensionCapabilities(['focus-window-v1', 42, 'focus-window-v1', ''])).toEqual([
      FOCUS_WINDOW_CAPABILITY,
    ]);
  });

  it('requires focus-window only for the new tabs focus operation', () => {
    expect(requiredExtensionCapability({ action: 'tabs', op: 'focus' })).toBe(FOCUS_WINDOW_CAPABILITY);
    expect(requiredExtensionCapability({ action: 'tabs', op: 'list' })).toBeUndefined();
    expect(requiredExtensionCapability({ action: 'navigate' })).toBeUndefined();
  });

  it('rejects focus for old hello payloads without affecting existing operations', () => {
    expect(missingRequiredExtensionCapability({ action: 'tabs', op: 'focus' }, [])).toBe(FOCUS_WINDOW_CAPABILITY);
    expect(missingRequiredExtensionCapability({ action: 'tabs', op: 'focus' }, [FOCUS_WINDOW_CAPABILITY])).toBeUndefined();
    expect(missingRequiredExtensionCapability({ action: 'navigate' }, [])).toBeUndefined();
  });
});
