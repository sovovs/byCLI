# byCLI Conditional Browser and Fingerprint Redaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add trace-safe `fingerprint` redaction and a serializable conditional-browser command contract to byCLI without regressing static browser commands.

**Architecture:** Registry input accepts a browser predicate, but normalized commands store only `browser: 'conditional'` plus an in-memory `requiresBrowser` function. Execution evaluates that function after argument coercion; manifest-backed conditional commands are hydrated before browser routing so the predicate never needs to be serialized. Help, Commander, list output, and manifests expose the third metadata state consistently.

**Tech Stack:** TypeScript 6, Commander 14, Vitest 4, byCLI registry/execution/runtime, Chrome extension TypeScript.

**Depends on:** [bycli-plugin-wechat design](../../2026-07-14-bycli-plugin-wechat-design.md)

**Produces:** The `@sovovs/bycli >=2.1.0 <3` capability required by the companion plugin plan.

---

## File map

- Modify `src/observation/redaction.ts`: redact `fingerprint` in structured fields, text, and URL parameters.
- Modify `src/observation/redaction.test.ts`: lock observation and trace-facing redaction behavior.
- Modify `extension/src/url-redact.ts`: mask `fingerprint` before extension network URLs cross the bridge.
- Create `extension/src/url-redact.test.ts`: cover raw and URL-encoded fingerprint values.
- Modify `src/registry.ts`: define public predicate input and normalized conditional command types.
- Modify `src/registry-api.ts`: export the new public types.
- Modify `src/registry.test.ts`: cover normalization and static-command compatibility.
- Modify `src/capabilityRouting.ts`: route from an already-resolved browser requirement.
- Modify `src/capabilityRouting.test.ts`: preserve pipeline/static routing semantics.
- Modify `src/execution.ts`: hydrate lazy conditional commands and evaluate predicates after argument preparation.
- Modify `src/execution.test.ts`: prove env mode never creates a browser session and browser mode receives an `IPage`.
- Modify `src/types.ts`, `src/browser/page.ts`, and `src/browser/cdp.ts`: expose an explicit foreground-focus operation for interactive login.
- Modify `extension/src/protocol.ts`, `extension/src/background.ts`, and `extension/src/background.test.ts`: focus the owned automation window on request.
- Modify `src/commanderAdapter.ts`: expose browser flags for conditional commands.
- Modify `src/commanderAdapter.test.ts`: verify browser options and prepared argument flow.
- Modify `src/serialization.ts`: serialize the exact third state and render it in help.
- Modify `src/serialization.test.ts`: prevent truthiness coercion.
- Modify `src/help.ts`: expose conditional metadata and browser options in text/structured help.
- Modify `src/help.test.ts`: verify command and site help.
- Modify `src/manifest-types.ts`: allow `boolean | 'conditional'` metadata.
- Modify `src/build-manifest.ts`: emit the normalized third state without the predicate.
- Modify `src/build-manifest.test.ts`: prove predicates are absent from JSON.
- Modify `src/discovery.ts`: register lazy conditional placeholders for precompiled manifests.
- Create `src/discovery.test.ts`: prove conditional manifest entries become marked lazy commands with a sentinel predicate.
- Modify `package.json` and `package-lock.json`: release the capability as `2.1.0` after all tests pass.
- Modify `docs/developer/ts-adapter.md`, `docs/guide/plugins.md`, and `docs/zh/guide/plugins.md`: document conditional browser registration.

### Task 1: Close fingerprint redaction gaps

**Files:**
- Modify: `src/observation/redaction.test.ts`
- Modify: `src/observation/redaction.ts`
- Create: `extension/src/url-redact.test.ts`
- Modify: `extension/src/url-redact.ts`

- [ ] **Step 1: Add failing observation redaction tests**

Append these cases to `src/observation/redaction.test.ts`:

