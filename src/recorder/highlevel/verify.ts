/**
 * High-Level verify module (M5c · verifyAdapter, 07-high-level-services.md).
 *
 * Hosted main-repo side (Codex A' verdict): verify runs user adapter JS, which MUST
 * execute in a child-process runner (08), never in this process. M5c lands the
 * INTERFACE + delegation seam only: validate the adapter name, derive display-only
 * evidence from the raw seed args (HMAC, raw never echoed), then delegate to a
 * RunnerPort. The real runner (spawn / JSONL / env isolation / input.json 0600 /
 * timeout / reap) landed in M6 and is the production default (defaultRunnerPort);
 * a stub RunnerPort is retained as a test double to exercise the seam without spawning.
 *
 * SECURITY (07:123-124, 167): raw executionSeedArgs stay in memory / input.json only;
 * they never enter the returned summary, report, status, or logs.
 */

import { resolve, sep } from 'node:path';
import { getConfigDir } from '../../config-paths.js';
import {
  validateAdapterName, deriveEvidenceSeedArgs,
  type SeedArgEvidence, type VerifySummary,
} from '@sovovs/bycli-recorder-core';
import { defaultRunnerPort } from '../runner/runner-port.js';

export interface VerifyInput {
  /** site/command */
  name: string;
  /** Recorder session id (non-secret) forwarded by be. Consumed daemon-side to look up the
   * per-session HMAC salt (M7a · 04:111) — verifyAdapter itself takes the resolved key as a
   * separate argument, so this field is not read here. */
  sessionId?: string;
  /** Canonical recorder requestId minted by be/Local Service; when set the runner uses it
   * as the run id so be ↔ daemon ↔ runner all key on the same id. */
  requestId?: string;
  /** raw seed args — memory/input.json only, never returned. */
  executionSeedArgs?: Record<string, unknown>;
  fixture?: 'ignore' | 'match' | 'update';
  trace?: 'off' | 'retain-on-failure' | 'always';
  /** N3:显式 adapter 路径 override —— verify 录制器 LLM 生成的临时草稿(不在 clis/),缺省按 name 派生。 */
  adapterPath?: string;
  /** Optional lowercase SHA-256 expected for the exact adapter bytes the runner will execute. */
  expectedSourceSha256?: string;
}

/** The runner boundary (08). M6 provides the real child-process implementation. */
export interface RunnerPort {
  startVerify(input: {
    name: string;
    /** Canonical requestId from the caller; runner generates one if absent. */
    requestId?: string;
    evidenceSeedArgs: Record<string, SeedArgEvidence>;
    rawSeedArgs: Record<string, unknown>;
    fixture: string;
    trace: string;
    /** N3: explicit adapter path override (recorder draft verify); default = name→clis path. */
    adapterPath?: string;
    expectedSourceSha256?: string;
  }): Promise<{ requestId: string }>;
  getVerifyStatus(requestId: string): Promise<VerifySummary | null>;
  cancelVerify(requestId: string): Promise<{ cancelled: boolean }>;
}

export type VerifyResult =
  | { ok: true; requestId: string }
  | { ok: false; errorCode: 'validation_failed' | 'queue_full' | 'runner_protocol_error'; reason: string };

/**
 * Stub runner — the seam without execution. Returns runner_protocol_error with a clear
 * message so callers see the interface is wired but no child ran. Retained as a test
 * double (inject it to exercise verifyAdapter without spawning); the production default is
 * the real spawn-based RunnerPort (M6a).
 */
export const stubRunnerPort: RunnerPort = {
  async startVerify() {
    throw Object.assign(new Error('verify runner not implemented (stub)'), { code: 'runner_protocol_error' });
  },
  async getVerifyStatus() { return null; },
  async cancelVerify() { return { cancelled: false }; },
};

/**
 * verifyAdapter: validate name → derive display-only evidence → delegate to the runner.
 * `sessionHmacKey` keys the evidence HMAC; `runner` defaults to the real child-process
 * RunnerPort (M6a) and can be overridden (stub/fake) in tests.
 */
export async function verifyAdapter(
  input: VerifyInput,
  sessionHmacKey: string,
  runner?: RunnerPort,
): Promise<VerifyResult> {
  const v = validateAdapterName(input.name);
  if (!v.ok) return { ok: false, errorCode: 'validation_failed', reason: v.reason };

  // N3 安全:adapterPath override 必须是 byCLI 配置根(BYCLI_CONFIG_DIR,默认 ~/.bycli)下的绝对
  // 路径(草稿/正式 clis),防越权读任意文件。根随 config-paths 解析,与 clis/sites 落盘同源。
  let adapterPath = input.adapterPath;
  if (adapterPath !== undefined) {
    const abs = resolve(adapterPath);
    const root = resolve(getConfigDir()) + sep;
    if (!abs.startsWith(root)) {
      return { ok: false, errorCode: 'validation_failed', reason: `adapterPath must be under ${getConfigDir()}` };
    }
    adapterPath = abs;
  }
  if (input.expectedSourceSha256 !== undefined && !/^[0-9a-f]{64}$/.test(input.expectedSourceSha256)) {
    return { ok: false, errorCode: 'validation_failed', reason: 'expectedSourceSha256 must be 64 lowercase hex characters' };
  }

  const port = runner ?? defaultRunnerPort();
  const rawSeedArgs = input.executionSeedArgs ?? {};
  const evidenceSeedArgs = deriveEvidenceSeedArgs(rawSeedArgs, sessionHmacKey);

  try {
    const { requestId } = await port.startVerify({
      name: input.name,
      requestId: input.requestId, // canonical id from be (undefined → runner generates)
      evidenceSeedArgs,
      rawSeedArgs, // memory→input.json only, runner's responsibility; never returned
      fixture: input.fixture ?? 'ignore',
      trace: input.trace ?? 'retain-on-failure',
      adapterPath, // N3: validated draft path override (undefined → name→clis)
      expectedSourceSha256: input.expectedSourceSha256,
    });
    return { ok: true, requestId };
  } catch (e) {
    // queue_full (M6c: runner at maxConcurrency + queue saturated, 03 → 429) is surfaced
    // distinctly; any other failure normalizes to runner_protocol_error (08:95).
    const code = (e as { code?: unknown })?.code;
    const errorCode = code === 'queue_full' ? 'queue_full' as const : 'runner_protocol_error' as const;
    return { ok: false, errorCode, reason: e instanceof Error ? e.message : String(e) };
  }
}
