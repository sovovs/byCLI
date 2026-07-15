# bycli-plugin-wechat Implementation Plan

> **Superseded:** This historical independent-plugin plan is retained for context only. The current design implements `accounts`, `articles`, and `save-articles` as built-in `clis/weixin` commands（当前为内置 `weixin` 方案）; follow [the built-in weixin design](../../2026-07-14-bycli-plugin-wechat-design.md) instead. Do not execute the plugin installation, separate npm package, crawler subprocess, or exit-code mapping steps below.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independently published byCLI plugin that searches WeChat public accounts, lists their articles, and saves Markdown through the `wechat-crawler` CLI boundary.

**Architecture:** Three flat root command entries satisfy byCLI plugin discovery and delegate to focused modules under `src/`. Authentication is either an ephemeral browser session or an explicit all-or-nothing environment source; search calls `search_biz` directly, while list/save run the pinned crawler binary in a hardened child process and map its JSON envelope into static byCLI rows.

**Tech Stack:** Node.js 20 ESM, TypeScript 6, Vitest 4, `@sovovs/bycli >=2.1.0 <3.0.0`, `wechat-article-crawler@1.0.0`.

**Working directory:** `/Users/lijiahui/Desktop/bycli-plugin-wechat` (a separate Git repository, not a package inside OpenCLI).

**Prerequisite:** Complete and publish [the byCLI core plan](./2026-07-14-bycli-conditional-browser-redaction.md) before running plugin installation or integration tests.

**Source contract:** [bycli-plugin-wechat design](../../2026-07-14-bycli-plugin-wechat-design.md)

---

## File map

- Create `bycli-plugin.json`: plugin metadata and byCLI compatibility.
- Create `package.json`, `package-lock.json`, `tsconfig.json`: pinned runtime and test/build scripts.
- Create `scripts/write-entrypoints.mjs`: emit root JavaScript shims after TypeScript compilation.
- Create `search.ts`, `list.ts`, `save.ts`: flat command registrations discovered by byCLI.
- Create `src/types.ts`: credentials, search payload, crawler envelope, and row types.
- Create `src/args.ts`: exact positive-integer and argument readers for hyphenated byCLI keys.
- Create `src/redact.ts`: per-command secret-set construction and text/value redaction.
- Create `src/auth-session.ts`: environment credentials, browser preflight, login waiting, token/Cookie extraction.
- Create `src/fingerprint-capture.ts`: page-local one-shot extraction of only the `fingerprint` parameter from a genuine `search_biz` request.
- Create `src/search-biz.ts`: browser/Node request execution and response validation.
- Create `src/crawler-process.ts`: binary resolution, safe spawn, limits, timeout, process-group cleanup, and exit mapping.
- Create `src/output-mappers.ts`: list reorder and save `files[] + errors[]` synthesis.
- Create `test/*.test.ts`: unit and integration coverage using synthetic credentials only.
- Create `test/fixtures/*.json`: sanitized WeChat/crawler response fixtures.
- Create `README.md`: install, login, CI, security, and recovery guidance.

### Task 1: Scaffold an independently buildable plugin

**Files:**
- Create: `bycli-plugin.json`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `scripts/write-entrypoints.mjs`
- Create: `.gitignore`

- [ ] **Step 1: Create and initialize the separate repository**

Run:

```bash
rtk mkdir -p /Users/lijiahui/Desktop/bycli-plugin-wechat/scripts /Users/lijiahui/Desktop/bycli-plugin-wechat/src /Users/lijiahui/Desktop/bycli-plugin-wechat/test/fixtures
rtk git init /Users/lijiahui/Desktop/bycli-plugin-wechat
```

Expected: Git reports an initialized repository at the exact sibling path. Do not add this repository to OpenCLI workspaces.

- [ ] **Step 2: Add plugin and package metadata**

Create `bycli-plugin.json`:

```json
{
  "name": "wechat",
  "version": "0.1.0",
  "description": "Search and crawl WeChat public account articles through byCLI",
  "bycli": ">=2.1.0 <3.0.0"
}
```

Create `package.json`:

```json
{
  "name": "bycli-plugin-wechat",
  "version": "0.1.0",
  "description": "WeChat public account search and article crawler plugin for byCLI",
  "type": "module",
  "files": [
    "bycli-plugin.json",
    "search.js",
    "list.js",
    "save.js",
    "dist/",
    "README.md"
  ],
  "scripts": {
    "clean": "node -e \"require('node:fs').rmSync('dist',{recursive:true,force:true})\"",
    "build": "npm run clean && tsc -p tsconfig.json && node scripts/write-entrypoints.mjs",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "prepack": "npm run typecheck && npm test && npm run build"
  },
  "dependencies": {
    "wechat-article-crawler": "1.0.0"
  },
  "peerDependencies": {
    "@sovovs/bycli": ">=2.1.0 <3.0.0"
  },
  "devDependencies": {
    "@sovovs/bycli": "^2.1.0",
    "@types/node": "^25.0.0",
    "typescript": "^6.0.0",
    "vitest": "^4.0.0"
  },
  "engines": {
    "node": ">=20"
  },
  "license": "Apache-2.0"
}
```

