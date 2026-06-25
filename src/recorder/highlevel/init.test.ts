import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createAdapterDraft, recoverInitTransactions } from './init.js';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

// ── createAdapterDraft: write transaction (M5b follow-up) + H-002 browser derivation ──
describe('createAdapterDraft (write transaction + browser derivation)', () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'init-test-'));
    prevHome = process.env.HOME;
    process.env.HOME = home; // createAdapterDraft writes under os.homedir()/.bycli
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const ack = 1_700_000_000_000;

  it('dry-run (default) writes nothing', () => {
    const r = createAdapterDraft({ name: 'demo/search', strategy: 'PUBLIC' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(fs.existsSync(r.report.adapterPath)).toBe(false);
  });

  it('write persists report + adapter + commit marker, adapter is provenanced, no leftover .tmp', () => {
    const r = createAdapterDraft({ name: 'demo/search', strategy: 'PUBLIC', writePolicy: 'write', responsibleUseAcknowledgedAt: ack });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fs.existsSync(r.report.adapterPath)).toBe(true);
    expect(fs.existsSync(r.report.reportPath)).toBe(true);
    const markerPath = path.join(path.dirname(r.report.reportPath), 'search.commit.json');
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.readFileSync(r.report.adapterPath, 'utf-8').startsWith('// @generated-by adapter-recorder')).toBe(true);
    // atomic write leaves no temp files behind in either dir
    expect(fs.readdirSync(path.dirname(r.report.adapterPath)).some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(fs.readdirSync(path.dirname(r.report.reportPath)).some((f) => f.endsWith('.tmp'))).toBe(false);
    // manifest finalized to committed
    const txnDir = path.join(path.dirname(r.report.reportPath), '.txn');
    const manifest = JSON.parse(fs.readFileSync(path.join(txnDir, fs.readdirSync(txnDir)[0]), 'utf-8'));
    expect(manifest.state).toBe('committed');
  });

  it('write requires responsibleUseAcknowledgedAt (ADR-0005)', () => {
    const r = createAdapterDraft({ name: 'demo/x', strategy: 'PUBLIC', writePolicy: 'write' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('responsible_use_required');
  });

  it('H-002: browser derived from strategy (COOKIE ⇒ true, PUBLIC ⇒ false)', () => {
    const cookie = createAdapterDraft({ name: 'demo/c', strategy: 'COOKIE', writePolicy: 'write', responsibleUseAcknowledgedAt: ack });
    const pub = createAdapterDraft({ name: 'demo/p', strategy: 'PUBLIC', writePolicy: 'write', responsibleUseAcknowledgedAt: ack });
    expect(cookie.ok && pub.ok).toBe(true);
    if (cookie.ok) expect(fs.readFileSync(cookie.report.adapterPath, 'utf-8')).toContain('browser: true');
    if (pub.ok) expect(fs.readFileSync(pub.report.adapterPath, 'utf-8')).toContain('browser: false');
  });

  it('invalid name → validation_failed (no write)', () => {
    const r = createAdapterDraft({ name: 'bad name', writePolicy: 'write', responsibleUseAcknowledgedAt: ack });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('validation_failed');
  });
});

// ── recoverInitTransactions: startup crash recovery sweep (07:106-117) ──
describe('recoverInitTransactions (crash recovery sweep)', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-test-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  /** Lay down a transaction's on-disk state under <root>/demo/recorder for one command. */
  function writeTxn(command: string, parts: {
    reportContent?: string; adapterContent?: string; validMarker?: boolean;
    manifestState?: 'preparing' | 'committed';
  }): { adapterPath: string; reportPath: string; markerPath: string; manifestPath: string } {
    const recorderDir = path.join(root, 'demo', 'recorder');
    const txnDir = path.join(recorderDir, '.txn');
    const adapterPath = path.join(root, 'demo', 'clis', `${command}.js`);
    const reportPath = path.join(recorderDir, `${command}-report.json`);
    const markerPath = path.join(recorderDir, `${command}.commit.json`);
    const txnId = `tx-${command}`;
    fs.mkdirSync(txnDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'demo', 'clis'), { recursive: true });
    if (parts.reportContent !== undefined) fs.writeFileSync(reportPath, parts.reportContent);
    if (parts.adapterContent !== undefined) fs.writeFileSync(adapterPath, parts.adapterContent);
    const adapterSha256 = parts.adapterContent !== undefined ? sha256(parts.adapterContent) : sha256('A');
    const reportSha256 = parts.reportContent !== undefined ? sha256(parts.reportContent) : sha256('R');
    if (parts.validMarker) {
      fs.writeFileSync(markerPath, JSON.stringify({ txnId, adapterPath, reportPath, adapterSha256, reportSha256, committedAt: 0 }));
    }
    const manifestPath = path.join(txnDir, `${command}.${txnId}.manifest.json`);
    fs.writeFileSync(manifestPath, JSON.stringify({
      txnId, adapterPath, reportPath, markerPath, adapterSha256, reportSha256,
      state: parts.manifestState ?? 'preparing', createdAt: 0,
    }));
    return { adapterPath, reportPath, markerPath, manifestPath };
  }

  it('roll_forward: report+adapter present, hashes match, no marker → writes marker, drops manifest', () => {
    const p = writeTxn('rf', { reportContent: 'R', adapterContent: 'A' });
    const r = recoverInitTransactions({ sitesRoot: root });
    expect(r.rolledForward).toBe(1);
    expect(fs.existsSync(p.markerPath)).toBe(true);
    expect(fs.existsSync(p.manifestPath)).toBe(false);
    expect(fs.existsSync(p.adapterPath)).toBe(true);
  });

  it('quarantine: provenanced adapter but report missing → moved to .quarantine', () => {
    const p = writeTxn('qa', { adapterContent: '// @generated-by adapter-recorder\n// @txn tx-qa\ncode' });
    const r = recoverInitTransactions({ sitesRoot: root });
    expect(r.quarantined).toBe(1);
    expect(fs.existsSync(p.adapterPath)).toBe(false); // moved aside
    const qDir = path.join(path.dirname(p.reportPath), '.quarantine');
    expect(fs.readdirSync(qDir)).toHaveLength(1);
    expect(fs.existsSync(p.manifestPath)).toBe(false);
  });

  it('refuses to quarantine a non-recorder file (no provenance header)', () => {
    const p = writeTxn('nr', { adapterContent: 'console.log("user file")' });
    const r = recoverInitTransactions({ sitesRoot: root });
    expect(r.quarantined).toBe(1); // decision was quarantine...
    expect(fs.existsSync(p.adapterPath)).toBe(true); // ...but the unprovenanced file is left in place
  });

  it('rolled_back: report only (adapter missing), no marker → manifest dropped, report retained', () => {
    const p = writeTxn('rb', { reportContent: 'R' });
    const r = recoverInitTransactions({ sitesRoot: root });
    expect(r.rolledBack).toBe(1);
    expect(fs.existsSync(p.reportPath)).toBe(true);
    expect(fs.existsSync(p.manifestPath)).toBe(false);
  });

  it('noop: committed + valid marker + matching hashes → files unchanged, manifest dropped', () => {
    const p = writeTxn('np', { reportContent: 'R', adapterContent: 'A', validMarker: true, manifestState: 'committed' });
    const r = recoverInitTransactions({ sitesRoot: root });
    expect(r).toMatchObject({ scanned: 1, committed: 0, rolledForward: 0, quarantined: 0, rolledBack: 0 });
    expect(fs.existsSync(p.adapterPath)).toBe(true);
    expect(fs.existsSync(p.markerPath)).toBe(true);
    expect(fs.existsSync(p.manifestPath)).toBe(false); // swept (terminal)
  });

  it('empty / missing sites root → no-op result', () => {
    expect(recoverInitTransactions({ sitesRoot: path.join(root, 'nope') })).toMatchObject({ scanned: 0 });
  });
});
