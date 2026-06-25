/**
 * High-Level init module (M5b · createAdapterDraft, 07-high-level-services.md).
 *
 * Hosted main-repo side (Codex A' verdict): FS writes live here, not in dashboard-be.
 * Uses the PURE pieces from @sovovs/bycli-recorder-core (validate/render/provenance/
 * dry-run); this module adds the IO: overwrite/shadow check, write to disk, commit
 * marker, config-snapshot injection.
 *
 * SCOPE (甲 / phase-1): writes report + adapter with an embedded provenance header
 * and a commit marker, so a visible adapter always carries provenance (07 forbids an
 * un-provenanced adapter). The FULL multi-file atomic write transaction (txn manifest
 * + fsync + atomic rename) and the crash-recovery table (07:97-104) are deferred —
 * tracked as M5b follow-up. Until then writes are direct (non-atomic), which is
 * acceptable for a single-user local tool with the provenance+marker guard.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  validateAdapterName, renderAdapterTemplate, buildProvenanceHeader, computeDryRunDiff,
  decideInitRecovery,
  type DryRunDiff, type InitRecoveryState,
} from '@sovovs/bycli-recorder-core';

/**
 * High-Level init input (be → daemon /v1/init). Per 03:74 these are the DERIVED draft inputs:
 * be derives `domain`/`strategy` from the selected RankCandidate (the UI-facing Recorder
 * InitRequest is select-only and never carries them). `browser` is normally omitted and
 * derived from `strategy` (COOKIE/UI ⇒ true), matching registry normalizeCommand; pass it
 * only to force a value.
 */
export interface InitInput {
  /** site/command */
  name: string;
  /** derived by be from the candidate endpoint host (03:74). */
  domain?: string;
  /** derived by be from the candidate: authRequired ⇒ COOKIE else PUBLIC (03:74). */
  strategy?: 'PUBLIC' | 'COOKIE' | 'UI';
  /** optional explicit override; default is derived from strategy (COOKIE/UI ⇒ true). */
  browser?: boolean;
  /** ADR-0005: required when writePolicy=write. */
  writePolicy?: 'dry-run' | 'write';
  responsibleUseAcknowledgedAt?: number;
}

/** Config snapshot injected into every RecorderReport (09). */
export interface ConfigSnapshot {
  releaseChannel: 'stable' | 'preview';
  localExperimentProfile: 'off' | 'control' | 'candidate';
  configSnapshotVersion: number;
}

export interface RecorderReport {
  adapterPath: string;
  reportPath: string;
  warnings: string[];
  responsibleUseAcknowledgedAt: number;
  releaseChannel: string;
  localExperimentProfile: string;
  configSnapshotVersion: number;
}

export type InitResult =
  | { ok: true; report: RecorderReport; dryRun: DryRunDiff }
  | { ok: false; errorCode: 'validation_failed' | 'responsible_use_required'; reason: string };

const DEFAULT_SNAPSHOT: ConfigSnapshot = {
  releaseChannel: 'stable', localExperimentProfile: 'off', configSnapshotVersion: 1,
};

function clisDir(site: string): string {
  return path.join(os.homedir(), '.bycli', 'clis', site);
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Transaction manifest persisted under the recorder `.txn` dir (07:99). The crash-recovery
 * sweep (recoverInitTransactions) reads these to resolve interrupted writes. */
export interface InitTxnManifest {
  txnId: string;
  adapterPath: string;
  reportPath: string;
  markerPath: string;
  adapterSha256: string;
  reportSha256: string;
  state: 'preparing' | 'committed';
  createdAt: number;
}

/** fsync a directory so a contained rename/create is durable. Best-effort: some platforms
 * (notably Windows) reject opening a directory for fsync. */
function fsyncDir(dir: string): void {
  let dfd: number | undefined;
  try { dfd = fs.openSync(dir, 'r'); fs.fsyncSync(dfd); }
  catch { /* directory fsync unsupported on this platform */ }
  finally { if (dfd !== undefined) fs.closeSync(dfd); }
}

/** Atomic file write (07:101-103): write to a sibling temp, fsync the fd, rename onto the
 * final path, then fsync the parent dir so the rename itself is durable. 0600 (owner-only). */
function atomicWrite(finalPath: string, content: string): void {
  const dir = path.dirname(finalPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(finalPath)}.${randomUUID()}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600); // exclusive create
  try { fs.writeSync(fd, content); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, finalPath);
  fsyncDir(dir);
}

function writeManifest(manifestPath: string, manifest: InitTxnManifest): void {
  atomicWrite(manifestPath, JSON.stringify(manifest));
}

/**
 * Create an adapter draft. With writePolicy 'dry-run' (default) nothing is written —
 * only the diff + intended report is returned. With 'write' it requires
 * responsibleUseAcknowledgedAt (ADR-0005) and writes report + adapter to disk.
 */
