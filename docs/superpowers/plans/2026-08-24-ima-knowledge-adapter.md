# ima Knowledge Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a macOS-only `bycli ima knowledge <name-or-id>` adapter that traverses one ima knowledge base, preserves folder paths, opens web articles, and returns normalized metadata and URLs.

**Architecture:** A pure JavaScript module owns URL sanitization, row normalization, and the renderer-Accessibility launch preflight. A Swift Accessibility driver, invoked through `swift -`, owns interaction with the running ima app and returns a JSON envelope. The command module validates the platform and query, translates driver failures into byCLI typed errors, and exposes deterministic columns.

**Tech Stack:** JavaScript ESM, Vitest, Swift/Cocoa/ApplicationServices, byCLI registry and typed errors.

---

### Task 1: Pure URL and row normalization

**Files:**
- Create: `clis/ima/utils.js`
- Create: `clis/ima/utils.test.js`

- [ ] **Step 1: Write failing URL-normalization tests**

```js
import { describe, expect, it } from 'vitest';
import { normalizeArticleUrl, toKnowledgeRow } from './utils.js';

describe('normalizeArticleUrl', () => {
  it('removes volatile WeChat session parameters', () => {
    expect(normalizeArticleUrl('https://mp.weixin.qq.com/s?__biz=a&mid=1&idx=1&sn=b&sessionid=x&pass_ticket=y&exportkey=z&scene=305'))
      .toBe('https://mp.weixin.qq.com/s?__biz=a&mid=1&idx=1&sn=b');
  });

  it('keeps ordinary public query parameters and removes fragments', () => {
    expect(normalizeArticleUrl('https://example.com/post?id=7&utm_source=ima#part'))
      .toBe('https://example.com/post?id=7');
  });

  it('returns null for internal ima and extension pages', () => {
    expect(normalizeArticleUrl('chrome://allknowledge/')).toBeNull();
    expect(normalizeArticleUrl('chrome-extension://abc/index.html')).toBeNull();
  });
});

describe('toKnowledgeRow', () => {
  it('builds a deterministic row and preserves folder path arrays', () => {
    expect(toKnowledgeRow({ knowledgeBaseId: 'kb1', knowledgeBase: 'KB', folderPath: ['A'], title: 'T', url: null, contentType: 'PDF', addedDate: '8/20' }))
      .toEqual({ knowledgeBaseId: 'kb1', knowledgeBase: 'KB', folderPath: ['A'], title: 'T', url: null, contentType: 'PDF', addedDate: '8/20' });
  });
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npx vitest run --project adapter clis/ima/utils.test.js`

Expected: FAIL because `clis/ima/utils.js` does not exist.

- [ ] **Step 3: Implement minimal pure helpers**

```js
const DROP_QUERY_KEYS = new Set([
  'sessionid', 'pass_ticket', 'exportkey', 'scene', 'ascene', 'devicetype',
  'version', 'nettype', 'abtest_cookie', 'lang', 'countrycode', 'fontScale',
  'wx_header', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
]);

export function normalizeArticleUrl(value) {
  if (!value) return null;
  const parsed = new URL(value.includes('://') ? value : `https://${value}`);
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (DROP_QUERY_KEYS.has(key)) parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

export function toKnowledgeRow(item) {
  return {
    knowledgeBaseId: item.knowledgeBaseId || null,
    knowledgeBase: item.knowledgeBase,
    folderPath: Array.isArray(item.folderPath) ? item.folderPath : [],
    title: item.title,
    url: normalizeArticleUrl(item.url),
    contentType: item.contentType || null,
    addedDate: item.addedDate || null,
  };
}
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `npx vitest run --project adapter clis/ima/utils.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add clis/ima/utils.js clis/ima/utils.test.js && git commit -m "feat: add ima article URL normalization"`

### Task 2: macOS Accessibility driver

**Files:**
- Create: `clis/ima/ax.js`
- Create: `clis/ima/ax.test.js`

- [ ] **Step 1: Write failing driver-contract tests**

```js
import { describe, expect, it } from 'vitest';
import { __test__ } from './ax.js';

describe('ima AX driver', () => {
  it('targets the installed ima bundle identifier', () => {
    expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('com.tencent.imamac');
  });

  it('matches a library by exact name or knowledgeBaseId', () => {
    expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('knowledgeBaseId=');
    expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('query == library.name');
  });

  it('records nested folder paths and readable address-bar values', () => {
    expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('folderPath');
    expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('地址和搜索栏');
  });
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npx vitest run --project adapter clis/ima/ax.test.js`

Expected: FAIL because `clis/ima/ax.js` does not exist.

- [ ] **Step 3: Implement the Swift AX driver wrapper**

Create `AX_KNOWLEDGE_SCRIPT` with these concrete behaviors:

```swift
let bundleId = "com.tencent.imamac"
guard AXIsProcessTrusted() else { fail("ACCESSIBILITY_DENIED", "Grant Accessibility permission to the terminal running bycli") }
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else { fail("APP_NOT_RUNNING", "ima is not running") }
let query = CommandLine.arguments[1]
// Walk AXChildren from the focused window, collect visible knowledge-base rows,
// match exact visible name or the knowledgeBaseId query parameter in AXURL.
// For the selected library, recurse through folder containers. For each content
// row collect title, contentType, addedDate, and folderPath. AXPress the row,
// wait for a new ima window, read the AXTextField whose description is
// "地址和搜索栏", close that article window, and continue.
// Print one JSON object: { ok: true, knowledgeBaseId, knowledgeBase, items }.
```