```ts
it('redacts WeChat fingerprint fields and URL parameters', () => {
  const secret = 'fp+/=secret';
  expect(redactValue({ fingerprint: secret })).toEqual({ fingerprint: '[REDACTED]' });
  expect(redactUrl(`https://mp.weixin.qq.com/cgi-bin/searchbiz?fingerprint=${encodeURIComponent(secret)}&ok=1`))
    .toBe('https://mp.weixin.qq.com/cgi-bin/searchbiz?fingerprint=[REDACTED]&ok=1');
});

it('redacts fingerprint assignments embedded in diagnostic text', () => {
  expect(redactValue('request failed: fingerprint=fp-secret&token=token-secret'))
    .toBe('request failed: fingerprint=[REDACTED]&token=[REDACTED]');
});
```

- [ ] **Step 2: Run the focused unit test and confirm the leak**

Run:

```bash
rtk npx vitest run --project unit src/observation/redaction.test.ts
```

Expected: FAIL because `fingerprint` is not in `SENSITIVE_FIELD_PATTERN`, `SENSITIVE_URL_PARAMS`, or the assignment pattern used by `redactText`.

- [ ] **Step 3: Add fingerprint to every observation redaction path**

Update the constants and assignment expression in `src/observation/redaction.ts`:

```ts
const SENSITIVE_FIELD_PATTERN = /(password|passwd|pwd|token|fingerprint|secret|authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?id|csrf|xsrf)/i;
const SENSITIVE_URL_PARAMS = /([?&])(token|fingerprint|key|secret|password|auth|access_token|api_key|session_id|csrf|xsrf)=[^&]*/gi;
```

In `redactText`, include `fingerprint` in both the JSON-like key pattern and the `name=value` pattern so text artifacts cannot bypass structured redaction.

- [ ] **Step 4: Add extension URL masking tests**

Create `extension/src/url-redact.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { maskUrlAuthTokens } from './url-redact';

describe('maskUrlAuthTokens', () => {
  it('masks a WeChat fingerprint while preserving unrelated parameters', () => {
    const masked = maskUrlAuthTokens(
      'https://mp.weixin.qq.com/cgi-bin/searchbiz?fingerprint=fp%2B%2F%3Dsecret&query=test',
    );
    expect(masked).toContain('fingerprint=***');
    expect(masked).toContain('query=test');
    expect(masked).not.toContain('fp%2B%2F%3Dsecret');
  });

  it('does not mask an unrelated browser fingerprint label', () => {
    expect(maskUrlAuthTokens('https://example.test/?browser-fingerprint-label=stable'))
      .toBe('https://example.test/?browser-fingerprint-label=stable');
  });
});
```

- [ ] **Step 5: Run the extension test and confirm the leak**

Run:

```bash
rtk npx vitest run --project extension extension/src/url-redact.test.ts
```

Expected: the first case FAILS because `AUTH_PARAM_SEGMENTS` does not contain `fingerprint`.

- [ ] **Step 6: Mask only the exact fingerprint parameter segment**

Add `'fingerprint'` to `AUTH_PARAM_SEGMENTS` in `extension/src/url-redact.ts`. Keep the existing segment-based matcher so names such as `browser-fingerprint-label` are not automatically treated as authentication parameters unless one complete segment equals `fingerprint`.

- [ ] **Step 7: Run both redaction suites**

Run:

```bash
rtk npx vitest run --project unit src/observation/redaction.test.ts
rtk npx vitest run --project extension extension/src/url-redact.test.ts
```

Expected: both files PASS and no assertion output contains the secret value.

- [ ] **Step 8: Commit the security fix**

```bash
rtk git add src/observation/redaction.ts src/observation/redaction.test.ts extension/src/url-redact.ts extension/src/url-redact.test.ts
rtk git commit -m "fix: redact fingerprint from browser traces"
```

### Task 2: Introduce the normalized conditional-browser type

**Files:**
- Modify: `src/registry.test.ts`
- Modify: `src/registry.ts`
- Modify: `src/registry-api.ts`

- [ ] **Step 1: Add failing registry normalization tests**

Add to `src/registry.test.ts`:

```ts
it('normalizes a browser predicate into conditional metadata', () => {
  const predicate = (args: Record<string, unknown>) => args['auth-source'] !== 'env';
  const cmd = cli({
    site: 'wechat',
    name: 'search',
    access: 'read',
    strategy: Strategy.INTERCEPT,
    browser: predicate,
    args: [{ name: 'auth-source', choices: ['browser', 'env'], default: 'browser' }],
    func: async () => [],
  });

  expect(cmd.browser).toBe('conditional');
  expect(cmd.requiresBrowser).toBe(predicate);
});

