// M9c High-Level HTTP wrapper —— analyze 异步 worker。analyzeBrowser 需要活的 IPage:这里复刻 M6b
// 连回模式(verify-runner-main.ts:138-154)——直接 `new Page(...)`(**不经 BrowserBridge**,后者
// connect() 会 health-check + spawn/重启 daemon;wrapper 只该 attach 现有 daemon、绝不管理 daemon 生命
// 周期),经 `BYCLI_DAEMON_PORT`(daemon-client.ts:12 模块加载时读)连回父 daemon 拿 Page,跑
// analyzeBrowserWithTimeout,finally 释放 lease(closeWindow)。隔离成可注入 seam → 测试无需真 daemon/Page。
import fs from 'node:fs';
import path from 'node:path';
import { getUserClisDir } from '../../config-paths.js';
import { fileURLToPath } from 'node:url';
import type { AnalyzeReport, AdapterRef } from '../../browser/analyze.js';
import type { ManifestEntry } from '../../manifest-types.js';
import { findPackageRoot, getCliManifestPath } from '../../package-paths.js';

export interface AnalyzeRunInput {
  url: string;
  session: string;
  contextId: string;
  settleMs?: number;
}

/** 可注入 seam:production 构造 daemon-backed Page 跑 analyze;测试注入 fake 返 report 或抛错。 */
export type AnalyzeRunner = (input: AnalyzeRunInput) => Promise<AnalyzeReport>;

let cachedRegistry: Map<string, AdapterRef> | null = null;

function defaultManifestPaths(): string[] {
  const root = findPackageRoot(fileURLToPath(import.meta.url));
  return [
    getCliManifestPath(path.join(root, 'clis')),                          // built-in adapters
    getCliManifestPath(getUserClisDir()),                                 // user adapters
  ];
}

/**
 * Lightweight adapter registry for nearest-adapter matching. The wrapper process
 * SKIPS full adapter discovery (main.ts `internal highlevel-http` fast-path), so
 * `getRegistry()` is empty here. Instead read the same `cli-manifest.json` that
 * discovery reads and build the `{site,name,domain}` AdapterRefs `findNearestAdapter`
 * needs — no adapter code is loaded, faithful to the wrapper's lightweight design.
 * User manifest is read last so it overrides built-ins on `site/name` collisions
 * (mirrors discovery order). Cached for the server lifetime; pass explicit
 * `manifestPaths` (tests) to bypass the cache.
 */
export function loadAdapterRegistry(manifestPaths?: string[]): Map<string, AdapterRef> {
  if (!manifestPaths && cachedRegistry) return cachedRegistry;
  const registry = new Map<string, AdapterRef>();
  for (const manifestPath of manifestPaths ?? defaultManifestPaths()) {
    let raw: string;
    try { raw = fs.readFileSync(manifestPath, 'utf8'); } catch { continue; /* no manifest on disk */ }
    let entries: ManifestEntry[];
    try { entries = JSON.parse(raw) as ManifestEntry[]; } catch { continue; /* corrupt → skip, best-effort */ }
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (!e?.site || !e?.name) continue;
      registry.set(`${e.site}/${e.name}`, { site: e.site, name: e.name, domain: e.domain });
    }
  }
  if (!manifestPaths) cachedRegistry = registry;
  return registry;
}

/**
 * 默认 analyzeRunner(M6b daemon-backed Page)。timeoutMs 透传给 analyzeBrowserWithTimeout(超时 →
 * AnalyzeTimeoutError code='analyze_timeout')。nearest-adapter registry 经 loadAdapterRegistry()
 * 从 cli-manifest.json 轻量加载(wrapper 跳过 discovery,getRegistry() 在此进程为空)。
 */
export function createAnalyzeRunner(opts: { timeoutMs: number }): AnalyzeRunner {
  return async (input) => {
    const { Page } = await import('../../browser/page.js');
    const { analyzeBrowserWithTimeout } = await import('../highlevel/analyze.js');
    // background automation window + ephemeral per-run session,直接连回 daemon(同 M6b)。
    const page = new Page(input.session, undefined, input.contextId, 'background', 'adapter', 'ephemeral');
    try {
      return await analyzeBrowserWithTimeout(
        page,
        loadAdapterRegistry(),
        { url: input.url, settleMs: input.settleMs },
        opts.timeoutMs,
      );
    } finally {
      await page.closeWindow?.().catch(() => { /* best-effort;lease idle-expire 兜底 */ });
    }
  };
}
