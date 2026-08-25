# ima Reader Browser Bridge Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make private ima reader commands fail fast against incompatible Browser Bridge builds and publish a uniquely identifiable compatible extension.

**Architecture:** Extend the existing Browser Bridge hello capability negotiation with `ima-reader-v1`, gate all four private ima actions in the daemon before WebSocket dispatch, and guarantee correlated extension error responses. Keep CLI and extension versioning independent while enforcing a new extension release version and release-time version checks.

**Tech Stack:** TypeScript, Chrome Manifest V3, WebSocket, Vitest, Node.js release scripts, GitHub Actions

---

### Task 1: Declare and enforce the ima reader capability

**Files:**
- Modify: `src/browser/extension-capabilities.test.ts`
- Modify: `src/browser/extension-capabilities.ts`

- [ ] **Step 1: Write the failing capability policy tests**

Import `IMA_READER_CAPABILITY` and assert that each private ima action requires it, that unrelated actions remain ungated, and that the specialized hint mentions private ima reading:

```ts
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `rtk npm test -- src/browser/extension-capabilities.test.ts`

Expected: FAIL because `IMA_READER_CAPABILITY` is not exported and ima actions currently return no requirement.

- [ ] **Step 3: Implement the minimal capability mapping**

Add:

```ts
export const IMA_READER_CAPABILITY = 'ima-reader-v1';