it('keeps static browser declarations unchanged', () => {
  expect(cli({ site: 'static', name: 'on', access: 'read', browser: true, args: [], func: async () => [] }).browser).toBe(true);
  expect(cli({ site: 'static', name: 'off', access: 'read', browser: false, args: [], func: async () => [] }).browser).toBe(false);
});
```

- [ ] **Step 2: Run the registry test and verify the type/runtime failure**

Run:

```bash
rtk npx vitest run --project unit src/registry.test.ts
```

Expected: FAIL at TypeScript transform or runtime because `browser` only accepts booleans and normalized commands have no `requiresBrowser`.

- [ ] **Step 3: Define public input and normalized output types**

In `src/registry.ts`, introduce these types next to `CommandArgs`:

```ts
export type BrowserRequirementResolver = (args: CommandArgs) => boolean;
export type BrowserDeclaration = boolean | BrowserRequirementResolver;
export type NormalizedBrowserRequirement = boolean | 'conditional';
export type ConditionalBrowserCommandFunc = (
  page: IPage | null,
  kwargs: CommandArgs,
  debug?: boolean,
) => Promise<unknown>;
```

Add a `ConditionalBrowserCliCommand` branch whose normalized fields are:

```ts
export interface ConditionalBrowserCliCommand extends BaseCliCommand {
  browser: 'conditional';
  requiresBrowser: BrowserRequirementResolver;
  func?: ConditionalBrowserCommandFunc;
}
```

Change `CliCommand` to include that branch. Change the raw registration shape to accept `browser?: BrowserDeclaration`, `requiresBrowser?: BrowserRequirementResolver`, and all three function signatures. Add a public conditional `CliOptions` branch requiring `browser: BrowserRequirementResolver` and a nullable-page function.

- [ ] **Step 4: Normalize the predicate without evaluating it**

Implement this decision in `normalizeCommand` before static strategy fallback:

```ts
const declaredBrowser = cmd.browser;
if (typeof declaredBrowser === 'function') {
  return {
    ...cmd,
    strategy,
    browser: 'conditional',
    requiresBrowser: declaredBrowser,
    navigateBefore,
  } as ConditionalBrowserCliCommand;
}

const browser = declaredBrowser ?? (strategy !== Strategy.PUBLIC && strategy !== Strategy.LOCAL);
return browser
  ? { ...cmd, strategy, browser: true, navigateBefore } as BrowserCliCommand
  : { ...cmd, strategy, browser: false, navigateBefore } as NonBrowserCliCommand;
