/**
 * Adapter init — PURE pieces (M5b).
 *
 * Deterministic, no IO: name/path validation, adapter template rendering (template
 * functions, never raw user-code injection — 07:66), provenance header construction,
 * and dry-run diff. The FS-touching parts (write transaction, fsync/rename, crash
 * recovery, shadow check reading disk, config snapshot) stay in the main-repo daemon
 * init module — only this pure layer lives in the shared package (rank/analyze split).
 */

export interface AdapterNameParts {
  site: string;
  command: string;
}

export type NameValidation =
  | { ok: true; parts: AdapterNameParts }
  | { ok: false; reason: string };

const NAME_PART_RE = /^[a-zA-Z0-9_-]+$/;

/** Validate `site/command` (07:61-62): two parts, each `[a-zA-Z0-9_-]+`. */
export function validateAdapterName(name: string): NameValidation {
  const parts = name.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: 'name must be site/command format (e.g. hn/top)' };
  }
  const [site, command] = parts;
  if (!NAME_PART_RE.test(site) || !NAME_PART_RE.test(command)) {
    return { ok: false, reason: 'name parts must be alphanumeric/dash/underscore only' };
  }
  return { ok: true, parts: { site, command } };
}

export interface AdapterTemplateInput {
  site: string;
  command: string;
  domain?: string;
  strategy?: 'PUBLIC' | 'COOKIE' | 'UI';
  browser?: boolean;
  /** provenance header lines embedded at the top (07:89). */
  provenanceHeader?: string;
  /** LLM 合成填充(MVP):有则填进留白,无则保持 TODO 空骨架(字节级不变)。
   *  funcBody = `async (kwargs) => { ... }` 的**函数体**,**原样插入**(LLM 生成代码,非数据值,
   *  刻意打破 no-raw-user-code;靠 verify 子进程隔离 + dry-run 人工审阅兜底)。其余仍 JSON 转义。 */
  funcBody?: string;
  columns?: Array<{ name: string }>;
  description?: string;
  access?: 'read' | 'write';
}

/**
 * Render adapter source from a fixed template. String values are JSON-escaped so a crafted
 * site/command/domain cannot break out of the template literal. The one exception is
 * `funcBody` (LLM-generated code) which is inserted raw — see AdapterTemplateInput.
 */
export function renderAdapterTemplate(input: AdapterTemplateInput): string {
  const site = JSON.stringify(input.site);
  const command = JSON.stringify(input.command);
  const domain = JSON.stringify(input.domain ?? input.site);
  const strategy = input.strategy ?? 'PUBLIC';
  const browser = input.browser === true;
  const header = input.provenanceHeader ? input.provenanceHeader.replace(/\n?$/, '\n') : '';
  const funcSig = browser ? 'async (page, kwargs) =>' : 'async (kwargs) =>';

  // 各留白:有 LLM 产物则填(数据值 JSON 转义,funcBody 原样);无则保持原 TODO 行(字节级不变)。
  const descLine = input.description
    ? `  description: ${JSON.stringify(input.description)},`
    : `  description: '', // TODO: describe what this command does`;
  const accessLine = input.access
    ? `  access: ${JSON.stringify(input.access)},`
    : `  access: 'read',  // TODO: 'read' for queries, 'write' for remote/account state changes`;
  const columnsLine = input.columns && input.columns.length
    ? `  columns: ${JSON.stringify(input.columns.map((c) => c.name))},`
    : `  columns: [], // TODO: field names for table output`;
  const funcBlock = input.funcBody
    ? `  func: ${funcSig} {\n${input.funcBody}\n  },`
    : `  func: ${funcSig} {\n    // TODO: implement data fetching (prefer fetch over browser automation)\n    return [];\n  },`;

  return `${header}import { cli, Strategy } from '@sovovs/bycli/registry';

cli({
  site: ${site},
  name: ${command},
${descLine}
${accessLine}
  example: ${JSON.stringify(`bycli ${input.site} ${input.command} -f yaml`)},
  domain: ${domain},
  strategy: Strategy.${strategy},
  browser: ${browser},
  args: [
    { name: 'limit', type: 'int', default: 10, help: 'Number of items' },
  ],
${columnsLine}
${funcBlock}
});
`;
}

