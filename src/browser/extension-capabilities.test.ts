import { describe, expect, it } from 'vitest';
import {
  EXTENSION_CAPABILITY_MISSING_HTTP_STATUS,
  FOCUS_WINDOW_CAPABILITY,
  IMA_READER_CAPABILITY,
  extensionCapabilityHint,
  missingRequiredExtensionCapability,
  normalizeExtensionCapabilities,
  requiredExtensionCapability,
} from './extension-capabilities.js';

describe('extension capability negotiation', () => {
  it('uses a non-conflict HTTP status for missing capabilities', () => {
    expect(EXTENSION_CAPABILITY_MISSING_HTTP_STATUS).toBe(412);
  });

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

  it.each([
    'ima-auth-start',
    'ima-auth-read',
    'ima-reader-request',
    'ima-auth-release',
  ])('requires ima-reader-v1 for %s', (action) => {
    expect(requiredExtensionCapability({ action })).toBe(IMA_READER_CAPABILITY);
    expect(missingRequiredExtensionCapability({ action }, [])).toBe(IMA_READER_CAPABILITY);
    expect(missingRequiredExtensionCapability({ action }, [IMA_READER_CAPABILITY])).toBeUndefined();
  });

  it('provides an ima-specific update hint', () => {
    expect(extensionCapabilityHint(IMA_READER_CAPABILITY)).toMatch(/private ima reader/i);
  });
});