```

Do not call the predicate in registry code.

- [ ] **Step 5: Re-export the contract for plugins**

Extend the type export in `src/registry-api.ts`:

```ts
export type {
  CliCommand,
  Arg,
  CliOptions,
  CommandArgs,
  SiteSessionMode,
  BrowserDeclaration,
  BrowserRequirementResolver,
  NormalizedBrowserRequirement,
} from './registry.js';
```

- [ ] **Step 6: Run registry and type checks**

Run:

```bash
rtk npx vitest run --project unit src/registry.test.ts
rtk npm run typecheck
```

Expected: registry tests PASS and typecheck reports no invalid command-function unions.

- [ ] **Step 7: Commit the registry contract**

```bash
rtk git add src/registry.ts src/registry-api.ts src/registry.test.ts
rtk git commit -m "feat: add conditional browser command metadata"
```

### Task 3: Evaluate browser predicates after argument preparation

**Files:**
- Modify: `src/capabilityRouting.test.ts`
- Modify: `src/capabilityRouting.ts`
- Modify: `src/execution.test.ts`
- Modify: `src/execution.ts`

- [ ] **Step 1: Add execution tests for both predicate outcomes**

In `src/execution.test.ts`, use the file's existing mocked browser factory and add cases equivalent to:

```ts
it('skips the browser and passes null after auth-source is prepared as env', async () => {
  const func = vi.fn().mockResolvedValue([]);
  const cmd = cli({
    site: 'wechat', name: 'list', access: 'read', strategy: Strategy.COOKIE,
    browser: args => args['auth-source'] !== 'env',
    args: [{ name: 'auth-source', default: 'browser', choices: ['browser', 'env'] }],
    func,
  });

  await executeCommand(cmd, { 'auth-source': 'env' });

  expect(mockBrowserSession).not.toHaveBeenCalled();
  expect(func).toHaveBeenCalledWith(null, expect.objectContaining({ 'auth-source': 'env' }), false);
});