- [ ] **Step 3: Configure strict ESM compilation**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["search.ts", "list.ts", "save.ts", "src/**/*.ts"],
  "exclude": ["test", "dist", "node_modules"]
}
```

- [ ] **Step 4: Generate loader-visible root shims**

Create `scripts/write-entrypoints.mjs`:

```js
import { writeFileSync } from 'node:fs';

for (const command of ['search', 'list', 'save']) {
  writeFileSync(
    `${command}.js`,
    `// cli() registration entrypoint for byCLI's flat plugin scanner\nimport './dist/${command}.js';\n`,
    'utf8',
  );
}
```

Create `.gitignore`:

```text
node_modules/
dist/
search.js
list.js
save.js
coverage/
articles/
```

Root JavaScript shims are generated release artifacts. They must be present in `npm pack`, while development Git tracks the TypeScript source and build script.

- [ ] **Step 5: Install locked dependencies**

Run after `@sovovs/bycli@2.1.0` and `wechat-article-crawler@1.0.0` are available from the configured npm registry:

```bash
rtk npm install
```

Expected: `package-lock.json` is created; `node_modules/.bin/wechat-crawler` exists; no Git or wildcard dependency appears in the lockfile.

- [ ] **Step 6: Commit the scaffold**

```bash
rtk git add bycli-plugin.json package.json package-lock.json tsconfig.json scripts/write-entrypoints.mjs .gitignore
rtk git commit -m "chore: scaffold bycli wechat plugin"
```

### Task 2: Define contracts, argument parsing, and secret redaction

**Files:**
- Create: `src/types.ts`
- Create: `src/args.ts`
- Create: `src/redact.ts`
- Create: `test/args.test.ts`
- Create: `test/redact.test.ts`

- [ ] **Step 1: Add failing argument tests**

Create `test/args.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@sovovs/bycli/errors';
import { readAuthSource, readPositiveInteger } from '../src/args.js';

describe('argument readers', () => {
  it.each([undefined, 1, '2', 10])('accepts positive integer %s', value => {
    expect(readPositiveInteger({ limit: value }, 'limit', 10)).toBe(Number(value ?? 10));
  });

  it.each([0, -1, 1.5, 'x'])('rejects invalid positive integer %s', value => {
    expect(() => readPositiveInteger({ limit: value }, 'limit', 10)).toThrow(ArgumentError);
  });

  it('reads the literal hyphenated auth-source key', () => {
    expect(readAuthSource({ 'auth-source': 'env' })).toBe('env');
    expect(readAuthSource({})).toBe('browser');
  });
});
```

- [ ] **Step 2: Add failing redaction tests**

Create `test/redact.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildSecretSet, redactText, redactValue } from '../src/redact.js';

describe('plugin redaction', () => {
  it('redacts full and individual cookie values plus encoded secrets', () => {
    const secrets = buildSecretSet({
      token: 'tok+/=',
      cookie: 'slave_sid=sid-secret; data_ticket=ticket-secret',
      fingerprint: 'fp+/=',
    });
    const output = redactText(
      'tok+/= tok%2B%2F%3D slave_sid=sid-secret ticket-secret fp%2B%2F%3D',
      secrets,
    );
    expect(output).not.toContain('tok');
    expect(output).not.toContain('sid-secret');
    expect(output).not.toContain('ticket-secret');
    expect(output).not.toContain('fp%2B');
  });

  it('redacts nested crawler envelopes without changing non-secret fields', () => {
    expect(redactValue({ message: 'token-secret', stage: 'download' }, ['token-secret']))
      .toEqual({ message: '[REDACTED]', stage: 'download' });
  });
});
```

- [ ] **Step 3: Run both files and confirm missing modules**

Run:

```bash
rtk npx vitest run test/args.test.ts test/redact.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Define exact data contracts**

Create `src/types.ts` with these exported shapes:

```ts
export type AuthSource = 'browser' | 'env';

export interface WechatCredentials {
  token: string;
  cookie: string;
  fingerprint?: string;
}

export interface SearchBizItem {
  nickname: string;
  fakeid: string;
  alias?: string | null;
}

export interface SearchBizPayload {
  base_resp?: { ret?: number; err_msg?: string };
  list?: unknown;
}

export interface CrawlerErrorEnvelope {
  schemaVersion: string;
  success: false;
  error?: { message?: string };
}

export interface CrawlerListEnvelope {
  schemaVersion: string;
  success: boolean;
  articles: Array<{
    title?: string; url?: string; publishedAt?: string | null; digest?: string; author?: string;
  }>;
}

export interface CrawlerSaveEnvelope {
  schemaVersion: string;
  success: boolean;
  partial?: boolean;
  files: Array<{ title?: string; url?: string; path?: string }>;
  errors: Array<{ stage?: string; title?: string; url?: string; message?: string }>;
}
```

- [ ] **Step 5: Implement strict argument readers**

Create `src/args.ts`:

```ts
import { ArgumentError } from '@sovovs/bycli/errors';
import type { AuthSource } from './types.js';

export function readAuthSource(args: Record<string, unknown>): AuthSource {
  const value = args['auth-source'] ?? 'browser';
  if (value === 'browser' || value === 'env') return value;
  throw new ArgumentError('--auth-source must be one of: browser, env');
}

export function readPositiveInteger(
  args: Record<string, unknown>,
  key: string,
  fallback?: number,
): number | undefined {
  const raw = args[key] ?? fallback;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new ArgumentError(`--${key} must be a positive integer`);
  return value;
}

export function readRequiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new ArgumentError(`--${key} is required`);
  return value.trim();
}
```

- [ ] **Step 6: Implement longest-first secret replacement**

Create `src/redact.ts`:

```ts
import type { WechatCredentials } from './types.js';

export function buildSecretSet(credentials: WechatCredentials): string[] {
  const cookieValues = credentials.cookie
    .split(';')
    .map(part => part.trim().split('=').slice(1).join('=').trim())
    .filter(Boolean);
  const raw = [credentials.token, credentials.cookie, credentials.fingerprint, ...cookieValues]
    .filter((value): value is string => Boolean(value));
  return [...new Set(raw.flatMap(value => [value, encodeURIComponent(value)]))]
    .sort((a, b) => b.length - a.length);
}

export function redactText(value: unknown, secrets: readonly string[]): string {
  let output = String(value);
  for (const secret of secrets) output = output.split(secret).join('[REDACTED]');
  return output;
}

export function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]));
  }
  return value;
}
```

- [ ] **Step 7: Run tests and commit**

```bash
rtk npx vitest run test/args.test.ts test/redact.test.ts
rtk git add src/types.ts src/args.ts src/redact.ts test/args.test.ts test/redact.test.ts
rtk git commit -m "feat: add wechat plugin contracts and redaction"
```

Expected: both test files PASS.

### Task 3: Resolve environment and browser authentication

**Files:**
- Create: `src/auth-session.ts`
- Create: `test/auth-session.test.ts`

- [ ] **Step 1: Add environment-source tests**

Create `test/auth-session.test.ts` with synthetic values:

```ts
import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, TimeoutError } from '@sovovs/bycli/errors';
import { readEnvironmentCredentials, resolveBrowserCredentials } from '../src/auth-session.js';

it('requires complete environment credentials without falling back to a page', () => {
  expect(() => readEnvironmentCredentials(false, { WECHAT_TOKEN: 'token-only' }))
    .toThrow(AuthRequiredError);
  expect(() => readEnvironmentCredentials(true, {
    WECHAT_TOKEN: 'token', WECHAT_COOKIE: 'cookie', WECHAT_FINGERPRINT: 'fingerprint',
  })).toEqual({ token: 'token', cookie: 'cookie', fingerprint: 'fingerprint' });
});

it('keeps HttpOnly target cookies and removes expired or foreign cookies', async () => {
  const page = makePage({
    url: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=123',
    cookies: [
      { name: 'slave_sid', value: 'sid', domain: '.mp.weixin.qq.com', httpOnly: true, expirationDate: Date.now() / 1000 + 60 },
      { name: 'expired', value: 'old', domain: '.mp.weixin.qq.com', expirationDate: 1 },
      { name: 'foreign', value: 'no', domain: '.example.com' },
    ],
  });
  await expect(resolveBrowserCredentials(page, { timeoutMs: 50 })).resolves.toEqual({
    token: '123', cookie: 'slave_sid=sid',
  });
});
```

Define `makePage` in the test as a typed stub implementing `getCurrentUrl`, `evaluate`, `getCookies`, `goto`, `wait`, and `focusWindow`; keep all values synthetic.

- [ ] **Step 2: Add preflight, login, and timeout tests**

Add cases proving:

```ts
expect(isLoggedInPreflight({
  url: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=123',
  hasLoginUi: false,
})).toBe(true);
expect(isLoggedInPreflight({
  url: 'https://mp.weixin.qq.com/',
  hasLoginUi: true,
})).toBe(false);
```

For a page that changes from login to backend state on the second poll, assert `focusWindow()` is called once before waiting. For a page that never changes, assert `resolveBrowserCredentials` rejects with `TimeoutError` and never reads cookies.

- [ ] **Step 3: Run the test and confirm missing implementation**

Run:

```bash
rtk npx vitest run test/auth-session.test.ts
```

Expected: FAIL because `src/auth-session.ts` does not exist.

- [ ] **Step 4: Implement exact environment semantics**

Create `src/auth-session.ts` with:

```ts
import { AuthRequiredError, BrowserConnectError, TimeoutError } from '@sovovs/bycli/errors';
import type { IPage } from '@sovovs/bycli/types';
import type { WechatCredentials } from './types.js';

const DOMAIN = 'mp.weixin.qq.com';

export function readEnvironmentCredentials(
  needsFingerprint: boolean,
  env: NodeJS.ProcessEnv = process.env,
): WechatCredentials {
  const token = env.WECHAT_TOKEN?.trim();
  const cookie = env.WECHAT_COOKIE?.trim();
  const fingerprint = env.WECHAT_FINGERPRINT?.trim();
  if (!token || !cookie || (needsFingerprint && !fingerprint)) {
    throw new AuthRequiredError(DOMAIN, needsFingerprint
      ? 'WECHAT_TOKEN, WECHAT_COOKIE, and WECHAT_FINGERPRINT are required for env search'
      : 'WECHAT_TOKEN and WECHAT_COOKIE are required for env crawling');
  }
  return { token, cookie, ...(fingerprint ? { fingerprint } : {}) };
}

export function isLoggedInPreflight(state: { url: string | null; hasLoginUi: boolean }): boolean {
  if (!state.url || state.hasLoginUi) return false;
  const url = new URL(state.url);
  return url.hostname === DOMAIN && url.pathname.startsWith('/cgi-bin/') && Boolean(url.searchParams.get('token'));
}
```

