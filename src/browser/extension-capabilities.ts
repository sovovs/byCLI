export const FOCUS_WINDOW_CAPABILITY = 'focus-window-v1';

export function normalizeExtensionCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))];
}

export function requiredExtensionCapability(command: { action?: unknown; op?: unknown }): string | undefined {
  return command.action === 'tabs' && command.op === 'focus'
    ? FOCUS_WINDOW_CAPABILITY
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
  return capability === FOCUS_WINDOW_CAPABILITY
    ? 'Update and reload the byCLI Browser Bridge extension, then retry the login flow.'
    : 'Update and reload the byCLI Browser Bridge extension, then retry.';
}