it('creates a browser session and passes IPage for browser auth', async () => {
  const func = vi.fn().mockResolvedValue([]);
  const cmd = cli({
    site: 'wechat', name: 'search', access: 'read', strategy: Strategy.INTERCEPT,
    browser: args => args['auth-source'] !== 'env',
    args: [{ name: 'auth-source', default: 'browser', choices: ['browser', 'env'] }],
    func,
  });

  await executeCommand(cmd, {});

  expect(mockBrowserSession).toHaveBeenCalledTimes(1);
  expect(func).toHaveBeenCalledWith(mockPage, expect.objectContaining({ 'auth-source': 'browser' }), false);
});
```

Use the actual mock names already defined by `src/execution.test.ts`; do not create a second runtime mock.

- [ ] **Step 2: Add predicate error classification tests**

```ts
it('preserves typed predicate errors and wraps unknown predicate errors', async () => {
  const typed = cli({
    site: 'wechat', name: 'typed', access: 'read', browser: () => { throw new ArgumentError('bad auth-source'); },
    args: [], func: async () => [],
  });
  await expect(executeCommand(typed, {})).rejects.toMatchObject({ code: 'ARGUMENT', exitCode: 2 });

  const unknown = cli({
    site: 'wechat', name: 'unknown', access: 'read', browser: () => { throw new Error('predicate bug'); },
    args: [], func: async () => [],
  });
  await expect(executeCommand(unknown, {})).rejects.toMatchObject({ code: 'COMMAND_EXEC', exitCode: 1 });
});
```

- [ ] **Step 3: Run focused execution tests and confirm failure**

Run:

```bash
rtk npx vitest run --project unit src/execution.test.ts src/capabilityRouting.test.ts
```

Expected: new execution cases FAIL because routing currently treats any truthy `browser` value as static browser-required and rejects a null page.

- [ ] **Step 4: Separate predicate evaluation from capability routing**

Add to `src/execution.ts`:

```ts
function resolveBrowserRequirement(cmd: CliCommand, kwargs: CommandArgs): boolean {
  if (cmd.browser !== 'conditional') return cmd.browser;
  try {
    return Boolean(cmd.requiresBrowser(kwargs));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CommandExecutionError(
      `Browser requirement evaluation failed for ${fullName(cmd)}: ${getErrorMessage(error)}`,
    );
  }
}
```

Import `CliError`. After `prepareCommandArgs`, call the helper exactly once and pass its boolean to capability routing. Change `shouldUseBrowserSession` to accept a resolved boolean override:

```ts
export function shouldUseBrowserSession(cmd: CliCommand, resolvedBrowser = cmd.browser !== false): boolean {
  if (!resolvedBrowser) return false;
  if (cmd.func) return true;
  if (!cmd.pipeline || cmd.pipeline.length === 0) return true;
  if (cmd.navigateBefore) return true;
  return pipelineNeedsBrowserSession(cmd.pipeline as Record<string, unknown>[]);
}
```

- [ ] **Step 5: Dispatch conditional functions with a nullable page**

Update `runCommandFunc`:

```ts
function runCommandFunc(cmd: CliCommand, page: IPage | null, kwargs: CommandArgs, debug: boolean): Promise<unknown> {
  if (cmd.browser === false) return cmd.func!(kwargs, debug);
  if (cmd.browser === 'conditional') return cmd.func!(page, kwargs, debug);
  if (!page) {
    throw new CommandExecutionError(`Command ${fullName(cmd)} requires a browser session but none was provided`);
  }
  return cmd.func!(page, kwargs, debug);
}
```

- [ ] **Step 6: Run execution, routing, and type tests**

Run:

```bash
rtk npx vitest run --project unit src/execution.test.ts src/capabilityRouting.test.ts
rtk npm run typecheck
```

Expected: all focused tests PASS; the env case reports zero browser-session calls.

- [ ] **Step 7: Commit execution routing**

```bash
rtk git add src/execution.ts src/execution.test.ts src/capabilityRouting.ts src/capabilityRouting.test.ts
rtk git commit -m "feat: route conditional commands after argument parsing"
```

### Task 4: Add explicit browser-window focus for login

**Files:**
- Modify: `src/types.ts`
- Modify: `src/browser/page.ts`
- Modify: `src/browser/page.test.ts`
- Modify: `src/browser/cdp.ts`
- Modify: `src/browser/cdp.test.ts`
- Modify: `extension/src/protocol.ts`
- Modify: `extension/src/background.ts`
- Modify: `extension/src/background.test.ts`

- [ ] **Step 1: Add failing Page and extension tests**

In `src/browser/page.test.ts`, call `page.focusWindow()` and assert the bridge receives a tabs command with `op: 'focus'` and the active page/session identity. In `extension/src/background.test.ts`, send that command for an owned automation tab and assert:

```ts
expect(chrome.windows.update).toHaveBeenCalledWith(windowId, { focused: true });
expect(chrome.tabs.update).toHaveBeenCalledWith(tabId, { active: true });
```

Add a rejection case for a tab outside the current automation session. In `src/browser/cdp.test.ts`, assert direct CDP mode sends `Page.bringToFront`.

- [ ] **Step 2: Run focused tests and confirm the operation is absent**

Run:

```bash
rtk npx vitest run --project unit src/browser/page.test.ts src/browser/cdp.test.ts
rtk npx vitest run --project extension extension/src/background.test.ts
```

Expected: FAIL because `IPage` and the tabs protocol do not expose a focus operation.

- [ ] **Step 3: Extend the public page contract**

Add to `IPage` in `src/types.ts`:

```ts
/** Focus the browser window containing the active page for interactive login. */
focusWindow?(): Promise<void>;
```

Implement in `src/browser/page.ts`:

```ts
async focusWindow(): Promise<void> {
  await sendCommandFull('tabs', {
    op: 'focus',
    ...this._cmdOpts(),
    ...this._sessionOpts(),
  });
}
```

Implement in `src/browser/cdp.ts` using the existing bridge:

```ts
async focusWindow(): Promise<void> {
  await this.bridge.send('Page.bringToFront');
}
```

- [ ] **Step 4: Focus only an owned automation window**

Extend the tabs operation union in `extension/src/protocol.ts` with `'focus'`. Add a `case 'focus'` in `extension/src/background.ts` that resolves the current leased tab, verifies it belongs to the active automation session, calls `chrome.windows.update(tab.windowId, { focused: true })`, then calls `chrome.tabs.update(tabId, { active: true })`. Return `{ focused: true }`; never focus an arbitrary user tab supplied by raw ID.

- [ ] **Step 5: Run focused tests and typecheck**

```bash
rtk npx vitest run --project unit src/browser/page.test.ts src/browser/cdp.test.ts
rtk npx vitest run --project extension extension/src/background.test.ts
rtk npm run typecheck
```

Expected: all focused tests PASS and the optional interface method is valid for existing test doubles.

- [ ] **Step 6: Commit the focus capability**

```bash
rtk git add src/types.ts src/browser/page.ts src/browser/page.test.ts src/browser/cdp.ts src/browser/cdp.test.ts extension/src/protocol.ts extension/src/background.ts extension/src/background.test.ts
rtk git commit -m "feat: allow adapters to focus browser login window"
```

### Task 5: Expose conditional metadata consistently

**Files:**
- Modify: `src/commanderAdapter.test.ts`
- Modify: `src/commanderAdapter.ts`
- Modify: `src/serialization.test.ts`
- Modify: `src/serialization.ts`
- Modify: `src/help.test.ts`
- Modify: `src/help.ts`

- [ ] **Step 1: Add failing serialization and help tests**

Add a normalized conditional fixture and assertions:

```ts
const conditional = cli({
  site: 'wechat', name: 'search', access: 'read', strategy: Strategy.INTERCEPT,
  browser: args => args['auth-source'] !== 'env', args: [], func: async () => [],
});

