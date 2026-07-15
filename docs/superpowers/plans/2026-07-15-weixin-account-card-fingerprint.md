# Weixin Account Card Fingerprint Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bycli weixin accounts` open the WeChat “账号名片” picker, capture the current session fingerprint, and then call `search_biz` with the correct dynamic Referer.

**Architecture:** Keep authentication and API transport boundaries unchanged. Refactor the one-shot fingerprint evaluator into explicit install, picker-open, dialog-submit, read, and cleanup operations, all sharing one deadline and retaining only the fingerprint value. Continue using the same `executeSearchBiz` path for browser and environment modes, but generate its Referer from the current token.

**Tech Stack:** JavaScript/JSDoc, byCLI Browser Bridge `IPage`, Vitest, Node `URL`/`URLSearchParams`.

---

## File map

- Modify `clis/weixin/_wechat/fingerprint.js`: account-card picker state machine and request capture lifecycle.
- Modify `clis/weixin/_wechat/fingerprint.test.js`: simulated real DOM, delayed rendering, manual-open fallback, timeout, cleanup, and no-insert regressions.
- Modify `clis/weixin/_wechat/search-biz.js`: token-aware editor Referer.
- Modify `clis/weixin/_wechat/search-biz.test.js`: exact Referer contract for browser and env transports.
- Modify `docs/adapters/browser/weixin.md`: document automatic account-card interaction and foreground fallback.

### Task 1: Drive the account-card picker before capturing fingerprint

**Files:**
- Modify: `clis/weixin/_wechat/fingerprint.test.js`
- Modify: `clis/weixin/_wechat/fingerprint.js`

- [ ] **Step 1: Replace the happy-path DOM fixture with the real interaction states**

Extend `makeRealPage` so it models a visible header entry with exact text `账号名片`, an initially hidden dialog titled `插入账号名片`, one dialog-scoped input, and a search trigger that calls the wrapped `fetch`. Keep these fixture flags explicit:

```js
function makeRealPage({
  entryInitiallyVisible = true,
  dialogInitiallyVisible = false,
  revealEntryAfterWait = false,
  manualDialogAfterFocus = false,
  inputCount = 1,
  triggerRequest = true,
} = {})
```

The header entry click must only set `dialogVisible = true`. The fixture must record `entryClicks`, `insertClicks`, submitted query text, `focusWindow` calls, and the sequence of evaluator operations.

- [ ] **Step 2: Write failing state-machine tests**

Add tests with these exact observable contracts:

```js
it('installs capture before opening the account-card picker and submits inside its dialog', async () => {
  const fixture = makeRealPage();
  await expect(captureSearchBizFingerprint(fixture.page, '前端之神', 1_000))
    .resolves.toBe('前端之神-fp');
  expect(fixture.operations.indexOf('install')).toBeLessThan(fixture.operations.indexOf('open-picker'));
  expect(fixture.entryClicks()).toBe(1);
  expect(fixture.submittedQuery()).toBe('前端之神');
  expect(fixture.insertClicks()).toBe(0);
});

it('waits for delayed editor rendering instead of failing immediately', async () => {
  const fixture = makeRealPage({ entryInitiallyVisible: false, revealEntryAfterWait: true });
  await expect(captureSearchBizFingerprint(fixture.page, '微信派', 1_000)).resolves.toBe('微信派-fp');
  expect(fixture.page.wait).toHaveBeenCalled();
});

it('focuses the window and continues after the user manually opens the dialog', async () => {
  const fixture = makeRealPage({ entryInitiallyVisible: false, manualDialogAfterFocus: true });
  await expect(captureSearchBizFingerprint(fixture.page, '微信派', 1_000)).resolves.toBe('微信派-fp');
  expect(fixture.page.focusWindow).toHaveBeenCalledTimes(1);
  expect(fixture.entryClicks()).toBe(0);
});

it('rejects an ambiguous dialog input without using a global search input', async () => {
  const fixture = makeRealPage({ dialogInitiallyVisible: true, inputCount: 2 });
  await expect(captureSearchBizFingerprint(fixture.page, '微信派', 1_000))
    .rejects.toBeInstanceOf(CommandExecutionError);
});
```

