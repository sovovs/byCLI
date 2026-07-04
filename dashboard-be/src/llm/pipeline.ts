// N4 核心 · 编排流水线:score(N1)→ 选 decision==='generate' → generate(N2)→ 静态检查(N2)→
// 写草稿(N2)→ 逐个 verify(N3)→ verifyExpectation 比对 → 收集 verify-ok 草稿。
// 依赖注入(scorer/generator/verifyDraft)便于单测;真实依赖由 be handler 装配。安全顺序:
// 调用方先确保 egress 同意(P0-2)再进本流水线;本流水线对每个脚本先静态白名单再 verify。
import type { RankCandidate } from '@sovovs/bycli-recorder-core';
import type { ScoringProfile } from '@sovovs/bycli-recorder-core';
import type { Scorer, ScoredCandidate } from './score.js';
import { buildScorePrompt } from './score.js';
import type { Generator, GeneratedScript } from './generate.js';
import { buildGenPrompt } from './generate.js';
import { staticCheckScript } from './sandbox-check.js';
import { makeDraftDir, writeDrafts } from './draft-store.js';
import { meetsExpectation, type VerifySummaryLike, type VerifyOutcome } from './verify-expectation.js';
import type { SynthesisSample } from './synthesize.js';

/**
 * 判 verify 失败是否像「字段抽取」类(值得补原始样本 repair 一次):
 * rows/fieldCount 相关的失败(抽不到行 / 字段数不符)= 抽取逻辑没写对,补真实样本最有效。
 * 纯 verify 未成功(ok!=true)/ stage 不符也纳入(常伴随抽取问题)。全放行没坏处(repair 有界一次)。
 */
function isExtractionFailure(verify: VerifyOutcome): boolean {
  if (verify.ok) return false;
  return verify.reasons.some((r) => /rows|fieldCount|字段|ok!=true|抽取|extract/i.test(r));
}

export interface PipelineInput {
  candidates: RankCandidate[];
  samples: SynthesisSample[];
  /** 用户手选要传 LLM 的候选 id(优先于 cap 自动截断)。 */
  candidateIds?: string[];
  /** 候选软上限(env RECORDER_LLM_CANDIDATE_CAP);无手选时按此截断 top-N。 */
  cap?: number;
  /** 求分用的 ScoringProfile(第3步 Codex High 6:与 handleRank 的 live/preview profile 同源,
   *  不让 scorer 退回闭包默认)。未传 → scorer 内部 DEFAULT_SCORING_PROFILE 兜底。 */
  profile?: ScoringProfile;
}
export interface VerifyDraftArgs {
  name: string;
  adapterPath: string;
  verifyArgs: Record<string, unknown>;
}
export interface PipelineDeps {
  scorer: Scorer;
  generator: Generator;
  /** 真实实现:be 调 daemon /v1/verify(带 adapterPath override)+ 轮询到终态;失败/超时 → null。 */
  verifyDraft: (args: VerifyDraftArgs) => Promise<VerifySummaryLike | null>;
  /** 可选:阶段计时日志(诊断"生成慢"卡在 score/generate/verify 哪一段)。 */
  log?: (stage: string, durationMs: number, detail?: string) => void;
  /** 可选:阶段**开始**信号(进入某阶段前调,让前端 progress 显示 running,idle-timeout 见活动不误判)。 */
  onPhaseStart?: (stage: string) => void;
  /** 可选:阶段性 prompt 就绪回调(score 阶段先出 score prompt;score 完、genCands 定后出 generate prompt),
   *  让分析过渡页按当前阶段实时展示对应提示词(不必等 pipeline 全跑完)。 */
  onPrompts?: (prompts: Partial<PipelinePrompts>) => void;
}