- [ ] **Step 5: Implement browser polling and Cookie construction**

Implement `resolveBrowserCredentials(page, { timeoutMs = 180_000 })` as follows:

1. Reject a null page with `BrowserConnectError`/69.
2. Read `{ href, hasLoginUi }` with one `page.evaluate` call. `hasLoginUi` checks visible `form[action*="login"]`, `img[src*="qrcode"]`, `canvas[class*="qrcode"]`, or page text matching `扫码登录|使用微信扫码`; the URL/token remains the primary positive signal and a broad class-name match must not mark an authenticated page as logged out.
3. If preflight fails, require `page.focusWindow`; if it is absent, throw `BrowserConnectError` explaining that byCLI 2.1+ is required. Call `page.goto('https://mp.weixin.qq.com/')`, then `page.focusWindow()`, and poll every 500 ms with `page.wait(500)` until success or timeout.
4. Extract token using `new URL(finalUrl).searchParams.get('token')`.
5. Call `page.getCookies({ url: 'https://mp.weixin.qq.com/' })`, filter expired cookies and domains not matching `mp.weixin.qq.com`, and join `name=value` pairs with `; `.
6. Throw `AuthRequiredError` for an empty token/Cookie and `TimeoutError('WeChat login', timeoutMs / 1000)` on expiry.
7. Before returning browser credentials, navigate to `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=10&token=${encodeURIComponent(token)}&lang=zh_CN`; this is the page on which fingerprint capture triggers the real `search_biz` UI request.

Use a monotonic injected `now` function in tests rather than real sleeps.

- [ ] **Step 6: Run authentication tests and commit**

```bash
rtk npx vitest run test/auth-session.test.ts
rtk git add src/auth-session.ts test/auth-session.test.ts
rtk git commit -m "feat: capture wechat session credentials"
```

Expected: browser reuse, foreground login, HttpOnly Cookie, and timeout cases PASS.

### Task 4: Capture fingerprint locally and execute search_biz

**Files:**
- Create: `src/fingerprint-capture.ts`
- Create: `src/search-biz.ts`
- Create: `test/fingerprint-capture.test.ts`
- Create: `test/search-biz.test.ts`
- Create: `test/fixtures/search-success.json`
- Create: `test/fixtures/search-auth-expired.json`

- [ ] **Step 1: Add sanitized search fixtures**

Create `test/fixtures/search-success.json`:

```json
{
  "base_resp": { "ret": 0, "err_msg": "ok" },
  "list": [
    { "nickname": "Account A", "fakeid": "MTAwMDAwMQ==", "alias": "account_a" },
    { "nickname": "Account A Labs", "fakeid": "MTAwMDAwMg==" }
  ]
}
```

Create `test/fixtures/search-auth-expired.json`:

```json
{
  "base_resp": { "ret": 200013, "err_msg": "invalid credential" },
  "list": []
}
```

- [ ] **Step 2: Test search validation and classification**

Create `test/search-biz.test.ts` asserting:

```ts
expect(mapSearchBizPayload(successFixture)).toEqual([
  { nickname: 'Account A', fakeid: 'MTAwMDAwMQ==', alias: 'account_a' },
  { nickname: 'Account A Labs', fakeid: 'MTAwMDAwMg==', alias: null },
]);
expect(() => mapSearchBizPayload(authFixture)).toThrow(AuthRequiredError);
expect(() => mapSearchBizPayload({ base_resp: { ret: 999999, err_msg: 'new failure' } }))
  .toThrow(CommandExecutionError);
expect(() => mapSearchBizPayload({ base_resp: { ret: 0 }, list: {} }))
  .toThrow(CommandExecutionError);
```

Also mock browser `page.fetchJson` and Node `fetch` to prove both modes generate `action=search_biz`, `count`, URL-encoded query, token, fingerprint, `X-Requested-With`, Referer, and Cookie only in Node mode.

- [ ] **Step 3: Test page-local fingerprint extraction**

Create `test/fingerprint-capture.test.ts`. Stub `page.evaluate` so the installed observer returns only `fp-synthetic` after the supplied query is entered and submitted. Assert no returned object contains a full request URL, token, or Cookie, and timeout maps to `TimeoutError`.

- [ ] **Step 4: Run tests and confirm missing modules**

```bash
rtk npx vitest run test/fingerprint-capture.test.ts test/search-biz.test.ts
```

Expected: FAIL because both source modules are absent.

- [ ] **Step 5: Implement a one-shot in-page observer**

In `src/fingerprint-capture.ts`, export `captureSearchBizFingerprint(page, query, timeoutMs)`. Its first `page.evaluate` installs temporary wrappers around `window.fetch` and `XMLHttpRequest.prototype.open`. For matching `/cgi-bin/searchbiz` URLs it must store only:

