# IMA Original File Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a general `bycli ima download` command that obtains an authenticated IMA viewer URL and downloads the original knowledge-base file with integrity metadata.

**Architecture:** Keep `ima knowledge` read-only and add a focused download adapter. Reuse the existing IMA Chrome authentication/reader bridge for locating entries, then open the IMA viewer and extract its signed `originUrl`; pass only validated IMA resource URLs to the shared HTTP downloader and verify the resulting file.

**Tech Stack:** Node.js ESM, Commander registry adapters, existing Browser Bridge APIs, `@sovovs/bycli/download`, Vitest, `curl`-free Node HTTP utilities.

---

### Task 1: Define download result and URL extraction helpers

**Files:**
- Create: `clis/ima/download-utils.js`
- Create: `clis/ima/download-utils.test.js`

- [ ] **Step 1: Write failing tests** for extracting `originUrl` from viewer URLs, accepting only `https://res-skb.ima.qq.com/` URLs, choosing output filenames, and rejecting missing/foreign URLs.
- [ ] **Step 2: Run `npm test -- clis/ima/download-utils.test.js` and verify the tests fail** because the helper module does not exist.
- [ ] **Step 3: Implement minimal pure helpers**: `extractOriginUrl(viewerUrl)`, `validateImaOriginUrl(url)`, `resolveOutputPath(output, title)`, and `sha256File(path)`.
- [ ] **Step 4: Run the focused tests and verify they pass.**
- [ ] **Step 5: Commit:** `feat: add ima download helpers`.

### Task 2: Extend the IMA bridge with viewer URL acquisition

**Files:**
- Modify: `clis/ima/native-client.js`
- Modify: `clis/ima/native-client.test.js`

- [ ] **Step 1: Add failing tests** for `readOriginalFileUrl(page, item)` using a fake page whose `openImaViewer`/`readImaViewerUrl` methods return the signed viewer URL, plus failures for unavailable viewer APIs and missing origin URLs.
- [ ] **Step 2: Run the focused native-client tests and verify the new cases fail.**
- [ ] **Step 3: Implement `readOriginalFileUrl`** by reusing IMA auth acquisition, locating the requested media entry, opening the viewer through Browser Bridge, reading the viewer URL, extracting and validating `originUrl`, and releasing auth in `finally`.
- [ ] **Step 4: Run the focused tests and verify they pass without changing existing auth tests.**
- [ ] **Step 5: Commit:** `feat: acquire signed ima file urls`.

### Task 3: Add the generic `ima download` command

**Files:**
- Create: `clis/ima/download.js`
- Create: `clis/ima/download.test.js`
- Modify: `src/registry.ts` or the existing command discovery entry if required by repository conventions

- [ ] **Step 1: Write failing command tests** for title lookup, `--media-id` disambiguation, output path handling, successful download result fields, and explicit failure when the signed URL is unavailable.
- [ ] **Step 2: Run the focused command tests and verify failure before implementation.**
- [ ] **Step 3: Implement `ima download <knowledgeBase> <file>`** with optional `--media-id` and `--output`; locate the file via the existing knowledge-tree reader, obtain the signed URL, download bytes using the shared download utility or native fetch-to-file helper, validate HTTP content type and file size against metadata, compute SHA-256, and report PDF page count when a PDF parser is available.
- [ ] **Step 4: Register the command through the normal `clis/ima` discovery mechanism and run help output to confirm `bycli ima download --help` exposes the interface.**
- [ ] **Step 5: Run focused tests and verify all pass.**
- [ ] **Step 6: Commit:** `feat: add ima original file download command`.

### Task 4: Add a realistic PDF integration fixture and regression coverage

**Files:**
- Create: `clis/ima/fixtures/trustgraph-viewer.json`
- Modify: `clis/ima/download.test.js`
- Modify: `clis/ima/knowledge.test.js` if output compatibility assertions need strengthening

- [ ] **Step 1: Add a deterministic fixture** containing the known 24-page PDF metadata and a fake signed viewer URL; do not commit the private signed URL or cookies.
- [ ] **Step 2: Write a failing integration-style test** that serves PDF bytes from a local HTTP fixture and asserts `application/pdf`, byte count, SHA-256, and `pages: 24`.
- [ ] **Step 3: Run the test and verify it fails before the integration path is wired.**
- [ ] **Step 4: Wire the fake page/request dependency into the command and make the test pass.**
- [ ] **Step 5: Run the full IMA test suite:** `npm test -- clis/ima` and verify zero failures.
- [ ] **Step 6: Commit:** `test: cover ima pdf download integrity`.

### Task 5: Verify build, command help, and live download

**Files:**
- Modify: documentation under `docs/adapters/browser/ima.md` if present; otherwise create the adapter page following repository conventions.

- [ ] **Step 1: Document command usage, supported file types, validation fields, and the unavailable-URL error.**
- [ ] **Step 2: Run `npm test -- clis/ima`, `npm run build`, and `bycli ima download --help`; record exit codes and outputs.**
- [ ] **Step 3: Run a live download against `Ontology企业本体搭建` and `trustgraph analyze.pdf` only if the current authenticated client exposes a fresh signed URL; verify local MIME, byte count, SHA-256, and 24 pages.**
- [ ] **Step 4: Inspect `git diff` and `git status --short` to ensure only intended files changed.**
- [ ] **Step 5: Commit:** `docs: document ima original file downloads`.