export interface PipelineDraft {
  candidateId: string;
  site: string;
  name: string;
  source: string;
  score: number;
  confidence: ScoredCandidate['confidence'];
  reason: string;
  risks: string[];
  notes: string[];
  staticOk: boolean;
  staticViolations: string[];
  verify: VerifyOutcome;
  /** 静态通过 + verify 达标 → 可展示/保存。 */
  usable: boolean;
  /** 拆步流程:0700 草稿文件路径(第三步单草稿 verify 用;仅静态通过+落盘的草稿有)。 */
  filePath?: string;
  /** 拆步流程:该草稿 verify 时传给 runner 的种子参数(来自 verifyExpectation)。 */
  verifyArgs?: Record<string, unknown>;
  /** 拆步流程:verify 达标判定所需的期望(rows/fieldCount/allowedOrigins 等)。 */
  verifyExpectation?: GeneratedScript['verifyExpectation'];
}
export interface PipelinePrompts {
  /** 评分(score)阶段发给 LLM 的完整提示词文本。 */
  score: string;
  /** 生成脚本(generate)阶段发给 LLM 的完整提示词文本(无 generate 候选时为空串)。 */
  generate: string;
  /** 随提示词一并外发的页面截图张数(图片本身不在文本里,这里仅标注数量以示透明)。 */
  screenshotCount: number;
}
export interface PipelineResult {
  /** 0700 草稿目录(调用方用完 cleanupDraftDir);无脚本时为空串。 */
  draftDir: string;
  drafts: PipelineDraft[];
  rejected: Array<{ candidateId: string; reason: string }>;
  /** 透明展示:本轮实际发给 LLM 的提示词(score + generate)+ 截图张数。 */
  prompts: PipelinePrompts;
}

/** score 阶段产出:评分结果 + 选中生成的候选(genCands,已 merge 语义层)+ 被拒 + 提示词。 */
export interface ScoreStageResult {
  scored: NonNullable<Awaited<ReturnType<Scorer['score']>>>;
  /** decision==='generate' 且 merge 了 paramUnion/inferredFunction 的原始候选,供 generate 阶段用。 */
  genCands: RankCandidate[];
  rejected: Array<{ candidateId: string; reason: string }>;
  prompts: PipelinePrompts;
}

/** generate 阶段产出:草稿目录 + 草稿(verify 未跑,初始 usable=false,verify.reasons=['尚未测试'])。 */
export interface GenerateStageResult {
  draftDir: string;
  drafts: PipelineDraft[];
}

/**
 * score-only 阶段:评分 + 构建 score/generate 提示词 + 计算 genCands(选中生成的候选,merge 语义层)。
 * 不生成、不写盘、不 verify。拆步流程第一步用;失败(scorer 返回 null)→ null。
 */
export async function runScore(input: PipelineInput, deps: PipelineDeps): Promise<ScoreStageResult | null> {
  const log = deps.log ?? (() => {});
  const phaseStart = deps.onPhaseStart ?? (() => {});
  const emitPrompts = deps.onPrompts ?? (() => {});
  const t0 = Date.now();
  phaseStart('score');
  const scorePrompt = buildScorePrompt({ candidates: input.candidates, samples: input.samples, candidateIds: input.candidateIds, cap: input.cap });
  const screenshotCount = input.samples.filter((s) => !!s.screenshot).length;
  emitPrompts({ score: scorePrompt, screenshotCount });
  const scored = await deps.scorer.score(input);
  log('score', Date.now() - t0, `candidates=${input.candidates.length}`);
  if (!scored) return null;
  const rejected = scored.candidates
    .filter((c) => c.decision !== 'generate')
    .map((c) => ({ candidateId: c.candidateId, reason: c.confidence === 'rejected' ? (c.reason || 'rejected') : `${c.confidence} not auto-generated` }));

  // 选中 decision==='generate' 的候选(medium+),映射回原始 RankCandidate(带 endpoint/args)。
  // Bug 1(Codex P1):把 ScoredCandidate 的语义层(paramUnion 角色/暴露、inferredFunction 用途)
  // merge 回原始候选再喂生成器——聚拢候选的 seed/分页/查询维度知识只活在 paramObservations(事实)+
  // LLM 的 paramUnion(语义),不透传的话 Prompt B 只见 endpoint/args,会生成无参/错参 adapter。
  const genCands = scored.candidates
    .filter((c) => c.decision === 'generate')
    .map((c) => {
      const rc = input.candidates.find((rc) => rc.id === c.candidateId);
      if (!rc) return undefined;
      return {
        ...rc,
        ...(c.paramUnion ? { paramUnion: c.paramUnion } : {}),
        ...(c.inferredFunction ? { inferredFunction: c.inferredFunction } : {}),
      };
    })
    .filter((c): c is RankCandidate => !!c);

  const prompts: PipelinePrompts = {
    score: scorePrompt,
    generate: genCands.length ? buildGenPrompt({ candidates: genCands, samples: input.samples }) : '',
    screenshotCount,
  };
  if (genCands.length) emitPrompts({ generate: prompts.generate });

  return { scored, genCands, rejected, prompts };
}