```ts
new URL(requestUrl, location.href).searchParams.get('fingerprint')
```

under a non-enumerable `window.__bycli_wechat_fingerprint` property. It must never store the full URL. After submitting `query` through the page UI, poll that single property, restore original functions, delete the property, and return the non-empty value. Restore functions in `finally`, including timeout/error paths.

Use this page-side trigger after installing the observer:

```ts
await page.evaluate((value: string) => {
  const visible = (element: Element): element is HTMLElement => {
    const node = element as HTMLElement;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
  };
  const input = [...document.querySelectorAll('input')].find(element => {
    const label = `${element.placeholder} ${element.getAttribute('aria-label') ?? ''}`;
    return visible(element) && /(公众号|搜索)/.test(label);
  });
  const button = [...document.querySelectorAll('button, [role="button"], a')]
    .find(element => visible(element) && /搜索/.test(element.textContent?.trim() ?? '')) as HTMLElement | undefined;
  if (!input || !button) return { submitted: false };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  button.click();
  return { submitted: true };
}, query);
```

If it returns `submitted: false`, throw `CommandExecutionError` with hint `The WeChat editor search controls were not found; the page layout may have changed.`

- [ ] **Step 6: Implement search_biz requests and allowlist**

In `src/search-biz.ts`:

```ts
const AUTH_RET_CODES = new Set([200013]);
const AUTH_MESSAGES = new Set(['invalid credential']);

export function mapSearchBizPayload(payload: SearchBizPayload): SearchBizItem[] {
  const ret = payload.base_resp?.ret;
  const message = payload.base_resp?.err_msg?.trim().toLowerCase() ?? '';
  if (ret !== 0) {
    if ((ret !== undefined && AUTH_RET_CODES.has(ret)) || AUTH_MESSAGES.has(message)) {
      throw new AuthRequiredError('mp.weixin.qq.com', 'WeChat session is expired or not logged in');
    }
    throw new CommandExecutionError(`WeChat search_biz failed: ret=${String(ret)} message=${message || 'unknown'}`);
  }
  if (!Array.isArray(payload.list)) throw new CommandExecutionError('WeChat search_biz response list is not an array');
  return payload.list.map((item, index) => {
    if (!item || typeof item !== 'object') throw new CommandExecutionError(`Invalid search_biz item at index ${index}`);
    const row = item as Record<string, unknown>;
    if (typeof row.nickname !== 'string' || !row.nickname || typeof row.fakeid !== 'string' || !row.fakeid) {
      throw new CommandExecutionError(`search_biz item ${index} is missing nickname or fakeid`);
    }
    return { nickname: row.nickname, fakeid: row.fakeid, alias: typeof row.alias === 'string' && row.alias ? row.alias : null };
  });
}
```

Build the URL with `URLSearchParams`; browser mode uses `page.fetchJson`, env mode uses injected `fetch`. Wrap transport/parse errors as `CommandExecutionError` after redaction; preserve existing byCLI typed errors.

Export this stable call contract for the root command:

```ts
export interface SearchBizOptions {
  page: IPage | null;
  source: 'browser' | 'env';
  credentials: WechatCredentials;
  query: string;
  limit: number;
  fetchImpl?: typeof fetch;
}

export async function executeSearchBiz(options: SearchBizOptions): Promise<SearchBizItem[]>;
```

- [ ] **Step 7: Run search tests and commit**

```bash
rtk npx vitest run test/fingerprint-capture.test.ts test/search-biz.test.ts
rtk git add src/fingerprint-capture.ts src/search-biz.ts test/fingerprint-capture.test.ts test/search-biz.test.ts test/fixtures/search-success.json test/fixtures/search-auth-expired.json
rtk git commit -m "feat: search wechat public accounts"
```

Expected: all search tests PASS; both similar account names remain in output.

### Task 5: Implement the hardened crawler subprocess boundary

**Files:**
- Create: `src/crawler-process.ts`
- Create: `test/crawler-process.test.ts`
- Create: `test/fixtures/crawler-list.json`
- Create: `test/fixtures/crawler-save-partial.json`

- [ ] **Step 1: Add sanitized crawler fixtures**

Create `test/fixtures/crawler-list.json` with `schemaVersion: "1.0"`, `success: true`, and two synthetic `articles`. Create `test/fixtures/crawler-save-partial.json` with one `files[]` item and one `errors[]` item containing `stage: "download"` and `message: "synthetic timeout"`.

- [ ] **Step 2: Add child-process contract tests**

In `test/crawler-process.test.ts`, inject a fake `spawn` and assert:

```ts
expect(spawn).toHaveBeenCalledWith(
  process.execPath,
  expect.arrayContaining([expect.stringContaining('wechat-crawler.js'), 'list', '--fakeid', 'fake', '--name', 'Account A']),
  expect.objectContaining({ shell: false }),
);
expect(spawn.mock.calls[0][2].env).toMatchObject({
  WECHAT_TOKEN: 'token-synthetic',
  WECHAT_COOKIE: 'slave_sid=sid-synthetic',
});
expect(spawn.mock.calls[0][1].join(' ')).not.toContain('token-synthetic');
expect(process.env.WECHAT_TOKEN).toBeUndefined();
```

