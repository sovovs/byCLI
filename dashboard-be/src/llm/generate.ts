// N2 · 多脚本生成(定稿 Prompt B)。为 N1 选中的高分候选各自生成**完整** byCLI adapter 源码(可多个)。
// 只产「数据」(source/metadata),不做静态检查/写盘(那是 sandbox-check + draft-store + N4 流程的事)。
//
// 第2步(prompt 压缩):generate 不再喂原始响应体 —— Cloudflare 120s 源站超时同因。改为
//   ① 每候选喂**详细结构 schema**(buildGenerateEvidenceSummary → responseSchema:wrappers/arrays/itemFields/
//      recommendedRowPath/recommendedColumns + 样本值);
//   ② **逐候选**各发一次 LLM 调用(非一个大 prompt 塞全部候选),每次只带一个候选的 endpoint+paramUnion+schema;
//   ③ 全局预算闸门 MAX_GENERATE_PROMPT_CHARS,超预算按信息价值从低到高逐级降级;
//   ④ verify-repair 重试才注入一小段原始样本(渐进披露,唯一让原始 JSON 进 prompt 的地方,见 generateRepair)。
import { type RankCandidate } from '@sovovs/bycli-recorder-core';
import {
  makeLlmClient,
  extractJson,
  buildGenerateEvidenceSummary,
  findRepresentativeRawBody,
  type GenerateEvidence,
  type LlmClient,
  type SynthesisSample,
} from './synthesize.js';
import { extractRowSample } from './responseSummary.js';

export type GenSample = SynthesisSample;
export interface GenerateInput {
  /** N1 选中(decision==='generate')的候选,带 endpoint/args/responseShape。 */
  candidates: RankCandidate[];
  samples: GenSample[];
}
export interface VerifyExpectation {
  commandName: string;
  verifyArgs: Record<string, unknown>;
  minRows: number;
  expectedFieldCount: number;
  allowedOrigins: string[];
  expectedStage: string;
}
export interface GeneratedScript {
  candidateId: string;
  site: string;
  name: string;
  description: string;
  access: 'read' | 'write';
  domain: string;
  strategy: 'PUBLIC' | 'COOKIE' | 'UI';
  browser: boolean;
  scriptKind: 'func' | 'pipeline';
  args: Array<Record<string, unknown>>;
  columns: string[];
  /** 完整 adapter 文件源码(经 sandbox-check 才可写盘/verify)。 */
  source: string;
  verifyExpectation?: VerifyExpectation;
  risks: string[];
  notes: string[];
}
export interface GenerateResult { scripts: GeneratedScript[]; skipped: Array<{ candidateId: string; reason: string }> }
/** verify-repair 输入:失败原因 + 上一版源码 + 候选/样本(内部注入原始 row 样本)。 */
export interface RepairInput {
  candidate: RankCandidate;
  samples: GenSample[];
  /** verify 失败原因(field-extraction-like),透传给生成器修抽取逻辑。 */
  failure: string;
  /** 上一版生成的源码(供生成器针对性修,而非从头写)。 */
  previousSource?: string;
}
export interface Generator {
  generate(input: GenerateInput): Promise<GenerateResult | null>;
  /** verify-repair:对单个候选补一小段原始样本重生成(渐进披露)。无 client → null。
   *  可选:旧注入/测试 fake 可不实现,pipeline 会在缺省时跳过 repair(行为同旧)。 */
  generateRepair?(input: RepairInput): Promise<GeneratedScript | null>;
}