/**
 * generate-only 阶段:对 genCands 生成脚本 + 逐个静态检查 + 写 0700 草稿。**不 verify、不 repair**
 * (verify 移到拆步流程第三步的单草稿端点)。每个草稿 verify 初始占位(usable=false,reasons=['尚未测试'])。
 * genCands 空 → 返回空草稿;generator 返回 null → null。
 */
export async function runGenerate(
  genCands: RankCandidate[],
  scored: ScoreStageResult['scored'],
  samples: SynthesisSample[],
  deps: PipelineDeps,
): Promise<GenerateStageResult | null> {
  const log = deps.log ?? (() => {});
  const phaseStart = deps.onPhaseStart ?? (() => {});
  const scoreById = new Map(scored.candidates.map((c) => [c.candidateId, c]));
  if (!genCands.length) return { draftDir: '', drafts: [] };

  const tGen = Date.now();
  phaseStart('generate');
  const gen = await deps.generator.generate({ candidates: genCands, samples });
  log('generate', Date.now() - tGen, `genCands=${genCands.length}`);
  if (!gen) return null;

  const draftDir = gen.scripts.length ? makeDraftDir() : '';
  const drafts: PipelineDraft[] = [];
  // 逐个静态白名单检查 + 写 0700 草稿。verify 不在此阶段跑(第三步单独触发)。
  gen.scripts.forEach((s) => {
    const sc = scoreById.get(s.candidateId);
    const base = {
      candidateId: s.candidateId, site: s.site, name: s.name, source: s.source,
      score: sc?.score ?? 0, confidence: sc?.confidence ?? 'low' as const, reason: sc?.reason ?? '',
      risks: s.risks, notes: s.notes,
    };
    const origins = s.verifyExpectation?.allowedOrigins ?? [];
    const check = staticCheckScript(s.source, origins);
    if (!check.ok) {
      drafts.push({ ...base, staticOk: false, staticViolations: check.violations, verify: { ok: false, rows: 0, fieldCount: 0, reasons: ['静态检查未通过'] }, usable: false });
      return;
    }
    const file = writeDrafts(draftDir, [{ site: s.site, name: s.name, source: s.source }])[0];
    if (!file) {
      drafts.push({ ...base, staticOk: true, staticViolations: [], verify: { ok: false, rows: 0, fieldCount: 0, reasons: ['草稿写入失败'] }, usable: false });
      return;
    }
    // 静态通过、已落盘:verify 待第三步单独触发。verifyArgs/expectation 存入草稿供后续 verify 复用。
    drafts.push({
      ...base, staticOk: true, staticViolations: [],
      verify: { ok: false, rows: 0, fieldCount: 0, reasons: ['尚未测试'] }, usable: false,
      filePath: file.path,
      verifyArgs: s.verifyExpectation?.verifyArgs ?? {},
      verifyExpectation: s.verifyExpectation,
    });
  });
  // 排序:静态通过优先,再按分降序(verify 未跑,不参与排序)。
  drafts.sort((a, b) => (b.staticOk ? 1 : 0) - (a.staticOk ? 1 : 0) || b.score - a.score);
  return { draftDir, drafts };
}