export interface ProvenanceInput {
  txnId: string;
  reportPath: string;
  reportSha256: string;
  /** LLM 合成时标注:生成器改 `adapter-recorder-llm` + 附 @model,供审计区分模板骨架 vs 模型生成。 */
  llmModel?: string;
}

/** Build the non-sensitive provenance header embedded in generated adapters (07:89). */
export function buildProvenanceHeader(p: ProvenanceInput): string {
  const lines = [
    p.llmModel ? '// @generated-by adapter-recorder-llm' : '// @generated-by adapter-recorder',
    `// @txn ${p.txnId}`,
    `// @report ${p.reportPath}`,
    `// @report-sha256 ${p.reportSha256}`,
  ];
  if (p.llmModel) lines.push(`// @model ${p.llmModel}`);
  return lines.join('\n');
}

export interface DryRunDiff {
  exists: boolean;
  /** unified-ish line diff summary; null when target does not exist (pure create). */
  changedLines: number | null;
}

/**
 * Compute a dry-run diff between existing on-disk content (passed in by the caller,
 * keeping this pure) and the rendered draft. Returns line-change count.
 */
export function computeDryRunDiff(existingContent: string | null, rendered: string): DryRunDiff {
  if (existingContent === null) return { exists: false, changedLines: null };
  const a = existingContent.split('\n');
  const b = rendered.split('\n');
  let changed = Math.abs(a.length - b.length);
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) if (a[i] !== b[i]) changed++;
  return { exists: true, changedLines: changed };
}

// ── Crash recovery decision (07:106-117, pure) ──────────────────────────────

export type InitRecoveryAction = 'noop' | 'commit' | 'roll_forward' | 'rolled_back' | 'quarantine';

/** Observed on-disk state of an init transaction, gathered by the (IO) recovery sweep. */
export interface InitRecoveryState {
  reportExists: boolean;
  adapterExists: boolean;
  markerExists: boolean;
  /** marker present AND its txnId/paths/hashes match the manifest. */
  markerValid: boolean;
  /** the on-disk report AND adapter hashes both match the manifest. */
  hashesMatch: boolean;
  manifestState: 'preparing' | 'committed';
}

/**
 * Decide how to resolve an interrupted init write transaction from its observed state
 * (07:108-116). Pure: the IO sweep gathers the booleans and applies the chosen action.
 * Priority order: corruption / unprovenanced adapter → quarantine; a completed transaction →
 * noop; otherwise roll the partial transaction forward (write marker / mark committed) or back.
 */
export function decideInitRecovery(s: InitRecoveryState): InitRecoveryAction {
  // 07:113 — marker present but hash/path mismatch → quarantine (corruption, highest priority).
  if (s.markerExists && !s.markerValid) return 'quarantine';
  // 07:112 — adapter without a report → quarantine (never leave an unprovenanced adapter live).
  if (s.adapterExists && !s.reportExists) return 'quarantine';
  // normal completed: committed manifest, valid marker, matching hashes, both files → nothing to do.
  if (s.manifestState === 'committed' && s.markerValid && s.hashesMatch && s.reportExists && s.adapterExists) return 'noop';
  // 07:115 — marker valid + hashes match but manifest still 'preparing' → mark committed.
  if (s.markerValid && s.hashesMatch && s.reportExists && s.adapterExists) return 'commit';
  // 07:111 — report + adapter present, hashes match, no marker → roll forward (write the marker).
  if (s.reportExists && s.adapterExists && s.hashesMatch && !s.markerExists) return 'roll_forward';
  // 07:110 — report only (adapter missing), no marker → rolled back (orphan report).
  if (s.reportExists && !s.adapterExists && !s.markerExists) return 'rolled_back';
  // 07:114 — nothing durable written → rolled back cleanup.
  if (!s.reportExists && !s.adapterExists) return 'rolled_back';
  // any other inconsistent combination (e.g. a torn adapter whose hash no longer matches) →
  // quarantine, conservatively — recovery never silently discards a possible provenance gap.
  return 'quarantine';
}
