# Weixin Account-Card Overflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open WeChat's account-card picker when it is nested under `#editor_showmore`.

**Architecture:** Add a constrained DOM route to the existing fingerprint-capture picker loop. It uses the exact editor trigger and profile menu IDs before falling back to the current generic heuristics; no public command interface changes.

**Tech Stack:** JavaScript, Vitest, byCLI browser page abstraction.

---

### Task 1: Prove the concrete overflow markup is not currently handled

**Files:**
- Modify: `clis/weixin/_wechat/fingerprint.test.js`
- Test: `clis/weixin/_wechat/fingerprint.test.js`

- [ ] **Step 1: Write the failing test**

Add a `makeAccountCardPage({ wechatEditorOverflow: true })` fixture variant with a visible `#editor_showmore` trigger and a hidden menu that exposes only after the trigger is clicked. Model its profile item as `#js_editor_insertProfile` inside `.editor_showmore_dropdown_menu`.

```js
it('opens account card through the WeChat editor show-more menu', async () => {
  const fixture = makeAccountCardPage({ wechatEditorOverflow: true });
  await expect(captureSearchBizFingerprint(fixture.page, '前端之神', 1_000))
    .resolves.toBe('前端之神-fp');
  expect(fixture.weixinOverflowClicks()).toBe(1);
  expect(fixture.entryClicks()).toBe(1);
  expect(fixture.formatOverflowClicks()).toBe(0);
  expect(fixture.insertClicks()).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project adapter clis/weixin/_wechat/fingerprint.test.js`

Expected: the new test fails because the current generic toolbar route does not recognize `#editor_showmore` without a toolbar ancestor.

### Task 2: Add the constrained WeChat route

**Files:**
- Modify: `clis/weixin/_wechat/fingerprint.js:153-250`
- Test: `clis/weixin/_wechat/fingerprint.test.js`

- [ ] **Step 1: Implement the minimal DOM route**

Before generic menu discovery, inspect the unique visible `#editor_showmore`. If its scoped `.editor_showmore_dropdown_menu` is visible and contains one visible `#js_editor_insertProfile` with exact text `账号名片`, click it. If the scoped menu is not visible, click the unique visible `#editor_showmore` and return `overflowClicked: true`. Do not click when either lookup is ambiguous.

- [ ] **Step 2: Run the focused test suite**

Run: `npx vitest run --project adapter clis/weixin/_wechat/fingerprint.test.js`

Expected: PASS, including the new concrete-overflow test and the existing generic-overflow test.

- [ ] **Step 3: Run the full adapter suite**

Run: `npm run test:adapter`

Expected: PASS with no test failures.