export async function runPipeline(input: PipelineInput, deps: PipelineDeps): Promise<PipelineResult | null> {
  const log = deps.log ?? (() => {});
  const phaseStart = deps.onPhaseStart ?? (() => {});
  const emitPrompts = deps.onPrompts ?? (() => {});
  const t0 = Date.now();
  // score 阶段:先标 running,并把 score prompt 立即回调(分析过渡页在评分阶段就能看到评分提示词)。
  phaseStart('score');
  const scorePrompt = buildScorePrompt({ candidates: input.candidates, samples: input.samples, candidateIds: input.candidateIds, cap: input.cap });
  const screenshotCount = input.samples.filter((s) => !!s.screenshot).length;
  emitPrompts({ score: scorePrompt, screenshotCount });
  const scored = await deps.scorer.score(input);
  log('score', Date.now() - t0, `candidates=${input.candidates.length}`);
  if (!scored) return null;
  const scoreById = new Map(scored.candidates.map((c) => [c.candidateId, c]));
  const rejected = scored.candidates
    .filter((c) => c.decision !== 'generate')
    .map((c) => ({ candidateId: c.candidateId, reason: c.confidence === 'rejected' ? (c.reason || 'rejected') : `${c.confidence} not auto-generated` }));

  // 选中 decision==='generate' 的候选(medium+),映射回原始 RankCandidate(带 endpoint/args)。
  // Bug 1(Codex P1):把 ScoredCandidate 的语义层(paramUnion 角色/暴露、inferredFunction 用途)
  // merge 回原始候选再喂生成器——聚拢候选的 seed/分页/查询维度知识只活在 paramObservations(事实)+
  // LLM 的 paramUnion(语义),不透传的话 Prompt B 只见 endpoint/args,会生成无参/错参 adapter,
  // 让聚拢特性失效。LLM-off 路径 paramUnion/inferredFunction 为 undefined → 不覆盖,行为同旧。
  const genCands = scored.candidates
    .filter((c) => c.decision === 'generate')
    .map((c) => {
      const rc = input.candidates.find((rc) => rc.id === c.candidateId);
      if (!rc) return undefined;
      return {
        ...rc,
        ...(c.paramUnion ? { paramUnion: c.paramUnion } : {}),
        ...(c.inferredFunction ? { inferredFunction: c.inferredFunction } : {}),
      };
    })
    .filter((c): c is RankCandidate => !!c);

  // 透明展示:重建本轮实际发给 LLM 的提示词文本(score 用全部候选;generate 用筛后候选)。
  // 用与真实调用同一个纯 builder,确保展示的就是发出去的;截图仅标注张数(图片不进文本)。
  const prompts: PipelinePrompts = {
    score: scorePrompt,
    generate: genCands.length ? buildGenPrompt({ candidates: genCands, samples: input.samples }) : '',
    screenshotCount,
  };
  // generate prompt 就绪即回调(分析过渡页在生成阶段能看到脚本提示词,不必等 pipeline 全跑完)。
  if (genCands.length) emitPrompts({ generate: prompts.generate });

  if (!genCands.length) return { draftDir: '', drafts: [], rejected, prompts };

  const tGen = Date.now();
  phaseStart('generate');
  const gen = await deps.generator.generate({ candidates: genCands, samples: input.samples });
  log('generate', Date.now() - tGen, `genCands=${genCands.length}`);
  if (!gen) return null;

  const draftDir = gen.scripts.length ? makeDraftDir() : '';
  // candidateId → 原始候选(带 endpoint/paramUnion),供 verify-repair 用同一候选补样本重生成。
  const candById = new Map(genCands.map((c) => [c.id, c]));
  // Phase 1(同步、快):逐个静态白名单检查 + 写 0700 草稿。不通过/写失败的直接定稿,不进 verify。
  // Phase 2(受限并发):对静态通过且已落盘的草稿并发 verify —— daemon RunnerPort 本就内置并发队列
  //   (maxConcurrency slot + FIFO,clamp 到 CPU 数),be 串行发起是浪费;这里限并发 4,撞 queue_full 由
  //   daemon 排队、verifyDraft 轮询期间自然等待。保持产出顺序与原 gen.scripts 一致。
  // Phase 2.5(渐进披露):verify 失败且像「字段抽取」类失败(rows/fieldCount 不达标)→ 对该候选做**一次**
  //   repair-generate(补一小段原始 row 样本重生成)→ 重写草稿 → 再 verify 一次。generateRepair 缺省(旧
  //   Generator 无此方法)或无候选映射时跳过,行为同旧。
  type Pending = { idx: number; base: Omit<PipelineDraft, 'staticOk' | 'staticViolations' | 'verify' | 'usable'>; filePath: string; verifyArgs: Record<string, unknown>; expectation: GeneratedScript['verifyExpectation']; source: string };
  const out: (PipelineDraft | undefined)[] = new Array(gen.scripts.length);
  const pending: Pending[] = [];
  gen.scripts.forEach((s, idx) => {
    const sc = scoreById.get(s.candidateId);
    const base = {
      candidateId: s.candidateId, site: s.site, name: s.name, source: s.source,
      score: sc?.score ?? 0, confidence: sc?.confidence ?? 'low', reason: sc?.reason ?? '',
      risks: s.risks, notes: s.notes,
    };
    const origins = s.verifyExpectation?.allowedOrigins ?? [];
    const check = staticCheckScript(s.source, origins);
    if (!check.ok) {
      out[idx] = { ...base, staticOk: false, staticViolations: check.violations, verify: { ok: false, rows: 0, fieldCount: 0, reasons: ['静态检查未通过'] }, usable: false };
      return;
    }
    const file = writeDrafts(draftDir, [{ site: s.site, name: s.name, source: s.source }])[0];
    if (!file) {
      out[idx] = { ...base, staticOk: true, staticViolations: [], verify: { ok: false, rows: 0, fieldCount: 0, reasons: ['草稿写入失败'] }, usable: false };
      return;
    }
    pending.push({ idx, base, filePath: file.path, verifyArgs: s.verifyExpectation?.verifyArgs ?? {}, expectation: s.verifyExpectation, source: s.source });
  });

  // 受限并发跑 pending 的 verify(并发上限 4)。
  const CONCURRENCY = 4;
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      const p = pending[cursor++];
      if (!p) break;
      const tV = Date.now();
      const summary = await deps.verifyDraft({ name: `${p.base.site}/${p.base.name}`, adapterPath: p.filePath, verifyArgs: p.verifyArgs });
      log('verify', Date.now() - tV, `${p.base.site}/${p.base.name}`);
      let verify = meetsExpectation(summary, p.expectation);
      let source = p.base.source;
      // Phase 2.5:verify 失败且像字段抽取失败 → 一次 repair-generate + 重写草稿 + 再 verify。
      if (!verify.ok && deps.generator.generateRepair && isExtractionFailure(verify) && candById.has(p.base.candidateId)) {
        const tR = Date.now();
        const repaired = await deps.generator.generateRepair({
          candidate: candById.get(p.base.candidateId)!,
          samples: input.samples,
          failure: verify.reasons.join('; '),
          previousSource: p.source,
        });
        log('repair_generate', Date.now() - tR, `${p.base.site}/${p.base.name}`);
        if (repaired && repaired.source.trim()) {
          const origins = repaired.verifyExpectation?.allowedOrigins ?? p.expectation?.allowedOrigins ?? [];
          const check = staticCheckScript(repaired.source, origins);
          if (check.ok) {
            const rfile = writeDrafts(draftDir, [{ site: p.base.site, name: p.base.name, source: repaired.source }])[0];
            if (rfile) {
              const rArgs = repaired.verifyExpectation?.verifyArgs ?? p.verifyArgs;
              const rExp = repaired.verifyExpectation ?? p.expectation;
              const tV2 = Date.now();
              const summary2 = await deps.verifyDraft({ name: `${p.base.site}/${p.base.name}`, adapterPath: rfile.path, verifyArgs: rArgs });
              log('verify', Date.now() - tV2, `${p.base.site}/${p.base.name} (repair)`);
              const verify2 = meetsExpectation(summary2, rExp);
              // 采用修复后结果(即使仍失败,repair 的失败原因更贴近真实抽取问题;修复源码替换供用户查看)。
              verify = verify2;
              source = repaired.source;
            }
          }
        }
      }
      out[p.idx] = { ...p.base, source, staticOk: true, staticViolations: [], verify, usable: verify.ok };
    }
  }
  const tVerifyAll = Date.now();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  log('verify_all', Date.now() - tVerifyAll, `drafts=${pending.length} concurrency=${CONCURRENCY}`);

  const drafts: PipelineDraft[] = out.filter((d): d is PipelineDraft => !!d);
  // 排序:usable 优先,再按分降序
  drafts.sort((a, b) => (b.usable ? 1 : 0) - (a.usable ? 1 : 0) || b.score - a.score);
  return { draftDir, drafts, rejected, prompts };
}
