/**
 * Navigation interception guard (M1 spike, direct-CDP / Node side).
 *
 * Closes the P0 hole where navigation fired before request interception was armed.
 * The contract (ADR-0002, ADR-0006, 04-security-model.md) is:
 *
 *   1. Pre-check the target URL (syntax + DNS precheck) BEFORE any navigation.
 *   2. Arm Fetch interception (resourceType Document, Request stage) and confirm the
 *      handler is registered BEFORE the single Page.navigate.
 *   3. Re-run the full URL policy on every paused main-frame Document request
 *      (initial + every redirect / secondary main-frame request) and failRequest
 *      anything that does not pass — so a forbidden redirect target receives 0 bytes.
 *   4. If interception cannot be armed, FAIL CLOSED — never fall back to bare
 *      navigation. Callers surface `navigation_redirect_requires_interception`.
 *
 * remoteIPAddress observed on Network.responseReceived is logged only — it is
 * post-connect and therefore `ip-observed-only`, NOT a security boundary (ADR-0006).
 *
 * This module is runtime-bound only through the small InterceptBridge interface,
 * so it is unit-testable with a fake bridge (no real CDP / network).
 */

import { checkUrlPolicy, checkUrlSyntax, type DnsResolver, type UrlPolicyReason } from './url-policy.js';

/** Minimal CDP surface this guard needs (satisfied by CDPBridge). */
export interface InterceptBridge {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: unknown) => void): void;
  off(event: string, handler: (params: unknown) => void): void;
}

export class InterceptionUnavailableError extends Error {
  readonly code = 'navigation_redirect_requires_interception';
  constructor(detail: string) {
    super(`navigation request interception unavailable: ${detail}`);
    this.name = 'InterceptionUnavailableError';
  }
}

export class NavigationBlockedError extends Error {
  readonly code = 'navigation_blocked_by_policy';
  constructor(
    readonly url: string,
    readonly reason: UrlPolicyReason,
    detail: string,
  ) {
    super(`navigation blocked: ${detail}`);
    this.name = 'NavigationBlockedError';
  }
}

interface FetchRequestPaused {
  requestId: string;
  request: { url: string; method: string };
  resourceType?: string;
  frameId?: string;
  networkId?: string;
  /** Present only on the response stage; we arm on Request stage so usually absent. */
  responseStatusCode?: number;
}

export interface BlockedRecord {
  url: string;
  reason: UrlPolicyReason;
}

export interface NavigationGuard {
  /** URLs that were failRequest'd by policy (initial + redirects). */
  readonly blocked: ReadonlyArray<BlockedRecord>;
  /** remoteIPAddress values observed post-connect (logged, not a boundary). */
  readonly observedIps: ReadonlyArray<string>;
  /** Tear down interception + listeners. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Arm Fetch interception and policy re-check, fail-closed. Must be called and
 * resolved BEFORE the caller issues Page.navigate. Throws
 * InterceptionUnavailableError if Fetch cannot be enabled.
 */
export async function armNavigationGuard(
  bridge: InterceptBridge,
  resolver: DnsResolver,
  opts: { allowLiteralIp?: boolean; observeIp?: boolean } = {},
): Promise<NavigationGuard> {
  const blocked: BlockedRecord[] = [];
  const observedIps: string[] = [];

  // Fetch.enable scoped to top-level documents at the Request stage so we block
  // before the request is sent. resourceType uses Network.ResourceType values;
  // 'Document' is the main frame (P1-1).
  try {
    await bridge.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
    });
  } catch (err) {
    throw new InterceptionUnavailableError(err instanceof Error ? err.message : String(err));
  }

  const onPaused = (raw: unknown): void => {
    const p = raw as FetchRequestPaused;
    // Only enforce policy on main-frame Document requests; let sub-resources through
    // unmodified (page sub-resource SSRF is out of scope for the navigation spike).
    if (p.resourceType !== 'Document') {
      void bridge.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      return;
    }
    void (async () => {
      const verdict = await checkUrlPolicy(p.request.url, resolver, opts).catch(() => null);
      if (verdict && verdict.ok) {
        await bridge.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      } else {
        if (verdict && !verdict.ok) blocked.push({ url: p.request.url, reason: verdict.reason });
        // BlockedByClient → the request is never sent to the target.
        await bridge
          .send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' })
          .catch(() => {});
      }
    })();
  };

  const onResponse = (raw: unknown): void => {
    const p = raw as { response?: { remoteIPAddress?: string } };
    const ip = p.response?.remoteIPAddress;
    if (ip) observedIps.push(ip);
  };

  bridge.on('Fetch.requestPaused', onPaused);
  if (opts.observeIp) {
    // Network domain must be enabled elsewhere for this to fire; we only attach the
    // observer. Missing IP (cache/SW/failed request) is tolerated — never a boundary.
    bridge.on('Network.responseReceived', onResponse);
  }

  let disposed = false;
  return {
    blocked,
    observedIps,
    async dispose() {
      if (disposed) return;
      disposed = true;
      bridge.off('Fetch.requestPaused', onPaused);
      if (opts.observeIp) bridge.off('Network.responseReceived', onResponse);
      await bridge.send('Fetch.disable').catch(() => {});
    },
  };
}

/**
 * Full guarded navigation for the direct-CDP path. Pre-checks the URL, arms the
 * guard, runs the caller-supplied navigate thunk (which issues Page.navigate), and
 * keeps the guard live for redirects until the caller disposes it.
 *
 * Returns the live guard so the caller can inspect blocked/observedIps and dispose
 * after the page settles. Throws NavigationBlockedError if the initial target fails
 * policy (we never arm/navigate to a known-bad target), or
 * InterceptionUnavailableError if interception cannot be armed.
 */
export async function guardedNavigate(
  bridge: InterceptBridge,
  url: string,
  resolver: DnsResolver,
  navigate: () => Promise<void>,
  opts: { allowLiteralIp?: boolean; observeIp?: boolean } = {},
): Promise<NavigationGuard> {
  // 1. Pre-check the initial target before doing anything else.
  const pre = await checkUrlPolicy(url, resolver, opts);
  if (!pre.ok) {
    throw new NavigationBlockedError(url, pre.reason, pre.detail);
  }
  // 2. Arm interception (fail-closed) and confirm before navigating.
  const guard = await armNavigationGuard(bridge, resolver, opts);
  // 3. Navigate exactly once, now that the guard is live.
  try {
    await navigate();
  } catch (err) {
    await guard.dispose();
    throw err;
  }
  return guard;
}

/** Convenience: synchronous pre-screen without DNS, for callers that only have the
 *  syntax layer available (e.g. the extension service worker, which cannot resolve). */
export function screenSyntaxOnly(url: string, opts: { allowLiteralIp?: boolean } = {}) {
  return checkUrlSyntax(url, opts);
}