Add cases for valid exit 0, partial exit 2, write exit 3, malformed JSON, stdout/stderr overflow, timeout, cancellation, and stderr containing a fingerprint plus individual Cookie value.

- [ ] **Step 3: Run the test and confirm missing implementation**

```bash
rtk npx vitest run test/crawler-process.test.ts
```

Expected: FAIL because `src/crawler-process.ts` does not exist.

- [ ] **Step 4: Resolve the pinned package binary without PATH lookup**

Use `createRequire(import.meta.url).resolve('wechat-article-crawler/package.json')`, derive `<packageRoot>/bin/wechat-crawler.js`, and verify it is a file before spawning `process.execPath`. Throw `CommandExecutionError` with an install hint if resolution fails. Do not execute the global `wechat-crawler` name.

- [ ] **Step 5: Implement safe spawn and bounded collection**

Export:

```ts
export interface RunCrawlerOptions {
  command: 'list' | 'save';
  fakeid: string;
  name: string;
  outputDir?: string;
  limit?: number;
  maxPages?: number;
  timeoutMs: number;
  credentials: WechatCredentials;
  verbose?: boolean;
  signal?: AbortSignal;
}

export interface CrawlerResult {
  exitCode: 0 | 2;
  envelope: CrawlerListEnvelope | CrawlerSaveEnvelope;
}
```

Spawn with an argument array, `shell: false`, piped stdout/stderr, and `detached: process.platform !== 'win32'`. Preserve the parent environment by creating a new object and add only `WECHAT_TOKEN`/`WECHAT_COOKIE`; never mutate `process.env`. Cap each stream at 10 MiB. On timeout, abort, or overflow, terminate the process group on POSIX and the child on Windows.

Parse stdout only after exit. Require object JSON with `schemaVersion === '1.0'`. Redact stderr/error envelopes again with `buildSecretSet`. Forward sanitized stderr only when `verbose` is true.

- [ ] **Step 6: Map child exits to existing typed errors**

Implement:

- exit `0`: return the envelope.
- exit `2`: return the partial save envelope and preserve `exitCode: 2`.
- exit `1`: if the sanitized structured message contains the exact `微信接口错误 200013` or normalized `invalid credential`, throw `AuthRequiredError`; otherwise throw `CommandExecutionError`.
- exit `3`: throw `CommandExecutionError` with message `wechat-crawler exited with code 3: <sanitized message>` and hint `Check output directory permissions and available disk space.`; use the literal fallback `write failed` when the crawler message is empty.
- signal/unknown exit: throw `CommandExecutionError` with the sanitized exit/signal.

Do not attach arbitrary `details`.

- [ ] **Step 7: Run subprocess tests and commit**

```bash
rtk npx vitest run test/crawler-process.test.ts
rtk git add src/crawler-process.ts test/crawler-process.test.ts test/fixtures/crawler-list.json test/fixtures/crawler-save-partial.json
rtk git commit -m "feat: run wechat crawler through safe cli boundary"
```

Expected: all subprocess cases PASS and captured argv/stderr contain no synthetic secrets.

### Task 6: Map crawler envelopes into static rows

**Files:**
- Create: `src/output-mappers.ts`
- Create: `test/output-mappers.test.ts`

- [ ] **Step 1: Add exact row-shape tests**

Create `test/output-mappers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mapListRows, mapSaveRows } from '../src/output-mappers.js';

it('reorders list fields and normalizes missing values to null', () => {
  expect(mapListRows({ articles: [{ title: 'A', url: 'https://mp.weixin.qq.com/s/a' }] } as never))
    .toEqual([{ title: 'A', author: null, digest: null, publishedAt: null, url: 'https://mp.weixin.qq.com/s/a' }]);
});

it('synthesizes saved and failed rows from separate arrays', () => {
  expect(mapSaveRows({
    files: [{ title: 'A', url: 'https://mp.weixin.qq.com/s/a', path: '/tmp/a.md' }],
    errors: [{ stage: 'download', title: 'B', url: 'https://mp.weixin.qq.com/s/b', message: 'timeout' }],
  } as never)).toEqual([
    { title: 'A', status: 'saved', stage: null, path: '/tmp/a.md', error: null, url: 'https://mp.weixin.qq.com/s/a' },
    { title: 'B', status: 'failed', stage: 'download', path: null, error: 'timeout', url: 'https://mp.weixin.qq.com/s/b' },
  ]);
});
```

- [ ] **Step 2: Run the test and confirm missing implementation**

```bash
rtk npx vitest run test/output-mappers.test.ts
```

Expected: FAIL because the mapper module is missing.

- [ ] **Step 3: Implement explicit key-by-key mapping**

Create `src/output-mappers.ts` and map every output field explicitly; do not spread crawler objects:

```ts
import type { CrawlerListEnvelope, CrawlerSaveEnvelope } from './types.js';

const nullableString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export function mapListRows(envelope: CrawlerListEnvelope) {
  return envelope.articles.map(article => ({
    title: nullableString(article.title),
    author: nullableString(article.author),
    digest: nullableString(article.digest),
    publishedAt: nullableString(article.publishedAt),
    url: nullableString(article.url),
  }));
}

export function mapSaveRows(envelope: CrawlerSaveEnvelope) {
  return [
    ...envelope.files.map(file => ({
      title: nullableString(file.title),
      status: 'saved' as const,
      stage: null,
      path: nullableString(file.path),
      error: null,
      url: nullableString(file.url),
    })),
    ...envelope.errors.map(error => ({
      title: nullableString(error.title),
      status: 'failed' as const,
      stage: nullableString(error.stage),
      path: null,
      error: nullableString(error.message),
      url: nullableString(error.url),
    })),
  ];
}
```

- [ ] **Step 4: Run mapper tests and commit**

```bash
rtk npx vitest run test/output-mappers.test.ts
rtk git add src/output-mappers.ts test/output-mappers.test.ts
rtk git commit -m "feat: map crawler envelopes to bycli rows"
```

Expected: PASS with exact object equality.

### Task 7: Register search, list, and save commands

**Files:**
- Create: `search.ts`
- Create: `list.ts`
- Create: `save.ts`
- Create: `test/commands.test.ts`

- [ ] **Step 1: Add registration metadata tests**

In `test/commands.test.ts`, import all three root modules, read `getRegistry()`, and assert:

```ts
expect(getRegistry().get('wechat/search')).toMatchObject({
  access: 'read', strategy: Strategy.INTERCEPT, browser: 'conditional',
  columns: ['nickname', 'fakeid', 'alias'],
});
expect(getRegistry().get('wechat/list')).toMatchObject({
  access: 'read', strategy: Strategy.COOKIE, browser: 'conditional',
  columns: ['title', 'author', 'digest', 'publishedAt', 'url'],
});
expect(getRegistry().get('wechat/save')).toMatchObject({
  access: 'write', strategy: Strategy.COOKIE, browser: 'conditional',
  columns: ['title', 'status', 'stage', 'path', 'error', 'url'],
});
```

Invoke each captured `func` with browser and env stubs. Assert env calls receive `page === null`, do not touch browser methods, and incomplete env credentials fail with exit 77. Assert a partial save sets `process.exitCode = 2` only after returning all mapped rows; restore the previous exit code in `afterEach`.

- [ ] **Step 2: Run command tests and confirm missing entries**

```bash
rtk npx vitest run test/commands.test.ts
```

Expected: FAIL because root commands are absent.

- [ ] **Step 3: Register the search command**

Create `search.ts` with this complete orchestration:

```ts
import { EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { readAuthSource, readPositiveInteger, readRequiredString } from './src/args.js';
import { readEnvironmentCredentials, resolveBrowserCredentials } from './src/auth-session.js';
import { captureSearchBizFingerprint } from './src/fingerprint-capture.js';
import { executeSearchBiz } from './src/search-biz.js';

cli({
  site: 'wechat',
  name: 'search',
  description: 'Search WeChat public accounts and return candidate fakeids',
  access: 'read',
  example: 'bycli wechat search 前端 -f json',
  strategy: Strategy.INTERCEPT,
  browser: args => args['auth-source'] !== 'env',
  args: [
    { name: 'query', positional: true, required: true, help: 'Public account name or keyword' },
    { name: 'limit', type: 'int', default: 10, help: 'Maximum candidates' },
    { name: 'auth-source', choices: ['browser', 'env'], default: 'browser', help: 'Credential source' },
  ],
  columns: ['nickname', 'fakeid', 'alias'],
  func: async (page, args) => {
    const query = readRequiredString(args, 'query');
    const limit = readPositiveInteger(args, 'limit', 10)!;
    const source = readAuthSource(args);
    const credentials = source === 'env'
      ? readEnvironmentCredentials(true)
      : await resolveBrowserCredentials(page, { timeoutMs: 180_000 });
    if (source === 'browser') {
      credentials.fingerprint = await captureSearchBizFingerprint(page!, query, 30_000);
    }
    const rows = await executeSearchBiz({ page, source, credentials, query, limit });
    if (rows.length === 0) throw new EmptyResultError('wechat/search');
    return rows;
  },
});
```

The function never selects the first row automatically.

- [ ] **Step 4: Register list and save commands**

Create `list.ts` and `save.ts` with the same metadata style and these complete functions:

```ts
// list.ts
func: async (page, args, debug) => {
  const source = readAuthSource(args);
  const credentials = source === 'env'
    ? readEnvironmentCredentials(false)
    : await resolveBrowserCredentials(page, { timeoutMs: 180_000 });
  const result = await runCrawler({
    command: 'list',
    fakeid: readRequiredString(args, 'fakeid'),
    name: readRequiredString(args, 'name'),
    limit: readPositiveInteger(args, 'limit'),
    maxPages: readPositiveInteger(args, 'max-pages'),
    timeoutMs: 30_000,
    credentials,
    verbose: debug,
  });
  return mapListRows(result.envelope as CrawlerListEnvelope);
},

// save.ts
func: async (page, args, debug) => {
  const source = readAuthSource(args);
  const credentials = source === 'env'
    ? readEnvironmentCredentials(false)
    : await resolveBrowserCredentials(page, { timeoutMs: 180_000 });
  const result = await runCrawler({
    command: 'save',
    fakeid: readRequiredString(args, 'fakeid'),
    name: readRequiredString(args, 'name'),
    outputDir: readRequiredString(args, 'output-dir'),
    limit: readPositiveInteger(args, 'limit'),
    maxPages: readPositiveInteger(args, 'max-pages'),
    timeoutMs: 30_000,
    credentials,
    verbose: debug,
  });
  const rows = mapSaveRows(result.envelope as CrawlerSaveEnvelope);
  if (result.exitCode === 2) process.exitCode = 2;
  return rows;
},
```