Retain the existing concurrency, wrapper restoration, request-secret retention, polling-error, and timeout tests. Update the old “control was not found immediately” expectation because absence now enters the timed fallback state.

- [ ] **Step 3: Run the focused test and confirm RED**

Run:

```bash
rtk npx vitest run clis/weixin/_wechat/fingerprint.test.js --project adapter
```

Expected: the new picker tests fail because the current `install` operation immediately searches for an already-visible input and never opens `账号名片`.

- [ ] **Step 4: Split evaluator behavior into explicit operations**

Keep the existing `STATE_KEY` and wrapper installation, but make `install` install wrappers only. Add two page operations:

```js
const pickerResult = await page.evaluate(({ operation, stateKey }) => {
  if (operation !== 'open-picker') return { dialogVisible: false, entryClicked: false };
  const visible = element => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const exactText = element => (element.textContent ?? '').replace(/\s+/g, '').trim();
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .weui-desktop-dialog'))
    .filter(visible)
    .filter(dialog => /插入账号名片/.test(dialog.textContent ?? ''));
  if (dialogs.length === 1) return { dialogVisible: true, entryClicked: false };
  const entries = Array.from(document.querySelectorAll('header button, header a, header [role="button"], header [class*="tool"], [role="banner"] button, [role="banner"] a, [role="banner"] [role="button"], [role="banner"] [class*="tool"]'))
    .filter(visible)
    .filter(element => exactText(element) === '账号名片');
  if (entries.length !== 1) return { dialogVisible: false, entryClicked: false };
  const target = entries[0].closest('button, a, [role="button"]') ?? entries[0];
  target.click();
  return { dialogVisible: false, entryClicked: true };
}, { operation: 'open-picker', stateKey: STATE_KEY });
```

The implementation may include known WeChat toolbar container classes observed in fixtures, but must retain exact visible text and a header/banner scope. It must never click a result row or the dialog’s `插入` button.

Add a dialog-scoped submit operation:

```js
const submitted = await page.evaluate(({ operation, query: searchQuery }) => {
  if (operation !== 'submit-search') return { submitted: false, reason: 'operation' };
  const visible = element => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .weui-desktop-dialog'))
    .filter(visible)
    .filter(dialog => /插入账号名片/.test(dialog.textContent ?? ''));
  if (dialogs.length !== 1) return { submitted: false, reason: 'dialog' };
  const inputs = Array.from(dialogs[0].querySelectorAll('input[type="text"], input[type="search"], .weui-desktop-search__input'))
    .filter(visible);
  if (inputs.length !== 1) return { submitted: false, reason: 'input', inputCount: inputs.length };
  const input = inputs[0];
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, searchQuery); else input.value = searchQuery;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  for (const type of ['keydown', 'keypress', 'keyup']) {
    input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true }));
  }
  return { submitted: true };
}, { operation: 'submit-search', query });
```

- [ ] **Step 5: Add the deadline-based automatic and manual phases**

Use the existing `startedAt`, `timeoutMs`, 100 ms polling interval, and one absolute deadline. For at most `Math.min(5_000, timeoutMs)` automatically look for/click the header entry and wait for the dialog. Click the entry no more than once. If the dialog is still absent after that phase, call `page.focusWindow()` once when available and continue waiting for a manually opened dialog until the original deadline.

When the dialog appears, run `submit-search` exactly once. Map `reason: 'input'` to `CommandExecutionError('WeChat account-card search input was not found', ...)`. If no dialog or no fingerprint appears before the absolute deadline, throw `TimeoutError('WeChat account-card search fingerprint capture', timeoutMs / 1000)`.

Keep cleanup in the existing `finally`, and keep the per-page promise queue unchanged.

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run:

```bash
rtk npx vitest run clis/weixin/_wechat/fingerprint.test.js --project adapter
```

Expected: all fingerprint tests pass, including existing wrapper-restoration and concurrency tests.

- [ ] **Step 7: Commit the picker state machine**

```bash
rtk git add clis/weixin/_wechat/fingerprint.js clis/weixin/_wechat/fingerprint.test.js
rtk git commit -m "fix(weixin): open account card picker for fingerprint"
```

### Task 2: Generate an exact token-aware Referer

