// M9c High-Level HTTP wrapper —— analyze 异步 worker。analyzeBrowser 需要活的 IPage:这里复刻 M6b
// 连回模式(verify-runner-main.ts:138-154)——直接 `new Page(...)`(**不经 BrowserBridge**,后者
// connect() 会 health-check + spawn/重启 daemon;wrapper 只该 attach 现有 daemon、绝不管理 daemon 生命
// 周期),经 `BYCLI_DAEMON_PORT`(daemon-client.ts:12 模块加载时读)连回父 daemon 拿 Page,跑
// analyzeBrowserWithTimeout,finally 释放 lease(closeWindow)。隔离成可注入 seam → 测试无需真 daemon/Page。
import type { AnalyzeReport } from '../../browser/analyze.js';

export interface AnalyzeRunInput {
  url: string;
  session: string;
  contextId: string;
  settleMs?: number;
}

/** 可注入 seam:production 构造 daemon-backed Page 跑 analyze;测试注入 fake 返 report 或抛错。 */
export type AnalyzeRunner = (input: AnalyzeRunInput) => Promise<AnalyzeReport>;

/**
 * 默认 analyzeRunner(M6b daemon-backed Page)。timeoutMs 透传给 analyzeBrowserWithTimeout(超时 →
 * AnalyzeTimeoutError code='analyze_timeout')。nearest-adapter registry 用空 Map(M9c v1,follow-up)。
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
        new Map(),
        { url: input.url, settleMs: input.settleMs },
        opts.timeoutMs,
      );
    } finally {
      await page.closeWindow?.().catch(() => { /* best-effort;lease idle-expire 兜底 */ });
    }
  };
}