Expose a JavaScript wrapper with a bounded timeout:

```js
import { execFileSync } from 'node:child_process';

export function readKnowledgeBase(query) {
  const output = execFileSync('swift', ['-', query], {
    input: AX_KNOWLEDGE_SCRIPT,
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    maxBuffer: 50 * 1024 * 1024,
  }).trim();
  return JSON.parse(output);
}

export const __test__ = { AX_KNOWLEDGE_SCRIPT };
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `npx vitest run --project adapter clis/ima/ax.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add clis/ima/ax.js clis/ima/ax.test.js && git commit -m "feat: add ima accessibility driver"`

### Task 3: Register the byCLI command and typed errors

**Files:**
- Create: `clis/ima/knowledge.js`
- Create: `clis/ima/knowledge.test.js`

- [ ] **Step 1: Write a failing command-contract test**

```js
import { describe, expect, it } from 'vitest';
import { knowledgeCommand } from './knowledge.js';

describe('ima knowledge command', () => {
  it('registers the intended command contract', () => {
    expect(knowledgeCommand.site).toBe('ima');
    expect(knowledgeCommand.name).toBe('knowledge');
    expect(knowledgeCommand.browser).toBe(false);
    expect(knowledgeCommand.access).toBe('read');
    expect(knowledgeCommand.columns).toEqual([
      'knowledgeBaseId', 'knowledgeBase', 'folderPath', 'title', 'url', 'contentType', 'addedDate',
    ]);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run --project adapter clis/ima/knowledge.test.js`

Expected: FAIL because `clis/ima/knowledge.js` does not exist.

- [ ] **Step 3: Implement the command**

```js
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError, ConfigError, EmptyResultError, getErrorMessage } from '@sovovs/bycli/errors';
import { readKnowledgeBase } from './ax.js';
import { toKnowledgeRow } from './utils.js';

export const knowledgeCommand = cli({
  site: 'ima',
  name: 'knowledge',
  access: 'read',
  description: 'List content and canonical article URLs from one local ima knowledge base',
  example: 'bycli ima knowledge "企业级AI应用落地实践" -f json',
  domain: 'localhost',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [{ name: 'knowledge-base', positional: true, required: true, help: 'Exact knowledge-base name or ID' }],
  columns: ['knowledgeBaseId', 'knowledgeBase', 'folderPath', 'title', 'url', 'contentType', 'addedDate'],
  defaultFormat: 'json',
  func: async (args) => {
    if (process.platform !== 'darwin') throw new ConfigError('ima integration requires macOS Accessibility APIs');
    const query = String(args['knowledge-base'] || '').trim();
    if (!query) throw new ArgumentError('knowledge-base must be a non-empty exact name or ID');
    try {
      const result = readKnowledgeBase(query);
      if (!result.items?.length) throw new EmptyResultError('ima knowledge', `No content found for "${query}"`);
      return result.items.map((item) => toKnowledgeRow({ ...item, knowledgeBaseId: result.knowledgeBaseId, knowledgeBase: result.knowledgeBase }));
    } catch (error) {
      if (error instanceof ArgumentError || error instanceof ConfigError || error instanceof EmptyResultError) throw error;
      throw new CommandExecutionError(`Failed to read ima knowledge base: ${getErrorMessage(error)}`);
    }
  },
});
```

- [ ] **Step 4: Run command tests and verify GREEN**

Run: `npx vitest run --project adapter clis/ima/knowledge.test.js clis/ima/utils.test.js clis/ima/ax.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add clis/ima/knowledge.js clis/ima/knowledge.test.js && git commit -m "feat: add ima knowledge command"`

### Task 4: Validate discovery and live behavior

**Files:**
- Modify only if validation exposes a defect: `clis/ima/ax.js`, `clis/ima/knowledge.js`, or their tests

- [ ] **Step 1: Run static adapter validation**

Run: `npx tsx src/main.ts validate ima/knowledge`

Expected: PASS with no semantic convention errors.

- [ ] **Step 2: Run targeted and full adapter tests**

Run: `npx vitest run --project adapter clis/ima/*.test.js`

Expected: PASS.

Run: `npm run test:adapter`

Expected: PASS.

- [ ] **Step 3: Run lint-style convention checks**

Run: `npm run check:typed-error-lint && npm run check:silent-column-drop`

Expected: both commands exit 0.

- [ ] **Step 4: Perform a one-item live smoke check**

Run: `npx tsx src/main.ts ima knowledge "升sov's的知识库" -f json`

Expected: JSON with one visible PDF row, the exact knowledge-base name, an empty folder path, and `url: null`. Do not use the 195-item subscribed knowledge base for this smoke check.

- [ ] **Step 5: Commit verification fixes if any**

Run: `git add clis/ima && git commit -m "test: verify ima knowledge adapter"`

If no files changed, do not create an empty commit.
