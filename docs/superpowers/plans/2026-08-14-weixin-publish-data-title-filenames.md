# Weixin publish-data title filenames Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save downloaded Weixin publish-data spreadsheets as sanitized article titles instead of WeChat-provided download filenames.

**Architecture:** Retain download validation and atomic collision handling. Derive only the destination name from the selected article title.

**Tech Stack:** Node.js ESM, Vitest, native `node:fs/promises`.

---

### Task 1: Title-derived download filenames

**Files:**
- Modify: `clis/weixin/_wechat/publish-download.test.js`
- Modify: `clis/weixin/_wechat/publish-download.js`

- [ ] Write a failing test that uses `wechat-export.xls` as the download but expects `Ontology Weekly.xls` as the saved path.
- [ ] Write a failing test with title `  A/B:C*D?E"F<G>H|I\\nJ  ` and expect `A_B_C_D_E_F_G_H_I_nJ.xls`.
- [ ] Write a failing test with title `\\u0000/\\\\:*?"<>|` and expect the fallback `publish-data.xls`.
- [ ] Run `npm exec vitest run --project adapter clis/weixin/_wechat/publish-download.test.js`; expect those tests to fail because the current code uses WeChat's filename.
- [ ] Change `safeFilename` to accept only `title`, sanitize reserved characters and controls, use `publish-data` when empty, and append `.xls`.
- [ ] Pass `safeFilename(options.title)` to `publishExclusively`.
- [ ] Re-run the focused test command; expect it to pass, including the existing no-overwrite collision test.
- [ ] Run `npm exec vitest run --project adapter clis/weixin/_wechat/publish-download.test.js clis/weixin/download-publish-data.test.js`; expect all tests to pass.
- [ ] Commit `clis/weixin/_wechat/publish-download.js` and `clis/weixin/_wechat/publish-download.test.js` with message `fix(weixin): name publish data files after titles`.
