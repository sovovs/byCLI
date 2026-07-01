import { describe, it, expect } from 'vitest';
import {
  validateAdapterName, renderAdapterTemplate, buildProvenanceHeader, computeDryRunDiff,
  decideInitRecovery, type InitRecoveryState,
} from './init.js';

describe('init · validateAdapterName', () => {
  it('accepts site/command', () => {
    const r = validateAdapterName('hn/top');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parts).toEqual({ site: 'hn', command: 'top' });
  });
  it('rejects wrong part count', () => {
    expect(validateAdapterName('hn').ok).toBe(false);
    expect(validateAdapterName('a/b/c').ok).toBe(false);
    expect(validateAdapterName('hn/').ok).toBe(false);
  });
  it('rejects illegal chars (path traversal / spaces)', () => {
    expect(validateAdapterName('../etc/passwd').ok).toBe(false);
    expect(validateAdapterName('hn/a b').ok).toBe(false);
    expect(validateAdapterName('hn/a.b').ok).toBe(false);
  });
});

describe('init · renderAdapterTemplate', () => {
  it('renders a valid adapter with site/command/domain', () => {
    const src = renderAdapterTemplate({ site: 'hn', command: 'top', domain: 'news.ycombinator.com' });
    expect(src).toContain('site: "hn"');
    expect(src).toContain('name: "top"');
    expect(src).toContain('domain: "news.ycombinator.com"');
    expect(src).toContain('Strategy.PUBLIC');
    expect(src).toContain('async (kwargs) =>');
  });
  it('browser:true switches func signature', () => {
    const src = renderAdapterTemplate({ site: 'x', command: 'y', browser: true });
    expect(src).toContain('async (page, kwargs) =>');
    expect(src).toContain('browser: true');
  });
  it('JSON-escapes values (no template breakout)', () => {
    const src = renderAdapterTemplate({ site: 'a"+evil', command: 'b' });
    // the quote is escaped inside a JSON string, not breaking the literal
    expect(src).toContain('site: "a\\"+evil"');
  });
  it('embeds provenance header at the top when provided', () => {
    const header = buildProvenanceHeader({ txnId: 't1', reportPath: '/r.json', reportSha256: 'abc' });
    const src = renderAdapterTemplate({ site: 'a', command: 'b', provenanceHeader: header });
    expect(src.startsWith('// @generated-by adapter-recorder')).toBe(true);
    expect(src).toContain('// @txn t1');
  });
  it('无 LLM 字段时保持 TODO 空骨架(func/columns/description 留白)', () => {
    const src = renderAdapterTemplate({ site: 'a', command: 'b' });
    expect(src).toContain("description: '', // TODO");
    expect(src).toContain('columns: [], // TODO');
    expect(src).toContain('// TODO: implement data fetching');
    expect(src).toContain('return [];');
  });
  it('有 LLM funcBody/columns/description/access 时填进留白(funcBody 原样、其余 JSON 转义)', () => {
    const src = renderAdapterTemplate({
      site: 'x', command: 'search',
      funcBody: '    const r = await fetch(`https://x.com/api/search?q=${kwargs.keyword}`);\n    return await r.json();',
      columns: [{ name: 'title' }, { name: 'url' }],
      description: 'Search x.com listings',
      access: 'read',
    });
    expect(src).toContain('const r = await fetch('); // funcBody 原样插入
    expect(src).not.toContain('// TODO: implement data fetching'); // 不再是空骨架
    expect(src).not.toContain('return [];');
    expect(src).toContain('columns: ["title","url"],');
    expect(src).toContain('description: "Search x.com listings",');
    expect(src).toContain("access: \"read\",");
  });
});

describe('init · buildProvenanceHeader', () => {
  it('builds non-sensitive 4-line header', () => {
    const h = buildProvenanceHeader({ txnId: 'tx', reportPath: '/p.json', reportSha256: 'deadbeef' });
    expect(h.split('\n')).toHaveLength(4);
    expect(h).toContain('@txn tx');
    expect(h).toContain('@report-sha256 deadbeef');
  });
  it('llmModel 标注 AI 生成 + @model(审计可区分)', () => {
    const h = buildProvenanceHeader({ txnId: 'tx', reportPath: '/p.json', reportSha256: 'd', llmModel: 'claude-opus-4-8' });
    expect(h.startsWith('// @generated-by adapter-recorder-llm')).toBe(true);
    expect(h).toContain('// @model claude-opus-4-8');
  });
});

describe('init · computeDryRunDiff', () => {
  it('null existing → pure create', () => {
    expect(computeDryRunDiff(null, 'x\ny')).toEqual({ exists: false, changedLines: null });
  });
  it('counts changed + added lines', () => {
    const d = computeDryRunDiff('a\nb', 'a\nB\nc');
    expect(d.exists).toBe(true);
    expect(d.changedLines).toBe(2); // b→B changed + c added
  });
  it('identical → 0 changed', () => {
    expect(computeDryRunDiff('a\nb', 'a\nb').changedLines).toBe(0);
  });
});

describe('init · decideInitRecovery (07:108-116 crash-recovery state table)', () => {
  // base = a fully-completed transaction (everything present, committed)
  const base = (over: Partial<InitRecoveryState> = {}): InitRecoveryState => ({
    reportExists: true, adapterExists: true, markerExists: true, markerValid: true,
    hashesMatch: true, manifestState: 'committed', ...over,
  });

  it('committed + valid marker + matching hashes → noop', () => {
    expect(decideInitRecovery(base())).toBe('noop');
  });
  it('marker valid + hashes match but manifest still preparing → commit (07:115)', () => {
    expect(decideInitRecovery(base({ manifestState: 'preparing' }))).toBe('commit');
  });
  it('report + adapter, hashes match, no marker → roll_forward (07:111)', () => {
    expect(decideInitRecovery(base({ markerExists: false, markerValid: false, manifestState: 'preparing' }))).toBe('roll_forward');
  });
  it('report only (adapter missing), no marker → rolled_back (07:110)', () => {
    expect(decideInitRecovery(base({ adapterExists: false, markerExists: false, markerValid: false, hashesMatch: false, manifestState: 'preparing' }))).toBe('rolled_back');
  });
  it('adapter present, report missing → quarantine (07:112)', () => {
    expect(decideInitRecovery(base({ reportExists: false, markerExists: false, markerValid: false, hashesMatch: false, manifestState: 'preparing' }))).toBe('quarantine');
  });
  it('marker present but hash/path mismatch → quarantine (07:113)', () => {
    expect(decideInitRecovery(base({ markerValid: false, manifestState: 'preparing' }))).toBe('quarantine');
  });
  it('nothing durable written, manifest preparing → rolled_back (07:114)', () => {
    expect(decideInitRecovery(base({ reportExists: false, adapterExists: false, markerExists: false, markerValid: false, hashesMatch: false, manifestState: 'preparing' }))).toBe('rolled_back');
  });
  it('torn adapter (hash mismatch), no marker → quarantine (conservative fallthrough)', () => {
    expect(decideInitRecovery(base({ markerExists: false, markerValid: false, hashesMatch: false, manifestState: 'preparing' }))).toBe('quarantine');
  });
});