export function createAdapterDraft(
  input: InitInput,
  snapshot: ConfigSnapshot = DEFAULT_SNAPSHOT,
): InitResult {
  const v = validateAdapterName(input.name);
  if (!v.ok) return { ok: false, errorCode: 'validation_failed', reason: v.reason };
  const { site, command } = v.parts;

  const writePolicy = input.writePolicy ?? 'dry-run';
  if (writePolicy === 'write' && !input.responsibleUseAcknowledgedAt) {
    return { ok: false, errorCode: 'responsible_use_required', reason: 'responsibleUseAcknowledgedAt required when writePolicy=write (ADR-0005)' };
  }

  const dir = clisDir(site);
  const adapterPath = path.join(dir, `${command}.js`);
  const reportPath = path.join(os.homedir(), '.bycli', 'sites', site, 'recorder', `${command}-report.json`);

  const warnings: string[] = [];
  // shadow/overwrite check (mandatory, 07:64): refuse to silently clobber.
  const existing = fs.existsSync(adapterPath) ? fs.readFileSync(adapterPath, 'utf-8') : null;
  if (existing !== null) {
    warnings.push(`adapter already exists at ${adapterPath}; init will overwrite (review the dry-run diff)`);
  }

  const report: RecorderReport = {
    adapterPath, reportPath, warnings,
    responsibleUseAcknowledgedAt: input.responsibleUseAcknowledgedAt ?? 0,
    releaseChannel: snapshot.releaseChannel,
    localExperimentProfile: snapshot.localExperimentProfile,
    configSnapshotVersion: snapshot.configSnapshotVersion,
  };

  // Render with provenance header so even phase-1 (non-atomic) writes are provenanced.
  const txnId = randomUUID();
  const reportJson = JSON.stringify(report, null, 2);
  const provenanceHeader = buildProvenanceHeader({ txnId, reportPath, reportSha256: sha256(reportJson) });
  // browser derived from strategy (COOKIE/UI ⇒ authenticated browser context; PUBLIC ⇒ none),
  // matching registry normalizeCommand — be derives & sends domain/strategy but not browser (03:74).
  const browser = input.browser ?? (input.strategy !== undefined && input.strategy !== 'PUBLIC');
  const rendered = renderAdapterTemplate({ site, command, domain: input.domain, strategy: input.strategy, browser, provenanceHeader });
  const dryRun = computeDryRunDiff(existing, rendered);

  if (writePolicy === 'dry-run') {
    return { ok: true, report, dryRun };
  }

  // Write transaction (07:95-104). A crash between the two artifact renames must never leave a
  // visible adapter without provenance, so: manifest(preparing) → atomic report → atomic
  // adapter (report committed FIRST) → atomic commit marker → manifest(committed). Each
  // atomicWrite is temp-file + fsync + rename + parent-dir fsync. The crash-recovery sweep
  // (recoverInitTransactions, 07:106-117) resolves any interruption from the manifest.
  const adapterSha256 = sha256(rendered);
  const reportSha256 = sha256(reportJson);
  const recoveryDir = path.join(path.dirname(reportPath), '.txn');
  const manifestPath = path.join(recoveryDir, `${command}.${txnId}.manifest.json`);
  const markerPath = path.join(path.dirname(reportPath), `${command}.commit.json`);

  writeManifest(manifestPath, { txnId, adapterPath, reportPath, markerPath, adapterSha256, reportSha256, state: 'preparing', createdAt: Date.now() });
  atomicWrite(reportPath, reportJson);
  atomicWrite(adapterPath, rendered);
  atomicWrite(markerPath, JSON.stringify({ txnId, adapterPath, reportPath, adapterSha256, reportSha256, committedAt: Date.now() }));
  writeManifest(manifestPath, { txnId, adapterPath, reportPath, markerPath, adapterSha256, reportSha256, state: 'committed', createdAt: Date.now() });

  return { ok: true, report, dryRun };
}

// ── Startup crash recovery (07:106-117) ─────────────────────────────────────

export interface InitRecoveryResult { scanned: number; committed: number; rolledForward: number; rolledBack: number; quarantined: number; }

/** First line of every recorder-generated adapter (buildProvenanceHeader). Recovery only
 * ever quarantines a file carrying this — never an unknown user-authored file (07:106,117). */
const PROVENANCE_MARKER = '// @generated-by adapter-recorder';

function readManifest(p: string): InitTxnManifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<InitTxnManifest>;
    if (typeof m.txnId !== 'string' || typeof m.adapterPath !== 'string' || typeof m.reportPath !== 'string'
      || typeof m.markerPath !== 'string' || (m.state !== 'preparing' && m.state !== 'committed')) return null;
    return m as InitTxnManifest;
  } catch { return null; }
}