**Files:**
- Modify: `clis/weixin/_wechat/search-biz.test.js`
- Modify: `clis/weixin/_wechat/search-biz.js`

- [ ] **Step 1: Tighten the request assertion**

Replace the loose Referer assertion with an exact parsed contract:

```js
const referer = new URL(init.headers.Referer);
expect(referer.origin + referer.pathname).toBe('https://mp.weixin.qq.com/cgi-bin/appmsg');
expect(Object.fromEntries(referer.searchParams)).toEqual({
  t: 'media/appmsg_edit_v2',
  action: 'edit',
  isNew: '1',
  type: '10',
  token: 'token-secret',
  lang: 'zh_CN',
});
```

Keep the existing assertions that browser transport omits an explicit Cookie header and env transport includes it.

- [ ] **Step 2: Run the search transport test and confirm RED**

Run:

```bash
rtk npx vitest run clis/weixin/_wechat/search-biz.test.js --project adapter
```

Expected: Referer assertion fails because the current constant omits token and language.

- [ ] **Step 3: Build Referer from the current credentials**

Replace the static `REFERER` constant with:

```js
function buildReferer(token) {
  const params = new URLSearchParams({
    t: 'media/appmsg_edit_v2', action: 'edit', isNew: '1', type: '10',
    token, lang: 'zh_CN',
  });
  return `https://${DOMAIN}/cgi-bin/appmsg?${params}`;
}
```

Construct headers inside `executeSearchBiz` as:

```js
const headers = {
  Referer: buildReferer(credentials.token),
  'X-Requested-With': 'XMLHttpRequest',
};
```

Do not add captured browser headers such as `sec-ch-ua`, `priority`, or analytics cookies.

- [ ] **Step 4: Run focused search and accounts tests**

Run:

```bash
rtk npx vitest run clis/weixin/_wechat/search-biz.test.js clis/weixin/accounts.test.js --project adapter
```

Expected: both test files pass and neither formatted error nor request assertion exposes credentials.

- [ ] **Step 5: Commit the transport correction**

```bash
rtk git add clis/weixin/_wechat/search-biz.js clis/weixin/_wechat/search-biz.test.js
rtk git commit -m "fix(weixin): send token-aware search referer"
```

### Task 3: Document and verify the complete browser flow

**Files:**
- Modify: `docs/adapters/browser/weixin.md`
- Test: `src/weixin-built-in-docs.test.ts`

- [ ] **Step 1: Update user-facing authentication documentation**

State that `accounts` automatically opens the `账号名片` picker, searches without selecting/inserting a result, and captures the request fingerprint only in memory. State that if the entry cannot be opened automatically, the browser is focused and the command waits for the user to open the `插入账号名片` dialog before continuing.

- [ ] **Step 2: Run focused Weixin tests**

Run:

```bash
rtk npx vitest run \
  clis/weixin/_wechat/fingerprint.test.js \
  clis/weixin/_wechat/search-biz.test.js \
  clis/weixin/accounts.test.js \
  src/weixin-built-in-docs.test.ts \
  --project adapter --project unit
```

Expected: all selected files pass.

- [ ] **Step 3: Run repository gates**

Run each command and require exit code 0:

```bash
rtk npm run typecheck
rtk npm run build
rtk npm run docs:build
rtk npm run check:typed-error-lint
rtk npm run check:silent-column-drop
rtk npm test -- --reporter=dot
rtk git diff --check
```

The build must continue producing 904 manifest entries, and tracked files must be clean after generated artifacts are rebuilt.

- [ ] **Step 4: Commit documentation**

```bash
rtk git add docs/adapters/browser/weixin.md
rtk git commit -m "docs(weixin): explain account card fingerprint capture"
```

- [ ] **Step 5: Perform a credential-safe manual smoke test**

With Chrome logged into the WeChat Official Accounts backend, run:

```bash
bycli-dev weixin accounts "前端之神" --limit 5 --auth-source browser --window foreground -f json
```

Expected: the command opens `账号名片`, searches inside `插入账号名片`, does not insert a card or save the draft, and returns rows containing only `nickname`, `fakeid`, and `alias`. Do not retain or paste trace URLs, Cookie headers, token, or fingerprint.