const PROMPT_B = [
  '你是 byCLI adapter 生成器。你会收到**一个**已选中的高价值候选 endpoint、A/B 请求响应**结构摘要**、参数映射、',
  '用户 action 因果链、截图摘要、评分理由和风险。为该候选输出一个完整、可执行、只注册一个命令的',
  'byCLI JavaScript adapter 草稿。只输出一个原始 JSON 对象(不要 markdown)。代码放在字符串字段 source。',
  '',
  '生成优先级:① 默认 func 形式;② 仅 PUBLIC 无认证、线性 fetch/limit/map 时才可 pipeline;③ 任何 COOKIE/',
  'browser/分页/嵌套 wrapper/字段清洗/错误处理一律用 func。',
  '',
  '脚本契约:必须 import { cli, Strategy } from "@sovovs/bycli/registry";可选 import { ArgumentError,',
  'CommandExecutionError, EmptyResultError } from "@sovovs/bycli/errors"。**禁** import fs/path/process/',
  'child_process/vm/module/http/https,**禁** eval/Function/动态 import/读写文件/环境变量/shell。fetch 只访问候选',
  'endpoint 的 origin。access 默认 "read";site/name 仅字母数字下划线短横线;一个 source 只 cli({...}) 一次。',
  '',
  '📊 columns(业务价值最大化,别只取第一个嵌套对象的浅层字段):row 元素常由多个子对象组成(如',
  'content{title,id}、content_counter{view,like,collect,comment_count,hot_rank}、author{name}、author_counter{level})。',
  'columns 必须**跨所有子对象**捕捉这一行的业务价值 = 标识(content.title/content.content_id)+ 指标',
  '(content_counter.view/like/collect/comment_count/hot_rank 等计数/排名)+ 名称标签(author.name、author_counter.level)。',
  '以 responseSchema.recommendedColumns 为**主导选择**(它已做跨子对象均衡),但也要从 arrays[].itemFields 里',
  '主动补齐 recommendedColumns 可能漏掉的**指标/计数/作者**字段(view/like/collect/comment/rank/name/level…);',
  '**不要**只照搬排在最前那个子对象(通常是 content)的浅层键就收工,也别塞 format/brief/status/ctime/mtime 这类无业务价值的噪音字段。',
  'columns 里每个字段都必须是 row 元素真实存在的路径(依 itemFields 判定,别臆造)。',
  'args 来自 A/B 证明的 seed 参数/分页/安全 limit(动态签名参数不做成参数);',
  '若候选带 paramUnion,据它决定入参:paramRole=seed_argument/query_dimension 或 exposeAsArg=yes/optional_candidate → 暴露成命令 arg;',
  'paramRole=dynamic/infrastructure_constant/auth_session 或 exposeAsArg=no → 固定或省略,不做成参数;inferredFunction 即命令用途(写进 description)。',
  '若候选无 seed 参数(固定列表/排行榜),生成**无参命令**(args 可为空或仅含安全 limit),用观测到的固定参数直接返回该列表;',
  'limit 有上限(默认 10,最大≤100)。空结果抛 EmptyResultError;HTTP 非 2xx 抛 CommandExecutionError;参数非法抛 ArgumentError。',
  '',
  '🔑 用 responseSchema 写抽取逻辑(generate 阶段不喂原始响应体,只给结构摘要):',
  '- responseSchema.recommendedRowPath = 行数据数组所在路径(如 "data" / "data.items" / "$");据它 unwrap 到列表。',
  '- responseSchema.recommendedColumns = [{name,path,type}] 推荐列;responseSchema.arrays[].itemFields = 元素字段',
  '  [{path,type,sample}](sample 是截断样本值,仅供你判类型/形状,**别硬编码进代码**)。据此写 columns 与 row 映射。',
  '- responseSchema.wrappers = 顶层标量信封/分页字段(err_no/has_more/cursor…);判成功/分页用,不当数据行。',
  '- 找不到 recommendedRowPath 时按 items/data.items/data.list/data.results/results/list/records 兜底 unwrap,',
  '  仍找不到抛 EmptyResultError 不静默 return []。URL 字段用 new URL(rel,base).toString() 规范化。',
  '- 🔢 字段兜底值按 itemFields[].type 保持类型一致:number 型列缺失用数值兜底(0 或 null),string 型列用 "";',
  '  **别混用**(如 Number(x) 的列不要写 `== null ? "" : Number(x)` —— 数值列的空值应是 0/null,不是空串)。boolean 型用 false/null。',
  '',
  '策略:PUBLIC→browser:false,Node fetch;COOKIE→Strategy.COOKIE 通常 browser:true,浏览器上下文 page.evaluate',
  '同 origin fetch + credentials:"include";UI 尽量不用。分页:证据(urlParams/wrappers)有 page/offset/cursor 才生成对应逻辑,',
  '不猜证据外协议。',
  '',
  '输出 JSON: { "scripts":[ { "candidateId","site","name","description","access","domain",',
  '  "strategy":"PUBLIC|COOKIE|UI","browser":bool,"scriptKind":"func|pipeline","args":[{"name","type","required":bool,"help"}],',
  '  "columns":[...],"source":"完整文件源码","verifyExpectation":{"commandName":"site/name","verifyArgs":{占位/默认,不放真实密钥},',
  '  "minRows":int,"expectedFieldCount":int,"allowedOrigins":[...],"expectedStage":"execute"},"risks":[...],"notes":[...] } ],',
  '  "skipped":[{"candidateId","reason"}] }。source 必须是完整文件(不要只给 funcBody)。输入候选如下:',
].join('\n');