expect(serializeCommand(conditional)).toMatchObject({ browser: 'conditional' });
expect(serializeCommand(conditional)).not.toHaveProperty('requiresBrowser');
expect(formatRegistryHelpText(conditional)).toContain('Browser: conditional');
expect(commandHelpData(conditional)).toMatchObject({ browser: 'conditional' });
```

In `src/commanderAdapter.test.ts`, register the conditional command and assert that `--window`, `--site-session`, and `--keep-tab` exist.

- [ ] **Step 2: Run the focused tests and confirm boolean coercion**

Run:

```bash
rtk npx vitest run --project unit src/serialization.test.ts src/help.test.ts src/commanderAdapter.test.ts
```

Expected: FAIL because serialization/help currently converts the string to `true`, and Commander branches on a boolean-only assumption.

- [ ] **Step 3: Add shared metadata helpers**

In `src/registry.ts`, export:

```ts
export function hasBrowserCapability(cmd: CliCommand): boolean {
  return cmd.browser !== false;
}

export function browserRequirementLabel(cmd: CliCommand): 'yes' | 'no' | 'conditional' {
  return cmd.browser === 'conditional' ? 'conditional' : cmd.browser ? 'yes' : 'no';
}
```

Use `hasBrowserCapability` for browser-option visibility and `browserRequirementLabel` for human-readable text.

- [ ] **Step 4: Preserve the exact serialized value**

In `serializeCommand` and structured help's `compactCommand`, replace `!!cmd.browser` with:

```ts
browser: cmd.browser,
```

Replace text help's ternary with:

```ts
meta.push(`Browser: ${browserRequirementLabel(cmd)}`);
```

Use `hasBrowserCapability(cmd)` in command/site help when deciding whether browser common options are present.

- [ ] **Step 5: Show browser flags for conditional commands**

In `src/commanderAdapter.ts`, replace all metadata checks that control browser-only flags/options with `hasBrowserCapability(cmd)`. Continue passing `windowMode`, `siteSession`, and `keepTab` only when those option values are strings.

- [ ] **Step 6: Run focused tests and snapshots**

Run:

```bash
rtk npx vitest run --project unit src/serialization.test.ts src/help.test.ts src/commanderAdapter.test.ts
```

Expected: PASS; structured output contains the literal string `conditional` and no function.

- [ ] **Step 7: Commit the metadata surface**

```bash
rtk git add src/registry.ts src/commanderAdapter.ts src/commanderAdapter.test.ts src/serialization.ts src/serialization.test.ts src/help.ts src/help.test.ts
rtk git commit -m "feat: expose conditional browser metadata"
```

### Task 6: Support precompiled manifest placeholders safely

**Files:**
- Modify: `src/manifest-types.ts`
- Modify: `src/build-manifest.test.ts`
- Modify: `src/build-manifest.ts`
- Modify: `src/discovery.ts`
- Create: `src/discovery.test.ts`
- Modify: `src/execution.test.ts`
- Modify: `src/execution.ts`

- [ ] **Step 1: Add a manifest serialization test**

Add a conditional command fixture to `src/build-manifest.test.ts` and assert the generated entry:

```ts
expect(entries).toContainEqual(expect.objectContaining({
  site: 'wechat',
  name: 'list',
  browser: 'conditional',
}));
expect(JSON.stringify(entries)).not.toContain('requiresBrowser');
```

- [ ] **Step 2: Add a lazy hydration regression test**

In `src/execution.test.ts`, construct an `InternalCliCommand` manifest placeholder with `_hydrateBeforeBrowserRouting: true`, `_lazy: true`, and a temporary module path. Give it a sentinel predicate that throws if called. The imported module must re-register the same command with `browser: args => args['auth-source'] !== 'env'`. Execute with `'auth-source': 'env'` and assert:

```ts
expect(mockBrowserSession).not.toHaveBeenCalled();
expect(registeredFunc).toHaveBeenCalledWith(null, expect.objectContaining({ 'auth-source': 'env' }), false);
expect(sentinelPredicate).not.toHaveBeenCalled();
```

This test must fail if hydration happens inside `runCommand`, because that is after browser routing.

- [ ] **Step 3: Run the manifest and execution tests**

Run:

```bash
rtk npx vitest run --project unit src/build-manifest.test.ts src/execution.test.ts
```

Expected: FAIL because `ManifestEntry.browser` only permits boolean and execution routes before loading the real predicate.

- [ ] **Step 4: Permit only the serializable third state in manifests**

Change `ManifestEntry.browser` in `src/manifest-types.ts`:

```ts
browser: boolean | 'conditional';
```

Keep `toManifestEntry` in `src/build-manifest.ts` as a direct metadata copy:

```ts
browser: cmd.browser,
```

Do not add `requiresBrowser` to `ManifestEntry`.

- [ ] **Step 5: Register lazy conditional placeholders**

Extend `InternalCliCommand` in `src/registry.ts`:

```ts
export type InternalCliCommand = CliCommand & {
  _lazy?: boolean;
  _modulePath?: string;
  _hydrateBeforeBrowserRouting?: boolean;
};
```

In `src/discovery.ts`, translate manifest metadata back into valid registration input:

```ts
const hydrateBeforeBrowserRouting = entry.browser === 'conditional';
const manifestBrowser = hydrateBeforeBrowserRouting
  ? (() => { throw new Error(`Conditional manifest placeholder ${entry.site}/${entry.name} was not hydrated`); })
  : entry.browser;