Register list with `access: 'read'`, `Strategy.COOKIE`, and columns `['title', 'author', 'digest', 'publishedAt', 'url']`. Register save with `access: 'write'`, `Strategy.COOKIE`, and columns `['title', 'status', 'stage', 'path', 'error', 'url']`. Both declare `browser: args => args['auth-source'] !== 'env'`; neither exposes crawler `--output` or passes token/Cookie as command arguments.

- [ ] **Step 5: Run command tests, typecheck, and build**

```bash
rtk npx vitest run test/commands.test.ts
rtk npm run typecheck
rtk npm run build
```

Expected: tests PASS; root `search.js`, `list.js`, and `save.js` exist, contain the `cli()` scanner marker, and import their matching `dist/*.js` entry.

- [ ] **Step 6: Commit command registration**

```bash
rtk git add search.ts list.ts save.ts test/commands.test.ts
rtk git commit -m "feat: register wechat search list and save commands"
```

### Task 8: Add integration, packaging, and user documentation

**Files:**
- Create: `test/plugin.integration.test.ts`
- Create: `README.md`
- Create: `test/wechat-browser.e2e.test.ts`

- [ ] **Step 1: Add package and CLI integration tests**

Create `test/plugin.integration.test.ts` that:

1. Runs `npm pack --dry-run --json` and asserts the tarball includes `bycli-plugin.json`, three root JavaScript shims, `dist/`, and no `test/fixtures`, `.env`, trace, Cookie, or token files.
2. Writes a temporary CommonJS preload that replaces `globalThis.fetch` with deterministic responses for `search_biz`, `appmsgpublish`, and synthetic article HTML; launch the plugin/child process with `NODE_OPTIONS=--require=<absolute preload path>` so the real pinned crawler binary runs without production network access.
3. Runs the local byCLI binary with the plugin installed from the local directory in an isolated `HOME`.
4. Executes env-mode list/save and asserts stdout is valid JSON, stderr contains no synthetic credentials, list has at most `--limit`, and partial save exits 2 after printing both rows.
5. Executes env-mode search against an injected local HTTP server; production `mp.weixin.qq.com` must never be contacted in CI.

- [ ] **Step 2: Run integration tests**

```bash
rtk npx vitest run test/plugin.integration.test.ts
```

Expected: PASS with no real browser, account, or network dependency.

- [ ] **Step 3: Write operational documentation**

Create `README.md` with:

- Installation requiring `@sovovs/bycli >=2.1.0 <3.0.0`.
- Two-step `search` then explicit `list/save` examples.
- Default browser behavior: reuse login; when missing, focus the WeChat window and wait up to 180 seconds.
- CI examples with `WECHAT_TOKEN`, `WECHAT_COOKIE`, and search-only `WECHAT_FINGERPRINT` provided through the CI secret store.
- Explicit warning not to put secrets in argv, config, fixtures, screenshots, Issues, or logs.
- Recovery: log out of WeChat public platform and log in again after exposure.
- Statement that private backend endpoints may change and usage must follow WeChat rules and applicable law.

- [ ] **Step 4: Run full verification**

```bash
rtk npm run typecheck
rtk npm test
rtk npm run build
rtk npm pack --dry-run
rtk git diff --check
rtk rg -n 'slave_sid=|data_ticket=|WECHAT_TOKEN=.{4}|fingerprint=.{4}' . --glob '!package-lock.json' --glob '!README.md' --glob '!test/redact.test.ts'
```

Expected: typecheck/build/tests exit 0; pack list includes only intended runtime files; the secret scan finds no committed credential values. Synthetic redaction assertions are allowed only in the named test file.

- [ ] **Step 5: Perform the opt-in real-browser E2E**

Outside normal CI, with a disposable authorized account and no trace retention:

```bash
rtk env BYCLI_WECHAT_E2E=1 npx vitest run test/wechat-browser.e2e.test.ts
```

Expected: if already logged in, search returns candidate rows; if logged out, the window is focused and waits for manual login; no test output or artifact contains token, Cookie, or fingerprint. The E2E file must be skipped unless `BYCLI_WECHAT_E2E=1` and must never snapshot raw responses.

- [ ] **Step 6: Commit integration and docs**

```bash
rtk git add README.md test/plugin.integration.test.ts test/wechat-browser.e2e.test.ts
rtk git commit -m "test: verify wechat plugin integration"
```

- [ ] **Step 7: Request review before publishing**

Run `superpowers:requesting-code-review` with special attention to credential flow, process termination, partial exit behavior, flat plugin packaging, and the absence of real secrets. Publish only after review findings and the full verification matrix are clean.