// ── prompt 全局预算闸门(第2步,与第1步 score 侧同构)──
// generate 逐候选各发一次,单份 prompt 硬上限 15KB。超预算按「信息价值从低到高」逐级降级:
//   (1)去 action selector →(2)actions 5→2 →(3)field paths 60→40 →(4)sample 值 30→12 →
//   (5)最后手段:裁 schema 字段,但**绝不动 recommendedRowPath/recommendedColumns**(写抽取代码的命脉)。
const MAX_GENERATE_PROMPT_CHARS = 15_000;
const GEN_DEGRADE_ACTIONS_CAP = 2;      // 步骤(2):actions 5→2
const GEN_DEGRADE_FIELD_PATHS = 40;     // 步骤(3):itemFields 60→40
const GEN_DEGRADE_SAMPLE_STR = 12;      // 步骤(4):sample 字符串 30→12
const GEN_DEGRADE_ITEMFIELDS_CAP = 12;  // 步骤(5)最后手段:每数组 itemFields 截到 12(保 recommendedColumns/RowPath)

/** 生成 prompt 降级动作日志。 */
export interface GenPromptStat {
  chars: number;
  candidateId: string;
  degraded: string[];
}

/** 单候选的 perCand 结构(喂 LLM 的形状)。 */
function buildPerCand(candidate: RankCandidate, evidence: GenerateEvidence[]): Record<string, unknown> {
  const c = candidate;
  return {
    candidateId: c.id,
    // 用途 + 参数语义角色(LLM score 阶段推断,聚拢候选的 seed/分页/查询维度知识只活在这里)。
    inferredFunction: c.inferredFunction,
    paramUnion: c.paramUnion?.map((p) => ({
      name: p.name,
      in: p.in,
      paramRole: p.paramRole,
      exposeAsArg: p.exposeAsArg,
      inferredMeaning: p.inferredMeaning,
    })),
    endpoint: {
      method: c.endpoint?.method,
      pathname: c.endpoint?.pathname,
      urlTemplate: c.endpoint?.urlTemplate,
      queryParams: c.endpoint?.queryParams,
      authRequired: c.endpoint?.authRequired,
    },
    args: c.args,
    responseShape: c.responseShape,
    evidence,
  };
}

function renderCandPrompt(perCand: Record<string, unknown>): string {
  return `${PROMPT_B}\n${JSON.stringify(perCand, null, 2)}`;
}

/**
 * 单候选 generate prompt + 预算闸门统计。逐级降级(信息价值从低到高)直到 < MAX_GENERATE_PROMPT_CHARS。
 * 绝不动 recommendedRowPath/recommendedColumns(写抽取代码的命脉)。
 */