const cmd = {
  // existing manifest fields
  browser: manifestBrowser,
  _lazy: true,
  _modulePath: modulePath,
  _hydrateBeforeBrowserRouting: hydrateBeforeBrowserRouting,
};
```

`registerCommand` normalizes the sentinel like any other predicate, so every stored `CliCommand` remains type-valid. The sentinel is an invariant guard and must never run.

Change the existing declaration to `export async function loadFromManifest(...)` without re-exporting it from the package entrypoint. In `src/discovery.test.ts`, write a temporary one-entry manifest with `browser: 'conditional'`, invoke `loadFromManifest`, and assert the registered command has `browser: 'conditional'`, `_hydrateBeforeBrowserRouting: true`, `_lazy: true`, and a function-valued `requiresBrowser`.

- [ ] **Step 6: Hydrate before browser routing**

Refactor the existing lazy import block in `runCommand` into an idempotent helper:

```ts
async function hydrateLazyCommand(cmd: CliCommand): Promise<CliCommand> {
  const internal = cmd as InternalCliCommand;
  if (!internal._lazy || !internal._modulePath) return cmd;
  await loadLazyModule(internal);
  return getRegistry().get(fullName(cmd)) ?? cmd;
}
```

When `_hydrateBeforeBrowserRouting` is true, call `hydrateLazyCommand` immediately after argument preparation and before `resolveBrowserRequirement`. Verify that the returned command is a different registry object, still has `browser: 'conditional'`, has a real `requiresBrowser`, and no longer carries the hydration marker; otherwise throw `CommandExecutionError` naming the malformed adapter. Keep ordinary lazy static commands on their current load path.

- [ ] **Step 7: Run manifest, execution, discovery, and type tests**

Run:

```bash
rtk npx vitest run --project unit src/build-manifest.test.ts src/discovery.test.ts src/execution.test.ts src/registry.test.ts
rtk npm run typecheck
```

Expected: PASS; the lazy env fixture never invokes the browser factory.

- [ ] **Step 8: Commit manifest support**

```bash
rtk git add src/manifest-types.ts src/build-manifest.ts src/build-manifest.test.ts src/discovery.ts src/discovery.test.ts src/execution.ts src/execution.test.ts src/registry.ts
rtk git commit -m "feat: hydrate conditional manifest commands before routing"
```

### Task 7: Document, version, and verify the core release

**Files:**
- Modify: `docs/developer/ts-adapter.md`
- Modify: `docs/guide/plugins.md`
- Modify: `docs/zh/guide/plugins.md`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Document the public registration contract**

Add this example to all three adapter/plugin guides, translating prose in the Chinese guide:

```ts
cli({
  site: 'example',
  name: 'conditional',
  access: 'read',
  strategy: Strategy.COOKIE,
  browser: args => args['auth-source'] !== 'env',
  args: [
    { name: 'auth-source', choices: ['browser', 'env'], default: 'browser' },
  ],
  columns: ['status'],
  func: async (page, args) => [{ status: page ? 'browser' : 'environment' }],
});
```

State that predicates run after defaults/coercion, conditional functions receive `IPage | null`, browser flags remain visible, and structured metadata serializes `browser: "conditional"` without the function.

- [ ] **Step 2: Run documentation build**

Run:

```bash
rtk npm run docs:build
```

Expected: VitePress exits 0 with no broken Markdown import or code-fence errors.

- [ ] **Step 3: Set the feature release version**

Run:

```bash
rtk npm version 2.1.0 --no-git-tag-version
```

Expected: `package.json` and the root package entry in `package-lock.json` report `2.1.0`. Inspect the diff and do not manually alter unrelated workspace package versions.

- [ ] **Step 4: Run the complete verification matrix**

Run:

```bash
rtk npm run typecheck
rtk npm test
rtk npm run build
rtk npm run check:typed-error-lint
rtk git diff --check
```

Expected: every command exits 0; Vitest reports zero failed tests; build regenerates a manifest in which static commands remain boolean and conditional commands are the literal string.

- [ ] **Step 5: Inspect secret and contract regressions**

Run:

```bash
rtk node -e "const fs=require('node:fs');const text=fs.readFileSync('cli-manifest.json','utf8');if(text.includes('requiresBrowser'))process.exit(1)"
rtk npx vitest run --project unit src/observation/redaction.test.ts src/build-manifest.test.ts
rtk npx vitest run --project extension extension/src/url-redact.test.ts
```

Expected: all commands exit 0. The manifest contains no predicate source, and the focused security suites prove raw/encoded fingerprint values are removed before artifact serialization.

- [ ] **Step 6: Commit documentation and versioning**

```bash
rtk git add docs/developer/ts-adapter.md docs/guide/plugins.md docs/zh/guide/plugins.md package.json package-lock.json cli-manifest.json
rtk git commit -m "docs: release conditional browser support"
```

- [ ] **Step 7: Request code review before publishing**

Run `superpowers:requesting-code-review` against the complete diff. Resolve correctness, security, and compatibility findings before publishing `@sovovs/bycli@2.1.0` or beginning the companion plugin's integration tests.
