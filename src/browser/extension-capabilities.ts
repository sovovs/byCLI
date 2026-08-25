export const FOCUS_WINDOW_CAPABILITY = 'focus-window-v1';
export const IMA_READER_CAPABILITY = 'ima-reader-v1';
export const EXTENSION_CAPABILITY_MISSING_ERROR_CODE = 'extension_capability_missing';
export const EXTENSION_CAPABILITY_MISSING_HTTP_STATUS = 412;

const IMA_READER_ACTIONS = new Set([
  'ima-auth-start',
  'ima-auth-read',
  'ima-reader-request',
  'ima-auth-release',
]);

export function normalizeExtensionCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))];
}

export function requiredExtensionCapability(command: { action?: unknown; op?: unknown }): string | undefined {
  if (command.action === 'tabs' && command.op === 'focus') return FOCUS_WINDOW_CAPABILITY;
  return typeof command.action === 'string' && IMA_READER_ACTIONS.has(command.action)
    ? IMA_READER_CAPABILITY
    : undefined;
}

export function missingRequiredExtensionCapability(
  command: { action?: unknown; op?: unknown },
  capabilities: readonly string[],
): string | undefined {
  const required = requiredExtensionCapability(command);
  return required && !capabilities.includes(required) ? required : undefined;
}

export function extensionCapabilityHint(capability: string): string {
  if (capability === FOCUS_WINDOW_CAPABILITY) {
    return 'Update and reload the byCLI Browser Bridge extension, then retry the login flow.';
  }
  if (capability === IMA_READER_CAPABILITY) {
    return 'Update and reload the byCLI Browser Bridge extension with private ima reader support, then retry.';
  }
  return 'Update and reload the byCLI Browser Bridge extension, then retry.';
}