export function buildGenPromptForCandidateWithStat(
  candidate: RankCandidate,
  samples: GenSample[],
): { prompt: string; stat: GenPromptStat } {
  const degraded: string[] = [];
  // 初始:满配 schema(field paths 60 / sample str 30)。
  let evidence = samples.map((s) => buildGenerateEvidenceSummary(s, candidate));
  let perCand = buildPerCand(candidate, evidence);
  let prompt = renderCandPrompt(perCand);
  const under = () => prompt.length <= MAX_GENERATE_PROMPT_CHARS;

  // (1) 去 action selector
  if (!under()) {
    for (const ev of evidence) ev.actions = ev.actions.map(({ selector: _s, ...rest }) => rest);
    degraded.push('drop_action_selectors');
    perCand = buildPerCand(candidate, evidence);
    prompt = renderCandPrompt(perCand);
  }
  // (2) actions 5→2
  if (!under()) {
    for (const ev of evidence) ev.actions = ev.actions.slice(-GEN_DEGRADE_ACTIONS_CAP);
    degraded.push(`actions_to_${GEN_DEGRADE_ACTIONS_CAP}`);
    perCand = buildPerCand(candidate, evidence);
    prompt = renderCandPrompt(perCand);
  }
  // (3) field paths 60→40(重建 schema)
  if (!under()) {
    evidence = samples.map((s) => buildGenerateEvidenceSummary(s, candidate, { schema: { maxFieldPaths: GEN_DEGRADE_FIELD_PATHS } }));
    // 重建 schema 后 actions 降级需重新施加(evidence 是新对象)。
    for (const ev of evidence) {
      ev.actions = ev.actions.map(({ selector: _s, ...rest }) => rest).slice(-GEN_DEGRADE_ACTIONS_CAP);
    }
    degraded.push(`field_paths_to_${GEN_DEGRADE_FIELD_PATHS}`);
    perCand = buildPerCand(candidate, evidence);
    prompt = renderCandPrompt(perCand);
  }
  // (4) sample 值 30→12
  if (!under()) {
    evidence = samples.map((s) => buildGenerateEvidenceSummary(s, candidate, { schema: { maxFieldPaths: GEN_DEGRADE_FIELD_PATHS, maxSampleStr: GEN_DEGRADE_SAMPLE_STR } }));
    for (const ev of evidence) {
      ev.actions = ev.actions.map(({ selector: _s, ...rest }) => rest).slice(-GEN_DEGRADE_ACTIONS_CAP);
    }
    degraded.push(`sample_str_to_${GEN_DEGRADE_SAMPLE_STR}`);
    perCand = buildPerCand(candidate, evidence);
    prompt = renderCandPrompt(perCand);
  }
  // (5) 最后手段:裁 schema 每数组 itemFields 到 12,但保 recommendedRowPath/recommendedColumns。
  if (!under()) {
    for (const ev of evidence) {
      if (ev.responseSchema?.arrays) {
        for (const arr of ev.responseSchema.arrays) {
          if (arr.itemFields.length > GEN_DEGRADE_ITEMFIELDS_CAP) arr.itemFields = arr.itemFields.slice(0, GEN_DEGRADE_ITEMFIELDS_CAP);
        }
      }
      // recommendedColumns 也可能超长,但它是命脉,只在极端时截到 ~20(仍保留)。
      if (ev.responseSchema?.recommendedColumns && ev.responseSchema.recommendedColumns.length > 20) {
        ev.responseSchema.recommendedColumns = ev.responseSchema.recommendedColumns.slice(0, 20);
      }
    }
    degraded.push(`itemfields_to_${GEN_DEGRADE_ITEMFIELDS_CAP}`);
    perCand = buildPerCand(candidate, evidence);
    prompt = renderCandPrompt(perCand);
  }

  return { prompt, stat: { chars: prompt.length, candidateId: candidate.id, degraded } };
}

/** 单候选 generate prompt(纯文本)。 */
export function buildGenPromptForCandidate(candidate: RankCandidate, samples: GenSample[]): string {
  return buildGenPromptForCandidateWithStat(candidate, samples).prompt;
}

/**
 * 展示/向后兼容:把逐候选 prompt 拼成一份文本(透明预览)。真实调用是逐候选各发一次(见 createGenerator),
 * 这里只是把每个候选的 prompt 顺序拼接,让前端看到「实际会发什么」。
 */
export function buildGenPrompt(input: GenerateInput): string {
  return input.candidates.map((c) => buildGenPromptForCandidate(c, input.samples)).join('\n\n─── 下一候选 ───\n\n');
}