function fileSha(p: string): string | null {
  try { return sha256(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

/** Gather the on-disk state of a manifest's referenced report/adapter/marker for decideInitRecovery. */
function observeTxnState(m: InitTxnManifest): InitRecoveryState {
  const reportSha = fileSha(m.reportPath);
  const adapterSha = fileSha(m.adapterPath);
  const reportExists = reportSha !== null;
  const adapterExists = adapterSha !== null;
  const hashesMatch = reportExists && adapterExists && reportSha === m.reportSha256 && adapterSha === m.adapterSha256;
  let markerExists = false;
  let markerValid = false;
  try {
    const marker = JSON.parse(fs.readFileSync(m.markerPath, 'utf-8')) as Record<string, unknown>;
    markerExists = true;
    markerValid = marker.txnId === m.txnId && marker.adapterPath === m.adapterPath && marker.reportPath === m.reportPath
      && marker.adapterSha256 === m.adapterSha256 && marker.reportSha256 === m.reportSha256;
  } catch { /* no/unreadable marker */ }
  return { reportExists, adapterExists, markerExists, markerValid, hashesMatch, manifestState: m.state };
}

/** Move an unprovenanced/corrupt adapter aside — only if it carries our provenance header. */
function quarantineAdapter(m: InitTxnManifest, log: (msg: string) => void): void {
  let content: string;
  try { content = fs.readFileSync(m.adapterPath, 'utf-8'); } catch { return; } // already gone
  if (!content.startsWith(PROVENANCE_MARKER)) { log(`[init-recovery] refuse to quarantine non-recorder file ${m.adapterPath}`); return; }
  const qDir = path.join(path.dirname(m.reportPath), '.quarantine');
  fs.mkdirSync(qDir, { recursive: true });
  const dest = path.join(qDir, `${path.basename(m.adapterPath)}.${m.txnId}`);
  try { fs.renameSync(m.adapterPath, dest); log(`[init-recovery] quarantined ${m.adapterPath} → ${dest}`); }
  catch { /* best-effort */ }
}

/**
 * Resolve init write transactions interrupted by a crash (07:106-117). Scans every
 * ~/.bycli/sites/<site>/recorder/.txn/*.manifest.json, observes the referenced artifacts, and
 * applies decideInitRecovery: write/refresh the marker for a provenance-complete transaction,
 * quarantine an unprovenanced/corrupt adapter, or roll back an empty one. Only manifest paths
 * (and adapters with the provenance header) are touched — unknown user files are never deleted.
 * Designed to run once at daemon startup (extends the verify reap).
 */
export function recoverInitTransactions(opts: { sitesRoot?: string; log?: (msg: string) => void } = {}): InitRecoveryResult {
  const sitesRoot = opts.sitesRoot ?? path.join(os.homedir(), '.bycli', 'sites');
  const log = opts.log ?? (() => {});
  const result: InitRecoveryResult = { scanned: 0, committed: 0, rolledForward: 0, rolledBack: 0, quarantined: 0 };

  let sites: string[];
  try { sites = fs.readdirSync(sitesRoot); } catch { return result; }

  for (const site of sites) {
    const txnDir = path.join(sitesRoot, site, 'recorder', '.txn');
    let entries: string[];
    try { entries = fs.readdirSync(txnDir).filter((f) => f.endsWith('.manifest.json')); } catch { continue; }
    for (const entry of entries) {
      const manifestPath = path.join(txnDir, entry);
      const m = readManifest(manifestPath);
      if (!m) { try { fs.rmSync(manifestPath, { force: true }); } catch { /* ignore */ } continue; }
      result.scanned++;
      const action = decideInitRecovery(observeTxnState(m));
      switch (action) {
        case 'roll_forward':
          // provenance complete (report+adapter+hashes) but marker missing → write it.
          atomicWrite(m.markerPath, JSON.stringify({ txnId: m.txnId, adapterPath: m.adapterPath, reportPath: m.reportPath, adapterSha256: m.adapterSha256, reportSha256: m.reportSha256, committedAt: Date.now() }));
          result.rolledForward++;
          break;
        case 'commit':
          result.committed++; // marker already valid; the manifest drop below is the commit
          break;
        case 'quarantine':
          quarantineAdapter(m, log);
          result.quarantined++;
          break;
        case 'rolled_back':
          result.rolledBack++; // orphan report retained; nothing live to undo
          break;
        case 'noop':
        default:
          break;
      }
      // terminal: drop the manifest (provenance now lives in the marker / quarantine record).
      try { fs.rmSync(manifestPath, { force: true }); } catch { /* ignore */ }
    }
  }
  if (result.scanned > 0) log(`[init-recovery] swept ${result.scanned}: ${JSON.stringify(result)}`);
  return result;
}
