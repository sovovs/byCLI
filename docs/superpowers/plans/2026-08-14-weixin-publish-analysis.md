# WeChat Publish Analysis Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace XLS downloads with authenticated WeChat content-analysis Markdown reports.

**Architecture:** A focused analysis module captures trusted page JSON and renders it to Markdown. The existing command continues record matching, calls the collector, and projects saved-report metadata.

**Tech Stack:** Node.js ESM, Vitest, Browser Bridge IPage, native filesystem promises.

---

### Task 1: Markdown formatter and capture parser

**Files:**
- Create: `clis/weixin/_wechat/publish-analysis.js`
- Test: `clis/weixin/_wechat/publish-analysis.test.js`

- [ ] Write failing formatter/capture tests for nested data, array tables, table escaping, and token redaction.
- [ ] Run `npx vitest run --project adapter clis/weixin/_wechat/publish-analysis.test.js` and observe failure because the module does not exist.
- [ ] Implement pure formatter, trusted capture selection, and safe error conversion.
- [ ] Re-run the same test command and observe it passing.

### Task 2: Atomic Markdown report saving

**Files:**
- Modify: `clis/weixin/_wechat/publish-analysis.js`
- Test: `clis/weixin/_wechat/publish-analysis.test.js`

- [ ] Write failing tests for safe filename creation, collision suffixing, and saved report metadata.
- [ ] Run the targeted test and observe failure.
- [ ] Implement exclusive Markdown publication using a temporary file and hard-link finalization.
- [ ] Re-run the targeted test and observe it passing.

### Task 3: Command orchestration and contract update

**Files:**
- Modify: `clis/weixin/download-publish-data.js`
- Modify: `clis/weixin/download-publish-data.test.js`
- Modify: `docs/adapters/browser/weixin.md`
- Regenerate: `cli-manifest.json`

- [ ] Write failing command tests asserting `markdownPath`, `saved` status, no XLS downloader call, and projected failed rows.
- [ ] Run `npx vitest run --project adapter clis/weixin/download-publish-data.test.js` and observe failure.
- [ ] Replace XLS download orchestration with analysis collection and Markdown report saving.
- [ ] Re-run command and module tests, then `npm run typecheck` and `npm run build`.

### Task 4: Browser integration verification

**Files:** none

- [ ] Run `bycli weixin published --limit 3 -f json` using the authenticated persistent session.
- [ ] For each exact returned URL and date, run `download-publish-data` sequentially with JSON output.
- [ ] Verify each successful `markdownPath` is readable and report real failures without exposing credentials.