/** verify-repair prompt:单候选 prompt + 一小段原始 row 样本(渐进披露)+ 失败原因 + 上一版源码。 */
export function buildRepairPrompt(input: RepairInput): string {
  const base = buildGenPromptForCandidate(input.candidate, input.samples);
  const rawBody = findRepresentativeRawBody(input.samples, input.candidate);
  // recommendedRowPath 从 schema 摘要拿(重建一次代价小);无则整体 rowPath 兜底。
  const ev = buildGenerateEvidenceSummary(input.samples[0] ?? { sampleName: 'A', entries: [] }, input.candidate);
  const rowPath = ev.responseSchema?.recommendedRowPath ?? ev.responseSchema?.rowPath;
  const rawSample = rawBody ? extractRowSample(rawBody, rowPath, 1200) : null;
  return [
    base,
    '',
    '─── verify 失败,针对性修复(仅本次附一小段真实样本)───',
    `上一版脚本 verify 未达标,原因:${input.failure}`,
    ...(input.previousSource ? ['上一版源码(请针对性修抽取逻辑,不要从头重写无关部分):', input.previousSource] : []),
    ...(rawSample
      ? [
          `以下是 recommendedRowPath(${rowPath ?? '?'})下**首个元素**的真实 JSON 样本(仅供核对字段路径/类型,别硬编码值):`,
          rawSample,
        ]
      : ['(无法提取原始样本,请依据 responseSchema 更保守地 unwrap/映射字段)']),
    '重新输出同样结构的 JSON(scripts[0] 为修复后的完整脚本)。',
  ].join('\n');
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** 解析一条 LLM 返回的 script 原始对象为 GeneratedScript(过滤缺 source/site/name)。 */
function parseScript(s: Record<string, unknown>): GeneratedScript | null {
  if (!str(s.source).trim() || !str(s.site) || !str(s.name)) return null;
  const ve = s.verifyExpectation as Record<string, unknown> | undefined;
  return {
    candidateId: str(s.candidateId),
    site: str(s.site),
    name: str(s.name),
    description: str(s.description),
    access: s.access === 'write' ? 'write' : 'read',
    domain: str(s.domain),
    strategy: s.strategy === 'COOKIE' || s.strategy === 'UI' ? s.strategy : 'PUBLIC',
    browser: s.browser === true,
    scriptKind: s.scriptKind === 'pipeline' ? 'pipeline' : 'func',
    args: Array.isArray(s.args) ? (s.args as Array<Record<string, unknown>>) : [],
    columns: strArr(s.columns),
    source: str(s.source),
    verifyExpectation: ve
      ? {
          commandName: str(ve.commandName, `${str(s.site)}/${str(s.name)}`),
          verifyArgs: (ve.verifyArgs && typeof ve.verifyArgs === 'object' ? ve.verifyArgs : {}) as Record<string, unknown>,
          minRows: typeof ve.minRows === 'number' ? ve.minRows : 1,
          expectedFieldCount: typeof ve.expectedFieldCount === 'number' ? ve.expectedFieldCount : 0,
          allowedOrigins: strArr(ve.allowedOrigins),
          expectedStage: str(ve.expectedStage, 'execute'),
        }
      : undefined,
    risks: strArr(s.risks),
    notes: strArr(s.notes),
  };
}

export function createGenerator(opts: { apiKey?: string; baseURL?: string; model: string; client?: LlmClient; timeoutMs?: number; onError?: (err: unknown) => void }): Generator {
  const client = makeLlmClient(opts);

  /** 单次 LLM 调用(带截图),返回原始文本;失败抛。 */
  async function callLlm(promptText: string, samples: GenSample[]): Promise<string> {
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: promptText }];
    for (const s of samples) {
      if (s.screenshot) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.screenshot } });
    }
    const res = await client!.messages.create({ model: opts.model, max_tokens: 12000, messages: [{ role: 'user', content }] });
    return res.content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  }

  return {
    async generate(input) {
      if (!client) return null;
      const scripts: GeneratedScript[] = [];
      const skipped: Array<{ candidateId: string; reason: string }> = [];
      let anyParsed = false; // 至少一个候选拿到可解析 JSON 响应(区分「全失败」与「模型主动 skip」)。
      // 逐候选各发一次 LLM 调用(非一个大 prompt 塞全部候选)。任一候选失败不拖垮其它候选。
      for (const candidate of input.candidates) {
        try {
          const { prompt, stat } = buildGenPromptForCandidateWithStat(candidate, input.samples);
          if (stat.degraded.length) opts.onError?.({ kind: 'generate_prompt_degraded', ...stat });
          const text = await callLlm(prompt, input.samples);
          const json = extractJson(text);
          if (!json) { skipped.push({ candidateId: candidate.id, reason: 'no_json' }); continue; }
          const parsed = JSON.parse(json) as { scripts?: Array<Record<string, unknown>>; skipped?: Array<Record<string, unknown>> };
          anyParsed = true;
          const rawScripts = Array.isArray(parsed.scripts) ? parsed.scripts : [];
          for (const s of rawScripts) {
            const ps = parseScript(s);
            if (ps) scripts.push(ps);
          }
          if (Array.isArray(parsed.skipped)) {
            for (const x of parsed.skipped) skipped.push({ candidateId: str(x.candidateId, candidate.id), reason: str(x.reason) });
          }
        } catch (e) {
          // 单候选失败:记 skip,不 return null(其它候选仍可产出)。
          opts.onError?.(e);
          skipped.push({ candidateId: candidate.id, reason: 'generate_error' });
        }
      }
      // 没有任何候选拿到可解析响应 → 整体失败(保持 null 契约,调用方退回)。至少一个解析成功即返回结果
      // (scripts 可能为空——模型主动 skip 全部候选也算成功路径)。
      if (!anyParsed) return null;
      return { scripts, skipped };
    },

    async generateRepair(input) {
      if (!client) return null;
      try {
        const text = await callLlm(buildRepairPrompt(input), input.samples);
        const json = extractJson(text);
        if (!json) return null;
        const parsed = JSON.parse(json) as { scripts?: Array<Record<string, unknown>> };
        const rawScripts = Array.isArray(parsed.scripts) ? parsed.scripts : [];
        for (const s of rawScripts) {
          const ps = parseScript(s);
          if (ps) return ps; // 取首个有效脚本
        }
        return null;
      } catch (e) {
        opts.onError?.(e);
        return null;
      }
    },
  };
}