const IMA_READER_ACTIONS = new Set([
  'ima-auth-start',
  'ima-auth-read',
  'ima-reader-request',
  'ima-auth-release',
]);
```

Update `requiredExtensionCapability` to return `IMA_READER_CAPABILITY` for those actions, preserving `focus-window-v1` behavior. Add an ima-specific branch to `extensionCapabilityHint`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `rtk npm test -- src/browser/extension-capabilities.test.ts`

Expected: PASS.

### Task 2: Verify daemon fail-fast behavior

**Files:**
- Modify: `src/daemon.test.ts`

- [ ] **Step 1: Write a daemon integration test for an old extension**

Start the daemon on an isolated port, connect a test WebSocket extension, send a hello payload with only `focus-window-v1`, and POST an `ima-auth-start` command. Assert:

```ts
expect(response.status).toBe(412);
await expect(response.json()).resolves.toMatchObject({
  id: 'ima-capability-command',
  ok: false,
  errorCode: 'extension_capability_missing',
  error: expect.stringContaining('ima-reader-v1'),
  errorHint: expect.stringMatching(/update.*reload/i),
});
expect(extensionMessages).not.toContainEqual(
  expect.objectContaining({ id: 'ima-capability-command' }),
);
```

- [ ] **Step 2: Run the daemon test and verify its initial state**

Run: `rtk npm test -- src/daemon.test.ts`

Expected after Task 1: PASS, proving the existing generic `/command` capability gate enforces the new mapping without additional daemon production changes. If the test fails because the command is dispatched, fix only the shared gate integration needed to make this assertion pass.

### Task 3: Advertise the capability and guarantee extension error replies

**Files:**
- Modify: `extension/src/background.test.ts`
- Modify: `extension/src/background.ts`

- [ ] **Step 1: Extend the hello regression test and verify RED**

Rename the hello test to cover Browser Bridge capabilities and assert:

```ts
capabilities: expect.arrayContaining(['focus-window-v1', 'ima-reader-v1']),
```

Run: `rtk npm test -- extension/src/background.test.ts -t "advertises the Browser Bridge capabilities"`

Expected: FAIL because the hello payload does not advertise `ima-reader-v1`.

- [ ] **Step 2: Advertise `ima-reader-v1` and verify GREEN**

Change the extension capability declaration to:

```ts
const EXTENSION_CAPABILITIES = ['focus-window-v1', 'ima-reader-v1'] as const;
```

Run the focused hello test again. Expected: PASS.

- [ ] **Step 3: Write a failing correlated-error response test**

Deliver a valid command whose handler throws before it can return a normal `CommandResult`, then assert that the active socket sends:

```ts
expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
  id: 'throwing-command',
  ok: false,
  error: expect.stringContaining('forced handler failure'),
});
```

Also assert malformed JSON remains log-only and does not create an uncorrelated response.

- [ ] **Step 4: Run the correlated-error test and verify RED**

Run: `rtk npm test -- extension/src/background.test.ts -t "correlated error"`

Expected: FAIL because the current outer `onmessage` catch only logs the exception.

- [ ] **Step 5: Implement the response guarantee**

Parse into an `unknown` value, retain a validated string command ID, and in the catch block send a failure only when the socket is still current and an ID is available:

```ts
thisWs.onmessage = async (event) => {
  if (ws !== thisWs) return;
  let commandId: string | undefined;
  try {
    const parsed = JSON.parse(event.data as string) as { id?: unknown };
    commandId = typeof parsed.id === 'string' ? parsed.id : undefined;
    const result = await handleCommand(parsed as Command);
    if (ws !== thisWs) return;
    safeSend(thisWs, result);
  } catch (err) {
    console.error('[bycli] Message handling error:', err);
    if (ws === thisWs && commandId) {
      safeSend(thisWs, {
        id: commandId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
```

- [ ] **Step 6: Run extension tests and verify GREEN**

Run: `rtk npm test -- extension/src/background.test.ts`

Expected: PASS.

### Task 4: Create an immutable extension release identity

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension/package.json`
- Modify: `extension/package-lock.json`
- Modify: `src/extension-manifest-regression.test.ts`
- Create: `extension/scripts/check-release-version.mjs`
- Modify: `.github/workflows/build-extension.yml`
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Write failing version consistency tests**

Extend `src/extension-manifest-regression.test.ts` to read all three JSON files and assert:

```ts
expect(manifest.version).toBe(extensionPackage.version);
expect(lockfile.version).toBe(extensionPackage.version);
expect(lockfile.packages?.['']?.version).toBe(extensionPackage.version);
expect(extensionPackage.version).toBe('2.1.21');
```

- [ ] **Step 2: Run the regression test and verify RED**

Run: `rtk npm test -- src/extension-manifest-regression.test.ts`

Expected: FAIL because the current extension version is 2.1.20.

- [ ] **Step 3: Bump the extension version**

Set the extension version to `2.1.21` in `manifest.json`, `package.json`, and both lockfile version locations.

- [ ] **Step 4: Run the regression test and verify GREEN**

Run: `rtk npm test -- src/extension-manifest-regression.test.ts`

Expected: PASS.

- [ ] **Step 5: Add a release guard script**

Create `extension/scripts/check-release-version.mjs` that:

- reads and compares manifest, package, and lockfile versions;
- finds the latest reachable `ext-v*` tag when Git metadata is available;
- detects extension changes since that tag;
- fails when extension inputs changed but the current version is not greater than the tagged version;
- verifies `GITHUB_REF_NAME=ext-vX.Y.Z` matches extension version when running on an extension tag;
- skips only the Git-history comparison when no Git metadata or extension tag exists, while retaining file consistency checks.

- [ ] **Step 6: Add script-level regression tests**

Export pure helpers for dotted-version comparison and tag/version validation, and test them from `src/extension-manifest-regression.test.ts` through dynamic import. Cover equal-version rejection, greater-version acceptance, and mismatched tag rejection.

- [ ] **Step 7: Wire the guard into both extension release workflows**

Set checkout `fetch-depth: 0`, then add before build:

```yaml
- name: Verify extension release version
  run: node scripts/check-release-version.mjs
  working-directory: extension
```

- [ ] **Step 8: Run release guard and regression tests**

Run:

```bash
rtk node extension/scripts/check-release-version.mjs
rtk npm test -- src/extension-manifest-regression.test.ts
```

Expected: both exit successfully with version 2.1.21.

### Task 5: Build artifacts and verify the complete fix

**Files:**
- Regenerate: `extension/dist/background.js`

- [ ] **Step 1: Build the extension**

Run: `rtk npm run build --prefix extension`

Expected: exit 0 and `extension/dist/background.js` contains `ima-reader-v1` and the correlated error response logic.

- [ ] **Step 2: Package the extension**

Run: `rtk npm run package:release --prefix extension -- --out ../extension-package`

Expected: exit 0 and `extension-package/manifest.json` reports version 2.1.21.

- [ ] **Step 3: Run focused verification**

Run:

```bash
rtk npm test -- src/browser/extension-capabilities.test.ts src/daemon.test.ts src/extension-manifest-regression.test.ts extension/src/background.test.ts
rtk npm run typecheck
rtk npm run typecheck --prefix extension
```

Expected: all selected tests and both type checks pass.

- [ ] **Step 4: Run full verification**

Run:

```bash
rtk npm test
rtk npm run build
rtk git diff --check
```

Expected: all tests pass, the CLI build exits 0, and no whitespace errors are reported.

- [ ] **Step 5: Inspect the final diff**

Run: `rtk git status --short && rtk git diff --stat && rtk git diff`

Confirm that only capability negotiation, extension response handling, release version enforcement, generated extension output, tests, and the approved documentation changed. Preserve unrelated untracked user files.
