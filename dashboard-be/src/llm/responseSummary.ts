// 响应体「结构摘要」构建器(prompt 压缩,第1步 · score 侧)。
//
// 根因(真机实测):score 阶段旧证据把每个候选的原始 responseBody(单条 ~2600 字符 × 每样本 3 条 × 5 候选)
// 直接塞进 prompt,实测 98KB / ~25000 token,53% 是响应体。第三方网关(api.ikuncode.cc)有 Cloudflare
// 120s 源站超时,巨 prompt 让 gpt-5.5 超 120s → 524 → scorer 回 null → 退回规则分(用户看到低分、无
// inferredFunction)。Codex 裁决:score 侧**不再喂原始响应体**,改喂**结构摘要**(键/形状,不含样本值)。
//
// 本文件是纯函数(无 IO、无依赖),便于单测。
//
// 第2步(generate 侧):同一函数扩出 'generate' 模式,产**更详细**的结构 schema(带样本值 + itemFields +
// recommendedColumns,目标 ≤2500 字符),供生成器直接写 func/columns 抽取逻辑。generate 不再喂原始响应体
// (Cloudflare 120s 源站超时同因),仅在 verify-repair 重试时注入一小段原始样本(≤1200 字符,唯一例外)。

/** 样本值(generate 模式):字符串截断、number/bool 原样、object/array 不内联(故可选)。 */
export type SampleValue = string | number | boolean | null;
/** generate 模式行元素/数组元素的字段 schema 条目。 */
export interface FieldSchema {
  path: string;
  type: string;
  /** 标量样本值(string 截断 ~30、number/bool 原样);object/array 不内联时缺省。 */
  sample?: SampleValue;
}

/**
 * bounded-union 合并模式的字段 schema(buildMergedResponseSummary 产出)。
 * 在 FieldSchema 之上带跨调用的类型并集 + 覆盖率元数据:
 * - `type` = **类型并集**(多类型时 `number|string`),供生成器判「这列跨调用类型不一致」;
 * - `primaryType` = 出现最频繁的类型(平票偏 'string'),recommendedColumns 用它作单一类型;
 * - `occurrence` = 有几个已采样(且属 winner rowPath)的响应体带这个路径;
 * - `total` = 成功解析的响应体总数;`occurrenceRate` = occurrence/total(覆盖率过滤用)。
 */
export interface MergedFieldSchema extends FieldSchema {
  primaryType?: string;
  types?: string[];
  occurrence?: number;
  total?: number;
  occurrenceRate?: number;
}

/**
 * 响应结构摘要。
 * - score 模式:目标 ≤800 字符/候选,只判「是不是数据命令」,**不含样本值**(topKeys/rowPath/rowKeys)。
 * - generate 模式:目标 ≤2500 字符,更详细(带样本值 + itemFields + recommendedColumns),供生成器直接写
 *   func/columns 抽取逻辑(wrappers/arrays/recommendedRowPath/recommendedColumns)。
 */
export interface ResponseSummary {
  /** 解析失败标记(仅失败分支出现);此时只带 textPrefix,绝不塞长文本。 */
  parse?: 'failed';
  /** HTTP 状态码(调用方注入,可选)。 */
  status?: number;
  /** 顶层数据形态。 */
  kind?: 'array' | 'object' | 'scalar' | 'html' | 'unknown';
  /** 顶层键(object → 自身键;array → 首元素 union 键)。 */
  topKeys?: string[];
  /** 各数组路径 + 长度(帮助 LLM 定位列表数据在哪)。 */
  arrayPaths?: Array<{ path: string; count: number }>;
  /** 选中的「行数据」数组路径(业务字段最丰富的那个 array)。 */
  rowPath?: string;
  /** 行元素的点分字段路径(深度 ≤3,上限 ~20 条)。score 模式专用。 */
  rowKeys?: string[];
  /** 看起来像真实业务数据的字段名(best-effort,可选)。 */
  businessFieldHints?: string[];
  /** 解析失败时的原始文本前缀(≤160 字符)。 */
  textPrefix?: string;
  /** 是否被截断(解析失败分支恒 true;修复分支也置 true)。 */
  truncated?: boolean;
  /** JSON 被上游截断后由 repairTruncatedJsonPrefix 修复(补齐闭合括号、丢弃半截尾元素)得到的结构。 */
  repaired?: true;

  // ── generate 模式专用(score 模式不填)──
  /** 顶层标量 wrapper 字段 + 样本值(信封/分页字段识别,如 err_no/has_more/cursor)。 */
  wrappers?: FieldSchema[];
  /** 各数组路径 + 长度 + 元素字段 schema(path/type/sample)。 */
  arrays?: Array<{ path: string; count: number; itemFields: FieldSchema[] }>;
  /** 推荐的行数据数组路径(= rowPath,generate 语义命名)。 */
  recommendedRowPath?: string;
  /** 推荐列(name/path/type),供生成器直接写 columns。 */
  recommendedColumns?: Array<{ name: string; path: string; type: string }>;

  // ── merged 模式专用(buildMergedResponseSummary,bounded-union)──
  /** 采样并合并的响应体条数(总采样，含解析失败的)。 */
  mergedBodyCount?: number;
  /** 成功解析的响应体条数(rowPath 投票 / 覆盖率的分母)。 */
  parsedBodyCount?: number;
  /** rowPath 投票命中率(winnerVotes / parsedBodyCount)。 */
  rowPathWinnerRate?: number;
  /** 多个 rowPath 都带业务字段且 winnerRate < 0.6:winner 只用于合并,其余数组不并入 recommendedColumns。 */
  mixedRowPath?: boolean;
  /** 需人工复核(mixedRowPath 等低置信情形置真)。 */
  reviewRequired?: boolean;
}

// 行字段点分路径的展开深度(score 侧保持浅,省 token)。
const ROW_KEY_MAX_DEPTH = 3;
// 数组路径「发现」深度(仅定位 list 在哪,不展开字段):比 ROW_KEY_MAX_DEPTH 深,
// 覆盖 GraphQL 类深嵌套(data.viewer.repositories.nodes = 深度 4)。字段展开仍受
// ROW_KEY_MAX_DEPTH(score)/ GEN_MAX_DEPTH(generate)限制,故加深发现不放大 token。
const ARRAY_PATH_MAX_DEPTH = 6;
// 行字段上限(超出截断)。
const MAX_ROW_KEYS = 20;
// 顶层键上限。
const MAX_TOP_KEYS = 20;
// 解析失败时保留的文本前缀长度。
const PARSE_FAIL_PREFIX_LEN = 160;
// 分析 array 时看前几个元素(不止首个 —— 首元素可能字段缺失)。
const ARRAY_SAMPLE_ELEMENTS = 3;

// ── 截断 JSON 修复(fix B)──
// 超过此长度不做修复(避免超大输入上做 O(n) 扫描 + 多次 parse 放大成本)。
const REPAIR_MAX_INPUT = 512 * 1024;
// 从最靠后的安全切点开始最多回退尝试几次(有界重试,防止巨输入上无界扫描-重解析)。
const REPAIR_MAX_ATTEMPTS = 8;

// ── generate 模式:更详细(带样本值),目标 ≤2500 字符 ──
const GEN_MAX_DEPTH = 5;            // 字段展开深度(比 score 深:3 → 5)
const GEN_MAX_FIELD_PATHS = 60;     // 字段路径总上限(可被 budget gate 降到 40)
const GEN_MAX_SAMPLE_STR_LEN = 30;  // 字符串样本值截断(可被 budget gate 降到 12)
const GEN_MAX_ARRAYS = 8;           // 列出的数组路径上限
const GEN_MAX_WRAPPERS = 20;        // 顶层标量 wrapper 字段上限
const GEN_MAX_COLUMNS = 40;         // 推荐列上限
// 每个「子对象」(行元素的一级嵌套 object,如 content/content_counter/author)最多贡献几列。
// 目的:避免 recommendedColumns 被排在最前的单个子对象(通常是 content)全占,
// 保证指标(content_counter.*)+ 作者(author.*)+ 主体(content.*)都能被推荐到。
// 仅当行元素存在**多个**子对象分组时才生效;扁平行(单分组)不受限。
const PER_SUBOBJECT_COLUMN_CAP = 4;

// ── merged 模式(bounded-union across an endpoint group's calls)──
// core 已按 (method+host+pathname) 把一个候选聚成 endpoint group,组内多次调用(type=hot vs new、
// 不同 category_id/sort…)返回**互补**的字段:单一代表响应体会漏掉只在别的调用出现的字段。
// bounded-union 在少数几个采样体上合并字段并集 + 覆盖率投票,让 columns 覆盖 endpoint 全字段,但**有界**
// (绝不遍历所有调用)。
const MERGE_MAX_BODIES = 6;            // 参与合并的采样体硬上限(有界)
const MERGE_MAX_BODIES_PER_SAMPLE = 3; // 单个 query-param 签名最多取几条(去重:同参重复只留首条)——实为「每签名」上限
const MERGE_WINNER_RATE = 0.6;         // rowPath 投票命中率阈值:≥ 用 winner;< 且多 rowPath 带业务字段 → mixedRowPath
const MERGE_LOW_COVERAGE_RATE = 0.5;   // total>2 时字段进 columns 的最低覆盖率
const MERGE_HIGH_VALUE_COVERAGE_RATE = 0.33; // 高业务价值字段的放宽覆盖率下限
const MERGE_HIGH_VALUE_LOW_COVERAGE_CAP = 5; // 低覆盖率高价值字段的补入上限
const MERGE_MAX_ITEM_FIELDS = 80;      // 合并后 itemFields 上限(MAX_ITEM_FIELDS_GENERATE)
const MERGE_MAX_ROW_KEYS_SCORE = 30;   // score 模式合并后 rowKeys 上限
const MERGE_MAX_CHARS = 3200;          // 合并摘要字符预算(超出按降级顺序收窄)
const GEN_DEGRADE_MERGE_SAMPLE = 12;   // 预算收窄:sample 字符串 30→12

// 噪音黑名单:叶子字段名命中即**永不**进 recommendedColumns(即使 100% 覆盖);仍可留在 itemFields/wrappers。
// 诊断/埋点/实验位/信封错误码/原始扩展字段等——对数据表无业务价值。
const NOISE_LEAF_RE = /^(debug|trace|log|error|err_msg|err_no|errno|stack|exception|request_id|req_id|abtest|experiment|gray|test|raw|extra)$/i;

// 业务字段启发式:名字看起来像真实数据(非 err_no/status 这类信封字段)。
const BUSINESS_FIELD_RE = /^(title|name|url|link|href|id|content|text|desc|description|summary|brief|author|user|nick|view|read|like|star|collect|favorite|comment|reply|count|num|total|rank|hot|score|price|amount|time|date|created|updated|publish|cover|avatar|image|img|thumb|tag|category|label|status_name)$/i;

// 业务价值权重启发式(用于 generate 模式 recommendedColumns 排序/取舍):按字段名**子串**命中
// (非全词锚定 —— 锚定会漏掉 content_id/comment_count/hot_rank/interact_count/author_id 这类复合名)。
// 高价值:标识标签(title/name)+ 指标(view/like/collect/comment/count/rank/hot/total/price/amount…);
// 中价值:标识符(id/url/level/power/follower/score/category/tag);
// 低价值:时间/布尔/封面/格式/信封类(time/created/format/brief/status/is_/has_/avatar/image…)显式压低。
const HIGH_VALUE_RE = /(title|name|nick|view|read|like|star|collect|favorite|comment|reply|share|hot|rank|count|total|price|amount)/i;
const MED_VALUE_RE = /(_id\b|\bid\b|url|link|href|level|power|follow|score|num|category|tag|label|author|user)/i;
const LOW_VALUE_RE = /(time|date|created|updated|publish|ctime|mtime|cover|avatar|image|img|thumb|format|brief|desc|summary|status|^is_|^has_)/i;

/** 字段业务价值权重:high=3 / med=2 / neutral=1 / low=0(low 优先级最低,用于压掉 format/status/ctime 等噪音)。 */
function businessWeight(name: string): number {
  if (HIGH_VALUE_RE.test(name)) return 3;
  if (MED_VALUE_RE.test(name)) return 2;
  if (LOW_VALUE_RE.test(name)) return 0;
  return 1;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** array 前 N 个 object 元素的 union 键(保序:首现顺序)。 */
function unionKeysOfArray(arr: unknown[]): string[] {
  const seen = new Set<string>();
  for (const el of arr.slice(0, ARRAY_SAMPLE_ELEMENTS)) {
    if (isPlainObject(el)) for (const k of Object.keys(el)) seen.add(k);
  }
  return [...seen];
}

/** 收集所有数组路径 + 长度(遍历深度 ≤ ARRAY_PATH_MAX_DEPTH,覆盖深嵌套 GraphQL;仅定位不展开字段)。 */
function collectArrayPaths(node: unknown, path: string, depth: number, out: Array<{ path: string; count: number }>): void {
  if (depth > ARRAY_PATH_MAX_DEPTH) return;
  if (Array.isArray(node)) {
    out.push({ path: path || '$', count: node.length });
    // 数组元素里也可能嵌套数组(取首个 object 元素往下看)。
    const first = node.find((x) => isPlainObject(x) || Array.isArray(x));
    if (first !== undefined) collectArrayPaths(first, path ? `${path}[]` : '$[]', depth + 1, out);
    return;
  }
  if (isPlainObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (Array.isArray(v) || isPlainObject(v)) {
        collectArrayPaths(v, path ? `${path}.${k}` : k, depth + 1, out);
      }
    }
  }
}

/** 取某路径对应的数组元素首个 object(用于 rowKeys / 业务字段丰富度评估)。 */
function resolveArrayFirstObject(root: unknown, path: string): Record<string, unknown> | null {
  if (path === '$' || path === '') {
    if (Array.isArray(root)) return (root.find((x) => isPlainObject(x)) as Record<string, unknown>) ?? null;
    return null;
  }
  const segs = path.split('.');
  let cur: unknown = root;
  for (const seg of segs) {
    if (isPlainObject(cur)) cur = cur[seg];
    else return null;
  }
  if (Array.isArray(cur)) return (cur.find((x) => isPlainObject(x)) as Record<string, unknown>) ?? null;
  return null;
}

/** 点分展开一个 object 的字段路径(深度 ≤ maxDepth),嵌套对象递归、数组以 `[]` 收尾不再往下。 */
function dottedKeys(obj: Record<string, unknown>, prefix: string, depth: number, maxDepth: number, out: string[]): void {
  if (out.length >= MAX_ROW_KEYS) return;
  for (const [k, v] of Object.entries(obj)) {
    if (out.length >= MAX_ROW_KEYS) return;
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v) && depth < maxDepth) {
      dottedKeys(v, key, depth + 1, maxDepth, out);
    } else if (Array.isArray(v)) {
      out.push(`${key}[]`);
    } else {
      out.push(key);
    }
  }
}

/** 业务字段丰富度:一个行元素里命中 BUSINESS_FIELD_RE 的(浅层)键数量。 */
function businessScore(obj: Record<string, unknown>): number {
  let n = 0;
  const walk = (o: Record<string, unknown>, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (BUSINESS_FIELD_RE.test(k)) n += 1;
      if (isPlainObject(v) && depth < 2) walk(v, depth + 1);
    }
  };
  walk(obj, 0);
  return n;
}

// rowPath 偏好:业务字段丰富度相同时,优先这些常见列表路径名。
const PREFERRED_ROW_PATHS = ['data', 'data.items', 'results', 'list', 'data.list', 'data.data', 'items', 'records'];

function pickRowPath(root: unknown, arrayPaths: Array<{ path: string; count: number }>): string | undefined {
  if (!arrayPaths.length) return undefined;
  let best: { path: string; score: number; preferred: number; count: number } | null = null;
  for (const { path, count } of arrayPaths) {
    const firstObj = resolveArrayFirstObject(root, path);
    if (!firstObj) continue; // 只考虑「元素是 object」的数组(scalar 数组不是行数据)
    const score = businessScore(firstObj);
    const preferred = PREFERRED_ROW_PATHS.includes(path) ? 1 : 0;
    if (
      !best ||
      score > best.score ||
      (score === best.score && preferred > best.preferred) ||
      (score === best.score && preferred === best.preferred && count > best.count)
    ) {
      best = { path, score, preferred, count };
    }
  }
  return best?.path;
}

// ── generate 模式 helpers ──

/** 标量类型标签(供 FieldSchema.type)。 */
function scalarType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // string/number/boolean/object
}

/** 标量样本值:string 截断 ~maxStr、number/bool/null 原样;object/array → undefined(不内联)。 */
function sampleOf(v: unknown, maxStr: number): SampleValue | undefined {
  if (typeof v === 'string') return v.length > maxStr ? v.slice(0, maxStr) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  return undefined; // object/array 不内联样本值
}

/**
 * 点分展开一个 object 的字段 schema(path/type/sample),深度 ≤ maxDepth。
 * 嵌套 object 递归;数组以 `[]` 收尾,取首个 object 元素继续往下(暴露列表元素字段)。
 */
function dottedFields(
  obj: Record<string, unknown>,
  prefix: string,
  depth: number,
  maxDepth: number,
  maxStr: number,
  out: FieldSchema[],
  cap: number,
): void {
  if (out.length >= cap) return;
  for (const [k, v] of Object.entries(obj)) {
    if (out.length >= cap) return;
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v) && depth < maxDepth) {
      dottedFields(v, key, depth + 1, maxDepth, maxStr, out, cap);
    } else if (Array.isArray(v)) {
      out.push({ path: `${key}[]`, type: 'array' });
      const firstObj = v.find((x) => isPlainObject(x)) as Record<string, unknown> | undefined;
      if (firstObj && depth < maxDepth) dottedFields(firstObj, `${key}[]`, depth + 1, maxDepth, maxStr, out, cap);
    } else {
      const s = sampleOf(v, maxStr);
      out.push({ path: key, type: scalarType(v), ...(s !== undefined ? { sample: s } : {}) });
    }
  }
}

/** 行元素字段的「子对象分组」名(点分路径首段;无点=顶层扁平字段,归入 '' 分组)。 */
function subObjectGroup(path: string): string {
  const dot = path.indexOf('.');
  return dot === -1 ? '' : path.slice(0, dot);
}

/**
 * 收集「行数组的同级标量字段」= 分页/信封元数据(total/cursor/has_more/page/count/next…)。
 *
 * 根因(Bug A):`wrappers` 只收**顶层**标量。当 rowPath 是 `X.items`(数组嵌在某个 wrapper 对象 X 下,
 * 与之并列的标量如 data.total/data.cursor/data.has_more 是分页元数据)时,这些同级标量既不在顶层、也不在
 * 行元素内 → 旧逻辑整个丢掉。行列来自数组**元素内部**,不会把同级标量误当列(已验证不泄漏),所以这里只需
 * 把它们**捕获进 wrappers**(带点分父路径,如 `data.total`),让生成器识别分页字段。
 *
 * rowPath='$'(顶层数组)无父对象 → 无同级;rowPath='data'(数组直接在根下)其同级就是顶层标量,已被
 * 顶层 wrapper 收过 → 跳过避免重复。仅当 rowPath 含 `.`(嵌套数组)时收父对象里的标量同级。
 */
function collectPaginationSiblings(parsed: unknown, rowPath: string, maxStr: number): FieldSchema[] {
  const dot = rowPath.lastIndexOf('.');
  if (dot === -1) return []; // 顶层数组 / 根下数组:同级即顶层标量(已收)或无
  const parentPath = rowPath.slice(0, dot);
  const arrayKey = rowPath.slice(dot + 1);
  let cur: unknown = parsed;
  for (const seg of parentPath.split('.')) {
    if (isPlainObject(cur)) cur = cur[seg];
    else return [];
  }
  if (!isPlainObject(cur)) return [];
  const out: FieldSchema[] = [];
  for (const [k, v] of Object.entries(cur)) {
    if (k === arrayKey) continue; // 行数组本身
    if (isPlainObject(v) || Array.isArray(v)) continue; // 只收标量同级
    const s = sampleOf(v, maxStr);
    out.push({ path: `${parentPath}.${k}`, type: scalarType(v), ...(s !== undefined ? { sample: s } : {}) });
    if (out.length >= GEN_MAX_WRAPPERS) break;
  }
  return out;
}


/**
 * generate 模式 recommendedColumns 选择:业务价值排序 + 跨子对象均衡。
 *
 * 根因(真机 juejin article_rank):行元素是 {content:{...}, content_counter:{view,like}, author:{name}, …},
 * 旧逻辑按遍历序取前 40 个标量字段 → content.* 排最前且噪音多(format/brief/status/ctime/mtime),
 * 生成器抓完 content.* 的浅层字段就停了,漏掉指标(content_counter.view/like/collect)和作者(author.name)。
 *
 * 新逻辑:
 * 1) 按 businessWeight 给字段打分(title/name/指标=高,format/status/时间=低),排序时高价值优先;
 * 2) **跨子对象均衡**:行元素存在多个子对象分组时,每个分组(content / content_counter / author …)最多
 *    贡献 PER_SUBOBJECT_COLUMN_CAP 列,防止单个分组(content)独占推荐位,确保指标 + 作者 + 主体都被覆盖;
 * 3) recommendedColumns 是**精选指南**(不是全字段转储):per-group 上限后即定稿,不回填噪音;
 *    生成器仍可从 arrays[].itemFields(全字段)按需补列(PROMPT_B 已指示)。
 * 扁平行(单分组或全顶层字段)不受 per-group 限制,行为等同「按业务价值排序取前 N」。
 */
function selectRecommendedColumns(itemFields: FieldSchema[]): Array<{ name: string; path: string; type: string }> {
  const scalars = itemFields.filter((f) => f.type !== 'array');
  const toCol = (f: FieldSchema) => {
    const name = f.path.split('.').pop()!.replace(/\[\]$/, '');
    return { name, path: f.path, type: f.type, group: subObjectGroup(f.path), weight: businessWeight(name) };
  };
  const enriched = scalars.map(toCol);
  const groupCount = new Set(enriched.map((c) => c.group)).size;

  // 稳定排序:业务价值降序,权重相同保持原发现序(保留 schema 里字段的自然顺序)。
  const byWeight = enriched
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.weight - a.c.weight) || (a.i - b.i))
    .map((x) => x.c);

  const strip = (c: { name: string; path: string; type: string }) => ({ name: c.name, path: c.path, type: c.type });

  // 单分组(扁平行)→ 无需均衡,直接按业务价值取前 N。
  if (groupCount <= 1) return byWeight.slice(0, GEN_MAX_COLUMNS).map(strip);

  // 多分组:per-group 配额(高价值优先),保证跨子对象铺开且压掉单分组内的低价值噪音。
  // 精选定稿——不回填,把「按需补列」交给生成器读 itemFields(避免 recommendedColumns 退化成全字段转储)。
  const perGroup = new Map<string, number>();
  const picked: typeof byWeight = [];
  for (const c of byWeight) {
    if (picked.length >= GEN_MAX_COLUMNS) break;
    const used = perGroup.get(c.group) ?? 0;
    if (used >= PER_SUBOBJECT_COLUMN_CAP) continue;
    perGroup.set(c.group, used + 1);
    picked.push(c);
  }
  // Bug B 兜底:非英文/拼音字段全部 neutral/low 权重,排序不影响入选;但若未来加入语义门控导致
  // 入选为空,而确有标量行字段 → 退回「按发现序取前 N」,保证非英文 API 也拿得到列(绝不丢字段)。
  if (!picked.length && scalars.length) {
    return scalars.slice(0, GEN_MAX_COLUMNS).map((f) => ({ name: f.path.split('.').pop()!.replace(/\[\]$/, ''), path: f.path, type: f.type }));
  }
  return picked.map(strip);
}

/** generate 模式:把解析后的 JSON 压成**详细** schema(带样本值 + itemFields + recommendedColumns)。 */
function buildGenerateSummary(parsed: unknown, base: ResponseSummary, opts?: { maxFieldPaths?: number; maxSampleStr?: number }): ResponseSummary {
  const maxFieldPaths = opts?.maxFieldPaths ?? GEN_MAX_FIELD_PATHS;
  const maxStr = opts?.maxSampleStr ?? GEN_MAX_SAMPLE_STR_LEN;

  if (!isPlainObject(parsed) && !Array.isArray(parsed)) {
    return { ...base, kind: 'scalar' };
  }

  const kind: 'array' | 'object' = Array.isArray(parsed) ? 'array' : 'object';
  const topKeys = Array.isArray(parsed) ? unionKeysOfArray(parsed) : Object.keys(parsed);
  const summary: ResponseSummary = { ...base, kind, topKeys: topKeys.slice(0, MAX_TOP_KEYS) };

  // 顶层标量 wrapper(信封/分页字段:err_no/has_more/cursor…)。object 才有;array 顶层无 wrapper。
  if (isPlainObject(parsed)) {
    const wrappers: FieldSchema[] = [];
    for (const [k, v] of Object.entries(parsed)) {
      if (isPlainObject(v) || Array.isArray(v)) continue; // 非标量不算 wrapper
      const s = sampleOf(v, maxStr);
      wrappers.push({ path: k, type: scalarType(v), ...(s !== undefined ? { sample: s } : {}) });
      if (wrappers.length >= GEN_MAX_WRAPPERS) break;
    }
    if (wrappers.length) summary.wrappers = wrappers;
  }

  // 全部数组路径 + 长度。
  const arrayPaths: Array<{ path: string; count: number }> = [];
  collectArrayPaths(parsed, '', 0, arrayPaths);
  // 各数组的元素字段 schema(共享 maxFieldPaths 预算,优先靠前/推荐路径)。
  const rowPath = pickRowPath(parsed, arrayPaths);
  // 排序:推荐行路径优先,其余保持发现序;截断到 GEN_MAX_ARRAYS。
  const orderedPaths = [...arrayPaths].sort((a, b) => {
    if (a.path === rowPath) return -1;
    if (b.path === rowPath) return 1;
    return 0;
  }).slice(0, GEN_MAX_ARRAYS);
  const arrays: Array<{ path: string; count: number; itemFields: FieldSchema[] }> = [];
  let fieldBudget = maxFieldPaths;
  for (const { path, count } of orderedPaths) {
    const firstObj = resolveArrayFirstObject(parsed, path);
    if (!firstObj) {
      arrays.push({ path, count, itemFields: [] }); // scalar 数组:无元素字段
      continue;
    }
    const itemFields: FieldSchema[] = [];
    dottedFields(firstObj, '', 1, GEN_MAX_DEPTH, maxStr, itemFields, fieldBudget);
    fieldBudget = Math.max(0, fieldBudget - itemFields.length);
    arrays.push({ path, count, itemFields });
    if (fieldBudget <= 0) break;
  }
  if (arrays.length) summary.arrays = arrays;

  if (rowPath) {
    summary.rowPath = rowPath;
    summary.recommendedRowPath = rowPath;
    // Bug A:捕获行数组的同级标量(分页/信封元数据 total/cursor/has_more…)进 wrappers。
    // 行列只来自数组元素内部,故这些同级标量不会误入 recommendedColumns —— 仅作 wrapper 提示。
    const paginationSiblings = collectPaginationSiblings(parsed, rowPath, maxStr);
    if (paginationSiblings.length) {
      const existing = summary.wrappers ?? [];
      const seen = new Set(existing.map((w) => w.path));
      const merged = [...existing];
      for (const w of paginationSiblings) {
        if (seen.has(w.path)) continue;
        merged.push(w);
        if (merged.length >= GEN_MAX_WRAPPERS) break;
      }
      summary.wrappers = merged;
    }
    const rowArr = arrays.find((a) => a.path === rowPath);
    if (rowArr) {
      const cols = selectRecommendedColumns(rowArr.itemFields);
      if (cols.length) summary.recommendedColumns = cols;
      const hints = rowArr.itemFields
        .map((f) => f.path)
        .filter((p) => BUSINESS_FIELD_RE.test(p.split('.').pop()!.replace(/\[\]$/, '')));
      if (hints.length) summary.businessFieldHints = hints.slice(0, 8);
    }
  }
  return summary;
}

/**
 * 修复被上游截断的 JSON 前缀(fix B)。纯函数,无 IO。
 *
 * 根因:采集/传输侧常把 responseBody 从中间某处切断(半截字符串、半截元素),`JSON.parse` 直接抛 →
 * buildResponseSummary 退回 `{parse:'failed', textPrefix}`,LLM 拿不到 recommendedColumns/itemFields,
 * 生成的 CLI 只挑到浅层可见字段。本函数在退回前尝试把截断前缀补成可解析的 JSON,尽量保住已完整的元素。
 *
 * 算法(Codex spec):
 * - 逐字符扫描,维护 inString / escape / 容器栈(`{`→`}`、`[`→`]`)+ 每个容器的期望态(object:key/colon/
 *   value/comma;array:value/comma),用于区分「字符串是键还是值」「标量值是否读完」。
 * - **安全切点**定义 = 当前容器正处于「成员之间」的状态:①刚开一个容器(空容器可闭合,除非它是紧跟 `,` 的
 *   新元素——那样闭合会造出半截空元素,不记);②刚读完一个完整值(嵌套容器闭合 `}`/`]`、带分隔符收尾的
 *   标量、成对引号收尾的字符串值)。到 EOF 才结束的标量/字符串**不算**完整值(可能被截半),不记切点。
 * - 到输入末尾:取最靠后的安全切点,slice、去掉尾随空白/逗号,再按容器栈**逆序**补齐 `]`/`}`。
 * - `JSON.parse` 修复串;成功则返回。失败则回退到更早的安全切点重试(有界,最多 REPAIR_MAX_ATTEMPTS 次)。
 *   全失败或只能还原出空 `{}`/`[]`(等于啥也没救回来,应退回 textPrefix)→ 返回 null。
 *
 * 例:`{"data":[{"a":1},{"b":2},{"c":"half` → `{"data":[{"a":1},{"b":2}]}`(丢半截元素,闭合 array+object)。
 */
export function repairTruncatedJsonPrefix(raw: string): string | null {
  const s = raw ?? '';
  if (!s || s.length > REPAIR_MAX_INPUT) return null;
  // 只修复「截断的容器 JSON」:必须以 { 或 [ 起头(纯文本/HTML/标量交给 textPrefix 兜底)。
  let start = 0;
  while (start < s.length && (s[start] === ' ' || s[start] === '\n' || s[start] === '\t' || s[start] === '\r')) start++;
  const startCh = s[start];
  if (startCh !== '{' && startCh !== '[') return null;

  const isWs = (c: string | undefined) => c === ' ' || c === '\n' || c === '\t' || c === '\r';
  const stack: string[] = [];       // 待闭合字符('}'/']'),按开启先后自底向上
  const states: string[] = [];      // 与 stack 平行:object='key'|'colon'|'value'|'comma';array='value'|'comma'
  const cuts: Array<{ end: number; closers: string }> = []; // 只保留最近 REPAIR_MAX_ATTEMPTS 个(有界内存)
  let inString = false;
  let escape = false;
  let lastSig = '';                 // 最近一个有效(非空白)字符,用于判定「容器是否紧跟逗号打开」

  const recordCut = (endExclusive: number): void => {
    const closers = stack.slice().reverse().join('');
    cuts.push({ end: endExclusive, closers });
    if (cuts.length > REPAIR_MAX_ATTEMPTS) cuts.shift();
  };

  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i] as string; // i < n 保证有值
    if (inString) {
      if (escape) { escape = false; i++; continue; }
      if (c === '\\') { escape = true; i++; continue; }
      if (c === '"') {
        inString = false;
        const top = stack[stack.length - 1];
        const st = states[states.length - 1];
        if (top === '}') {
          if (st === 'key') states[states.length - 1] = 'colon';       // 键闭合:等冒号(非安全切点)
          else if (st === 'value') { states[states.length - 1] = 'comma'; recordCut(i + 1); } // 值闭合:安全
        } else if (top === ']') {
          states[states.length - 1] = 'comma'; recordCut(i + 1);        // 数组元素字符串值闭合:安全
        }
        i++; continue;
      }
      i++; continue;
    }
    if (isWs(c)) { i++; continue; }
    if (c === '"') { inString = true; escape = false; lastSig = c; i++; continue; }
    if (c === '{' || c === '[') {
      const openedAfterComma = lastSig === ',';
      stack.push(c === '{' ? '}' : ']');
      states.push(c === '{' ? 'key' : 'value');
      lastSig = c;
      if (!openedAfterComma) recordCut(i + 1); // 空容器可闭合;但紧跟逗号的新元素不记(避免造半截空元素)
      i++; continue;
    }
    if (c === '}' || c === ']') {
      stack.pop(); states.pop();
      if (states.length) states[states.length - 1] = 'comma'; // 闭合的容器是父级的一个完整值
      recordCut(i + 1);
      lastSig = c;
      i++; continue;
    }
    if (c === ':') { if (states[states.length - 1] === 'colon') states[states.length - 1] = 'value'; lastSig = c; i++; continue; }
    if (c === ',') {
      if (states[states.length - 1] === 'comma') states[states.length - 1] = (stack[stack.length - 1] === '}') ? 'key' : 'value';
      lastSig = c; i++; continue;
    }
    // 标量 token(number/true/false/null):扫到分隔符或 EOF。
    while (i < n) {
      const cc = s[i];
      if (cc === ',' || cc === '}' || cc === ']' || cc === ':' || cc === '"' || isWs(cc)) break;
      i++;
    }
    const atEof = i === n;
    if (states[states.length - 1] === 'value') {
      states[states.length - 1] = 'comma';
      if (!atEof) recordCut(i); // 有分隔符收尾 = 读完;到 EOF 则可能被截半,不记
    }
    lastSig = 'x';
  }

  // 从最靠后的安全切点起,有界回退尝试。
  for (let a = 0; a < cuts.length; a++) {
    const cut = cuts[cuts.length - 1 - a];
    if (!cut) continue;
    const head = s.slice(0, cut.end).replace(/[\s,]+$/, '');
    const candidate = head + cut.closers;
    try {
      const parsed = JSON.parse(candidate);
      // 只还原出空 {}/[] = 啥也没救回来 → 视为失败,退回 textPrefix 更诚实。
      const empty = (isPlainObject(parsed) && Object.keys(parsed).length === 0) || (Array.isArray(parsed) && parsed.length === 0);
      if (!empty) return candidate;
    } catch { /* 回退到更早的安全切点 */ }
  }
  return null;
}

// ── 结构感知响应预览(fix C · 采集侧,storeSample 前归一)──
// 根因(Codex 裁决):采集/传输把 responseBody 从中间某处按字符切断(半截字符串、半截元素)→ 存进
// session 的 responsePreview 是**非法 JSON 前缀** → buildResponseSummary 每次都得靠 fix B 修复
// (丢半截尾元素、shapeConfidence 降级)。fix C 是根因修:在 storeSample 前把要存的样本归一成一段
// **合法结构化 JSON 样本**(少量数组元素 + 短字符串 + 完整结构),而不是存全量(内存/隐私)也不存半截 JSON。
//
// 语义(Codex spec):
//  1) 非 JSON content-type(或不以 {/[ 起头)→ 文本前缀截断(旧行为),previewMode='text_prefix'。
//  2) body ≤ maxChars 且 JSON.parse 成功 → 原样存,previewMode='full'。
//  3) body > maxChars 但 ≤ jsonParseMaxBytes:parse **全量** body,再递归**剪枝**(数组保前 maxArrayItems
//     个 + 递归、对象保前 maxObjectKeys 键 + 递归、字符串截 maxStringLength、深度超 maxDepth 的 object→{}/
//     array→[]),再 stringify。若仍 > maxChars,按梯度降级(maxArrayItems 3→2→1 / maxStringLength
//     160→80→30 / maxObjectKeys 80→40→20),每步重算。previewMode='json_sample'。
//  4) 全量 parse 失败(已被截断的 legacy 输入)或 body > jsonParseMaxBytes → 文本前缀兜底,previewMode=
//     'text_prefix'(下游 fix B 的 repair 仍会尽力救回)。
//  5) responseBodyTruncated = 原 body.length > 存下的 preview.length || previewMode !== 'full'。
//
// 关键:剪枝保留 data[0..2] 的**完整结构**(所有嵌套 object 保全)—— 这正是 buildResponseSummary('generate')
// 拿到 article_rank 类形状全字段路径(content.title / content_counter.view / author.name)的前提。

export type PreviewMode = 'full' | 'json_sample' | 'text_prefix';

export interface StructureAwarePreviewInput {
  body: string;
  contentType?: string;
  maxChars?: number;         // 默认 32768
  maxArrayItems?: number;    // 默认 3
  maxDepth?: number;         // 默认 6
  maxObjectKeys?: number;    // 默认 80
  maxStringLength?: number;  // 默认 160
  jsonParseMaxBytes?: number;// 默认 2_000_000
}

export interface StructureAwarePreviewResult {
  responsePreview: string;
  responseBodyTruncated: boolean;
  previewMode: PreviewMode;
}

const SAP_MAX_CHARS = 32768;
const SAP_MAX_ARRAY_ITEMS = 3;
const SAP_MAX_DEPTH = 6;
const SAP_MAX_OBJECT_KEYS = 80;
const SAP_MAX_STRING_LENGTH = 160;
const SAP_JSON_PARSE_MAX_BYTES = 2_000_000;
// 文本前缀兜底长度(与 base64/HTML 一致:不塞长文本)。
const SAP_TEXT_PREFIX_LEN = 2048;
// 降级梯度(3→2→1 / 160→80→30 / 80→40→20),每步重算体积。
const SAP_ARRAY_ITEMS_LADDER = [3, 2, 1];
const SAP_STRING_LEN_LADDER = [160, 80, 30];
const SAP_OBJECT_KEYS_LADDER = [80, 40, 20];

interface PruneOpts { maxArrayItems: number; maxDepth: number; maxObjectKeys: number; maxStringLength: number; }

/** 递归剪枝一个已解析的 JSON 值:数组保前 N + 递归、对象保前 K 键 + 递归、字符串截断、超深度置空容器。 */
function pruneJsonValue(value: unknown, depth: number, opts: PruneOpts): unknown {
  if (Array.isArray(value)) {
    if (depth >= opts.maxDepth) return [];
    return value.slice(0, opts.maxArrayItems).map((el) => pruneJsonValue(el, depth + 1, opts));
  }
  if (isPlainObject(value)) {
    if (depth >= opts.maxDepth) return {};
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).slice(0, opts.maxObjectKeys)) {
      out[k] = pruneJsonValue(value[k], depth + 1, opts);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value.length > opts.maxStringLength ? value.slice(0, opts.maxStringLength) : value;
  }
  // number/boolean/null → 原样
  return value;
}

/**
 * 把要存进 session 的原始响应体归一成一段**合法结构化 JSON 样本**(fix C 根因修)。纯函数,无 IO。
 * 见上方语义块。返回 { responsePreview, responseBodyTruncated, previewMode }。
 */
export function makeStructureAwareResponsePreview(input: StructureAwarePreviewInput): StructureAwarePreviewResult {
  const body = input.body ?? '';
  const maxChars = input.maxChars ?? SAP_MAX_CHARS;
  const maxArrayItems = input.maxArrayItems ?? SAP_MAX_ARRAY_ITEMS;
  const maxDepth = input.maxDepth ?? SAP_MAX_DEPTH;
  const maxObjectKeys = input.maxObjectKeys ?? SAP_MAX_OBJECT_KEYS;
  const maxStringLength = input.maxStringLength ?? SAP_MAX_STRING_LENGTH;
  const jsonParseMaxBytes = input.jsonParseMaxBytes ?? SAP_JSON_PARSE_MAX_BYTES;

  const textPrefix = (): StructureAwarePreviewResult => ({
    responsePreview: body.slice(0, Math.min(maxChars, SAP_TEXT_PREFIX_LEN)),
    responseBodyTruncated: true,
    previewMode: 'text_prefix',
  });

  // 1) 非 JSON:content-type 明确非 json,或去空白后不以 {/[ 起头 → 文本前缀截断(旧行为)。
  const ct = (input.contentType ?? '').toLowerCase();
  const ctIsJson = ct.includes('json');
  const trimmed = body.trimStart();
  const startCh = trimmed[0];
  const looksJson = startCh === '{' || startCh === '[';
  // content-type 明说非 JSON(且非空)→ 直接文本;否则以「是否 {/[ 起头」判定。
  if ((ct && !ctIsJson) || !looksJson) {
    return textPrefix();
  }

  // 2) body ≤ maxChars 且能整体 parse → 原样存(full)。
  if (body.length <= maxChars) {
    try {
      JSON.parse(body);
      return { responsePreview: body, responseBodyTruncated: false, previewMode: 'full' };
    } catch {
      // 小体积但坏 JSON(可能本就被上游截断)→ 文本前缀兜底,交给 fix B 下游修复。
      return textPrefix();
    }
  }

  // 4) body > jsonParseMaxBytes:太大不 parse,文本前缀兜底。
  if (body.length > jsonParseMaxBytes) {
    return textPrefix();
  }

  // 3) body > maxChars 且 ≤ jsonParseMaxBytes:parse 全量 → 剪枝 → stringify;超限则按梯度降级。
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // 全量 parse 失败(已被上游截断的 legacy 输入)→ 文本前缀兜底(fix B 下游 repair 处理)。
    return textPrefix();
  }

  const attempt = (opts: PruneOpts): string => JSON.stringify(pruneJsonValue(parsed, 0, opts));

  // 首次:用调用方给的参数剪枝。
  let sample = attempt({ maxArrayItems, maxDepth, maxObjectKeys, maxStringLength });
  if (sample.length > maxChars) {
    // 降级梯度:数组元素 3→2→1、字符串 160→80→30、对象键 80→40→20,每步重算,取首个 ≤ maxChars 的。
    outer: for (const ai of SAP_ARRAY_ITEMS_LADDER) {
      for (const sl of SAP_STRING_LEN_LADDER) {
        for (const ok of SAP_OBJECT_KEYS_LADDER) {
          sample = attempt({ maxArrayItems: ai, maxDepth, maxObjectKeys: ok, maxStringLength: sl });
          if (sample.length <= maxChars) break outer;
        }
      }
    }
  }

  return {
    responsePreview: sample,
    // json_sample = previewMode !== 'full' → 恒「已裁剪」(spec: responseBodyTruncated 语义包含此项)。
    responseBodyTruncated: true,
    previewMode: 'json_sample',
  };
}

/**
 * 把一段原始响应体压成**结构摘要**(score 模式)。纯函数,无 IO。
 *
 * score 模式规则(Codex):
 * - JSON.parse 失败 → `{ parse:'failed', textPrefix: <前160字符>, truncated:true }`(绝不喂长文本)。
 * - object → 记顶层键;array → 分析前 3 个元素、union 键。
 * - rowPath:业务字段最丰富的那个 array 路径(丰富度相同偏好 data/results/list…)。
 * - rowKeys:行元素点分字段路径(深度 ≤3,上限 ~20)。
 * - **不含样本值**(只要键/形状,保持极小体积)。
 * - businessFieldHints:几个看着像真实数据的字段名(best-effort)。
 *
 * generate 模式规则(第2步,更详细,目标 ≤2500 字符):
 * - 解析失败 → 同 score 模式兜底(`parse:'failed'`,textPrefix ≤160)。
 * - wrappers:顶层标量字段 + 样本值(信封/分页识别)。
 * - arrays:各数组路径 + count + itemFields[{path,type,sample}](深度 ≤5,共享 ~60 字段路径预算)。
 * - recommendedRowPath / recommendedColumns:供生成器直接写 func/columns 抽取逻辑。
 * - 样本值:string 截断 ~30、number/bool 原样、object/array 不内联。
 * - opts(仅 generate,供 budget gate 降级):maxFieldPaths(60→40)、maxSampleStr(30→12)。
 */
export function buildResponseSummary(
  rawBody: string,
  mode: 'score' | 'generate',
  status?: number,
  opts?: { maxFieldPaths?: number; maxSampleStr?: number },
): ResponseSummary {
  const base: ResponseSummary = status !== undefined ? { status } : {};
  const trimmed = (rawBody ?? '').trim();
  if (!trimmed) {
    return { ...base, kind: 'unknown' };
  }

  let parsed: unknown;
  let repaired = false;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 先尝试修复被上游截断的 JSON 前缀(fix B):补齐闭合括号、丢弃半截尾元素,尽量保住已完整的元素。
    const repairedStr = repairTruncatedJsonPrefix(trimmed);
    if (repairedStr !== null) {
      try {
        parsed = JSON.parse(repairedStr);
        repaired = true;
      } catch {
        parsed = undefined; // 理论不达(repair 已自解析过);保守退回兜底
      }
    }
    if (!repaired) {
      // 修复失败:可能是 HTML/纯文本/无法救回的坏 JSON。只保留短前缀,绝不喂长文本(两模式一致)。
      const looksHtml = /^\s*<(?:!doctype|html|head|body|div|span|table)/i.test(trimmed);
      return {
        ...base,
        parse: 'failed',
        kind: looksHtml ? 'html' : 'unknown',
        textPrefix: trimmed.slice(0, PARSE_FAIL_PREFIX_LEN),
        truncated: true,
      };
    }
  }

  // 修复过的结构:标记 truncated + repaired,再走正常摘要逻辑(不改字段选择)。
  const markRepaired = (s: ResponseSummary): ResponseSummary =>
    repaired ? { ...s, truncated: true, repaired: true } : s;

  if (mode === 'generate') {
    return markRepaired(buildGenerateSummary(parsed, base, opts));
  }

  // ── score 模式(保持原行为不变)──
  if (Array.isArray(parsed)) {
    const topKeys = unionKeysOfArray(parsed);
    const arrayPaths: Array<{ path: string; count: number }> = [];
    collectArrayPaths(parsed, '', 0, arrayPaths);
    const rowPath = pickRowPath(parsed, arrayPaths);
    const summary: ResponseSummary = { ...base, kind: 'array', topKeys: topKeys.slice(0, MAX_TOP_KEYS) };
    // 15-doc 阶段二 #3:LLM-facing arrayPaths 过滤 count:0 空数组(对"判是否数据接口/定位列表"无信息量)。
    // pickRowPath 仍看全量(上一行已算),只精简喂 LLM 的那份。
    const nonEmptyPaths = arrayPaths.filter((p) => p.count > 0);
    if (nonEmptyPaths.length) summary.arrayPaths = nonEmptyPaths;
    if (rowPath) {
      summary.rowPath = rowPath;
      const rowObj = resolveArrayFirstObject(parsed, rowPath);
      if (rowObj) {
        const rowKeys: string[] = [];
        dottedKeys(rowObj, '', 1, ROW_KEY_MAX_DEPTH, rowKeys);
        summary.rowKeys = rowKeys;
        const hints = rowKeys.filter((k) => BUSINESS_FIELD_RE.test(k.split('.').pop()!.replace(/\[\]$/, '')));
        if (hints.length) summary.businessFieldHints = hints.slice(0, 8);
      }
    }
    return markRepaired(summary);
  }

  if (isPlainObject(parsed)) {
    const topKeys = Object.keys(parsed).slice(0, MAX_TOP_KEYS);
    const arrayPaths: Array<{ path: string; count: number }> = [];
    collectArrayPaths(parsed, '', 0, arrayPaths);
    const rowPath = pickRowPath(parsed, arrayPaths);
    const summary: ResponseSummary = { ...base, kind: 'object', topKeys };
    // 15-doc 阶段二 #3:同上,过滤 count:0 空数组(pickRowPath 已看全量)。
    const nonEmptyPaths = arrayPaths.filter((p) => p.count > 0);
    if (nonEmptyPaths.length) summary.arrayPaths = nonEmptyPaths;
    if (rowPath) {
      summary.rowPath = rowPath;
      const rowObj = resolveArrayFirstObject(parsed, rowPath);
      if (rowObj) {
        const rowKeys: string[] = [];
        dottedKeys(rowObj, '', 1, ROW_KEY_MAX_DEPTH, rowKeys);
        summary.rowKeys = rowKeys;
        const hints = rowKeys.filter((k) => BUSINESS_FIELD_RE.test(k.split('.').pop()!.replace(/\[\]$/, '')));
        if (hints.length) summary.businessFieldHints = hints.slice(0, 8);
      }
    }
    return markRepaired(summary);
  }

  // scalar(string/number/boolean/null)
  return markRepaired({ ...base, kind: 'scalar' });
}

// ── bounded-union 合并(buildMergedResponseSummary)helpers ──

/** 解析一个响应体(失败走 repairTruncatedJsonPrefix 兜底)。返回 {parsed,repaired} 或 null(不可解析)。 */
function parseBodyWithRepair(body: string): { parsed: unknown; repaired: boolean } | null {
  const trimmed = (body ?? '').trim();
  if (!trimmed) return null;
  try {
    return { parsed: JSON.parse(trimmed), repaired: false };
  } catch {
    const r = repairTruncatedJsonPrefix(trimmed);
    if (r === null) return null;
    try {
      return { parsed: JSON.parse(r), repaired: true };
    } catch {
      return null;
    }
  }
}

/** 一个已解析值的 rowPath(业务字段最丰富的数组路径)。 */
function rowPathOf(parsed: unknown): string | undefined {
  const aps: Array<{ path: string; count: number }> = [];
  collectArrayPaths(parsed, '', 0, aps);
  return pickRowPath(parsed, aps);
}

/** 叶子字段名(点分末段,去尾 `[]`)。 */
function leafName(path: string): string {
  return path.split('.').pop()!.replace(/\[\]$/, '');
}

/** 某解析体在 rowPath 下首个 object 元素的字段 schema(单体逻辑,复用 dottedFields)。 */
function itemFieldsAt(parsed: unknown, rowPath: string, maxStr: number, cap: number): FieldSchema[] {
  const firstObj = resolveArrayFirstObject(parsed, rowPath);
  if (!firstObj) return [];
  const out: FieldSchema[] = [];
  dottedFields(firstObj, '', 1, GEN_MAX_DEPTH, maxStr, out, cap);
  return out;
}

/** 采样体(内部形状):原始体 + status + 去重签名(caller 可注入 query-param 签名)。 */
interface MergeSampleBody {
  body: string;
  status?: number;
  /** query-param 签名(caller 从 URL 算好);缺省时按 body 结构签名兜底去重。 */
  paramSig?: string;
}

/**
 * bounded-union 采样:2xx 优先 → 可解析且有 rowPath 优先 → 按 query-param 签名去重(同参重复丢到首条)。
 * 精确 body 完全一致先折叠;再按签名分桶(每桶 ≤ maxBodiesPerSample),全局 ≤ maxBodies。
 * 无 paramSig 时用「顶层键 + rowPath + rowKeys 结构」当签名 —— 不同字段集的体保留(union 有增益),纯重复折叠。
 */
function sampleMergeBodies(
  calls: MergeSampleBody[],
  maxBodies: number,
  maxBodiesPerSample: number,
): Array<{ body: string; status?: number; parsed: unknown; repaired: boolean; rowPath?: string }> {
  // 预解析 + 打分(供稳定优先排序;不改变原始顺序作为次序 tiebreak)。
  const scored = calls.map((c, i) => {
    const pr = parseBodyWithRepair(c.body);
    const rowPath = pr ? rowPathOf(pr.parsed) : undefined;
    // 优先级:有 rowPath 的可解析体(2) > 可解析(1) > 不可解析(0);2xx 再加权。
    let rank = pr ? (rowPath ? 2 : 1) : 0;
    const is2xx = typeof c.status === 'number' ? c.status >= 200 && c.status < 300 : true;
    if (is2xx) rank += 3;
    return { call: c, idx: i, pr, rowPath, rank };
  });
  // 稳定排序:rank 降序,原序 tiebreak(保留录制先后)。
  const ordered = scored
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.rank - a.s.rank || a.i - b.i)
    .map((x) => x.s);

  const perSig = new Map<string, number>();
  const out: Array<{ body: string; status?: number; parsed: unknown; repaired: boolean; rowPath?: string }> = [];
  for (const s of ordered) {
    if (out.length >= maxBodies) break;
    if (!s.pr) continue; // 只并入可解析体(不可解析不贡献字段;单体兜底另处理)
    // 去重签名:caller 注入的 query-param 签名优先(不同 type/category_id/sort 保留、同参重复折叠);
    // 无 paramSig 时用结构签名(顶层键 + rowPath + 首行字段路径集)兜底 —— 结构相同的纯重复才折叠。
    let sig = s.call.paramSig;
    if (sig === undefined) {
      const parsed = s.pr.parsed;
      const topKeys = isPlainObject(parsed) ? Object.keys(parsed).sort() : Array.isArray(parsed) ? unionKeysOfArray(parsed).sort() : [];
      const rk = s.rowPath ? itemFieldsAt(parsed, s.rowPath, 0, MERGE_MAX_ITEM_FIELDS).map((f) => f.path).sort() : [];
      sig = `${topKeys.join(',')}|${s.rowPath ?? ''}|${rk.join(',')}`;
    }
    const used = perSig.get(sig) ?? 0;
    if (used >= maxBodiesPerSample) continue; // 同签名重复丢到首(几)条
    perSig.set(sig, used + 1);
    out.push({ body: s.call.body, status: s.call.status, parsed: s.pr.parsed, repaired: s.pr.repaired, rowPath: s.rowPath });
  }
  return out;
}

/**
 * bounded-union 响应摘要:把一个 endpoint group 的**多次调用**响应体合并成覆盖全字段的结构摘要。
 *
 * 根因:core 按 (method+host+pathname) 聚拢候选,一个候选=一个 endpoint group,组内多次调用(type=hot vs new、
 * 不同 category_id/sort…)返回**互补**字段。旧的单代表体只 proto 一次调用 → 漏掉只在别的调用出现的字段(如
 * body-A 有 content_counter.view、body-B 才有 content_counter.share)。本函数在少数采样体上做**有界并集**:
 *  - 采样(2xx/可解析/有 rowPath 优先 + 按 query-param 签名去重),≤ maxBodies=6,每签名 ≤ maxBodiesPerSample=3;
 *  - rowPath 投票:winner=最高票;winnerRate≥0.6 用 winner 合并;<0.6 且多 rowPath 带业务字段 → mixedRowPath;
 *  - 字段并集 + 覆盖率(occurrence/total)+ 噪音黑名单 + businessWeight 门槛 → recommendedColumns。
 *
 * 单体 buildResponseSummary 保持不变(repair/fallback/测试仍用它)。generate 模式产 itemFields(带类型并集 +
 * primaryType + 覆盖率);score 模式产合并 rowKeys。字符预算超限按降级顺序收窄。
 */
export function buildMergedResponseSummary(
  calls: Array<{ body: string; status?: number; paramSig?: string }>,
  mode: 'score' | 'generate',
  opts?: { maxFieldPaths?: number; maxSampleStr?: number; maxBodies?: number; maxBodiesPerSample?: number },
): ResponseSummary {
  const maxBodies = opts?.maxBodies ?? MERGE_MAX_BODIES;
  const maxPerSample = opts?.maxBodiesPerSample ?? MERGE_MAX_BODIES_PER_SAMPLE;
  const maxStr = opts?.maxSampleStr ?? GEN_MAX_SAMPLE_STR_LEN;
  const maxFieldPaths = opts?.maxFieldPaths ?? GEN_MAX_FIELD_PATHS;

  // 空输入 → unknown。
  if (!calls || calls.length === 0) return { kind: 'unknown' };

  const sampled = sampleMergeBodies(calls, maxBodies, maxPerSample);
  const firstStatus = calls.find((c) => typeof c.status === 'number')?.status;

  // 全不可解析 → 退回单体逻辑(parse:failed 兜底,由 buildResponseSummary 负责)。
  if (sampled.length === 0) {
    return buildResponseSummary(calls[0]!.body, mode, calls[0]!.status ?? firstStatus);
  }

  // rowPath 投票。
  const votes = new Map<string, number>();
  for (const b of sampled) if (b.rowPath) votes.set(b.rowPath, (votes.get(b.rowPath) ?? 0) + 1);
  let winner: string | undefined;
  let winnerVotes = 0;
  for (const [p, v] of votes) if (v > winnerVotes) { winner = p; winnerVotes = v; }
  const parsedCount = sampled.length;
  const winnerRate = winner ? winnerVotes / parsedCount : 0;

  // 多个 rowPath 都带业务字段?(判 mixedRowPath)
  let rowPathsWithBusiness = 0;
  for (const p of votes.keys()) {
    const rep = sampled.find((b) => b.rowPath === p);
    const obj = rep ? resolveArrayFirstObject(rep.parsed, p) : null;
    if (obj && businessScore(obj) > 0) rowPathsWithBusiness += 1;
  }
  const mixedRowPath = winner !== undefined && winnerRate < MERGE_WINNER_RATE && rowPathsWithBusiness >= 2;

  // 代表体:winner 桶里第一条(与 winner rowPath 一致);无 winner(无数组行)→ 首个采样体。
  const winnerBodies = winner ? sampled.filter((b) => b.rowPath === winner) : [];
  const repBody = (winnerBodies[0] ?? sampled[0])!;
  const repStatus = repBody.status ?? firstStatus;

  // 基础摘要:对代表体跑单体逻辑(拿 topKeys/kind/wrappers/arrays/rowPath 骨架),随后覆盖合并结果。
  const base = buildResponseSummary(repBody.body, mode, repStatus, mode === 'generate' ? { maxFieldPaths, maxSampleStr: maxStr } : undefined);
  base.mergedBodyCount = sampled.length;
  base.parsedBodyCount = parsedCount;
  if (winner) base.rowPathWinnerRate = Math.round(winnerRate * 100) / 100;
  if (mixedRowPath) { base.mixedRowPath = true; base.reviewRequired = true; }
  if (repBody.repaired) { base.truncated = true; base.repaired = true; }

  // 无 winner rowPath(无行数组)→ 就用代表体的单体摘要(加合并元数据)。
  if (!winner) return base;

  // ── 字段并集(仅 winner rowPath 的采样体)──
  const mergeSet = winnerBodies; // winnerRate≥0.6 与 mixed 都只并 winner 桶
  const mergeCount = mergeSet.length;
  interface Acc { path: string; typeCounts: Map<string, number>; sample?: SampleValue; occurrence: number }
  const fieldMap = new Map<string, Acc>();
  for (const b of mergeSet) {
    const fields = itemFieldsAt(b.parsed, winner, maxStr, MERGE_MAX_ITEM_FIELDS * 2);
    const seen = new Set<string>();
    for (const f of fields) {
      if (seen.has(f.path)) continue; // 同体内路径去重(occurrence 计「体」不计「行」)
      seen.add(f.path);
      let acc = fieldMap.get(f.path);
      if (!acc) { acc = { path: f.path, typeCounts: new Map(), occurrence: 0 }; fieldMap.set(f.path, acc); }
      acc.typeCounts.set(f.type, (acc.typeCounts.get(f.type) ?? 0) + 1);
      acc.occurrence += 1;
      if (acc.sample === undefined && f.sample !== undefined) acc.sample = f.sample;
    }
  }

  // 合并字段 schema(带类型并集 + primaryType + 覆盖率),保持发现序,截到 MERGE_MAX_ITEM_FIELDS。
  const merged: MergedFieldSchema[] = [];
  for (const acc of fieldMap.values()) {
    const types = [...acc.typeCounts.keys()];
    // primaryType:出现最多的类型;平票偏 'string'。
    let primaryType = types[0]!;
    let bestCount = -1;
    for (const t of types) {
      const cnt = acc.typeCounts.get(t)!;
      if (cnt > bestCount || (cnt === bestCount && t === 'string')) { primaryType = t; bestCount = cnt; }
    }
    const occurrenceRate = mergeCount > 0 ? acc.occurrence / mergeCount : 0;
    merged.push({
      path: acc.path,
      type: types.length > 1 ? types.join('|') : types[0]!,
      primaryType,
      types,
      ...(acc.sample !== undefined ? { sample: acc.sample } : {}),
      occurrence: acc.occurrence,
      total: mergeCount,
      occurrenceRate: Math.round(occurrenceRate * 100) / 100,
    });
    if (merged.length >= MERGE_MAX_ITEM_FIELDS) break;
  }

  base.recommendedRowPath = winner;
  base.rowPath = winner;

  if (mode === 'score') {
    // score:合并 rowKeys(并集),截到 30;不产 recommendedColumns。
    const rowKeys = merged.map((f) => (f.primaryType === 'array' ? `${f.path}[]` : f.path)).slice(0, MERGE_MAX_ROW_KEYS_SCORE);
    base.rowKeys = rowKeys;
    const hints = merged.map((f) => f.path).filter((p) => BUSINESS_FIELD_RE.test(leafName(p)));
    if (hints.length) base.businessFieldHints = hints.slice(0, 8);
    degradeMergedToBudget(base, mode);
    return base;
  }

  // ── generate:覆盖 winner 数组的 itemFields = 合并结果,并重算 recommendedColumns ──
  if (!base.arrays) base.arrays = [];
  const winnerArr = base.arrays.find((a) => a.path === winner);
  const winnerCount = winnerArr?.count ?? mergeCount;
  const mergedItemFields: FieldSchema[] = merged.map((f) => ({
    path: f.path,
    type: f.type,
    ...(f.sample !== undefined ? { sample: f.sample } : {}),
  }));
  if (winnerArr) winnerArr.itemFields = mergedItemFields;
  else base.arrays.unshift({ path: winner, count: winnerCount, itemFields: mergedItemFields });

  // recommendedColumns:覆盖率 + 噪音黑名单 + 高价值放宽,再走既有跨子对象均衡 + 排序 + MAX_RECOMMENDED_COLUMNS。
  base.recommendedColumns = selectMergedRecommendedColumns(merged);
  if (!base.recommendedColumns.length) delete base.recommendedColumns;

  // businessFieldHints(从合并字段)。
  const hints = merged.map((f) => f.path).filter((p) => BUSINESS_FIELD_RE.test(leafName(p)));
  if (hints.length) base.businessFieldHints = hints.slice(0, 8);

  degradeMergedToBudget(base, mode);
  return base;
}

/**
 * merged recommendedColumns 选择:先按覆盖率 + 噪音黑名单 + 高价值放宽过滤,再交给既有
 * selectRecommendedColumns(跨子对象均衡 + businessWeight 排序 + MAX 40)。type 用 primaryType。
 */
function selectMergedRecommendedColumns(merged: MergedFieldSchema[]): Array<{ name: string; path: string; type: string }> {
  const scalars = merged.filter((f) => (f.primaryType ?? f.type) !== 'array');
  const passed: FieldSchema[] = [];
  const lowCovHighVal: Array<{ f: MergedFieldSchema; rate: number }> = [];
  for (const f of scalars) {
    const leaf = leafName(f.path);
    if (NOISE_LEAF_RE.test(leaf)) continue; // 噪音黑名单:永不进 columns(即使 100% 覆盖)
    const total = f.total ?? 1;
    const rate = f.occurrenceRate ?? 1;
    const asField: FieldSchema = { path: f.path, type: f.primaryType ?? f.type, ...(f.sample !== undefined ? { sample: f.sample } : {}) };
    if (total <= 2) {
      if ((f.occurrence ?? 1) >= 1) passed.push(asField);
      continue;
    }
    // total > 2:需 occurrenceRate ≥ 0.5;高业务价值字段可在 ≥ 0.33 进入(低覆盖高价值补入上限 5)。
    if (rate >= MERGE_LOW_COVERAGE_RATE) { passed.push(asField); continue; }
    if (businessWeight(leaf) === 3 && rate >= MERGE_HIGH_VALUE_COVERAGE_RATE) lowCovHighVal.push({ f, rate });
  }
  // 低覆盖高价值:按覆盖率降序补入,上限 5。
  lowCovHighVal.sort((a, b) => b.rate - a.rate);
  for (const { f } of lowCovHighVal.slice(0, MERGE_HIGH_VALUE_LOW_COVERAGE_CAP)) {
    passed.push({ path: f.path, type: f.primaryType ?? f.type, ...(f.sample !== undefined ? { sample: f.sample } : {}) });
  }
  return selectRecommendedColumns(passed);
}

/**
 * merged 摘要字符预算收窄(超 MERGE_MAX_CHARS 时按信息价值从低到高逐级降级):
 * ① sample 字符串 30→12 → ② itemFields 80→50→30 → ③ 先丢低覆盖可选字段 → ④ columns 40→25(保高权重)。
 * recommendedRowPath/recommendedColumns 命脉尽量保。
 */
function degradeMergedToBudget(summary: ResponseSummary, mode: 'score' | 'generate'): void {
  const over = () => JSON.stringify(summary).length > MERGE_MAX_CHARS;
  if (!over()) return;

  const winnerArr = mode === 'generate' && summary.recommendedRowPath
    ? summary.arrays?.find((a) => a.path === summary.recommendedRowPath)
    : undefined;

  // ① sample 字符串截到 12(itemFields + wrappers)。
  const clampSample = (f: FieldSchema) => {
    if (typeof f.sample === 'string' && f.sample.length > GEN_DEGRADE_MERGE_SAMPLE) {
      f.sample = f.sample.slice(0, GEN_DEGRADE_MERGE_SAMPLE) + '…';
    }
  };
  summary.arrays?.forEach((a) => a.itemFields.forEach(clampSample));
  summary.wrappers?.forEach(clampSample);
  if (!over()) return;

  // ② itemFields 80→50→30(仅 winner 数组;保 recommendedColumns 已选路径)。
  if (winnerArr) {
    for (const cap of [50, 30]) {
      if (winnerArr.itemFields.length > cap) winnerArr.itemFields = winnerArr.itemFields.slice(0, cap);
      if (!over()) return;
    }
  }

  // ③ 先丢低覆盖可选字段(rowKeys / winner itemFields 里 occurrenceRate < 0.5 的)。
  if (mode === 'score' && summary.rowKeys && summary.rowKeys.length > MERGE_MAX_ROW_KEYS_SCORE / 2) {
    summary.rowKeys = summary.rowKeys.slice(0, Math.floor(MERGE_MAX_ROW_KEYS_SCORE / 2));
    if (!over()) return;
  }

  // ④ columns 40→25(保高权重:selectRecommendedColumns 已按业务价值排序,取前 25)。
  if (summary.recommendedColumns && summary.recommendedColumns.length > 25) {
    summary.recommendedColumns = summary.recommendedColumns.slice(0, 25);
  }
}


/**
 * 取 rowPath 下**首个元素**的原始 JSON(≤maxLen 字符)。用于 verify-repair 唯一的「渐进披露」:
 * 结构 schema 不够、verify 抽字段失败时,补一小段真实样本给生成器。这是**唯一**让原始 JSON 进 prompt 的地方。
 * 无 rowPath / 解析失败 / 无元素 → 返回 null(调用方退回纯 schema)。
 */
export function extractRowSample(rawBody: string, rowPath: string | undefined, maxLen = 1200): string | null {
  if (!rowPath) return null;
  const trimmed = (rawBody ?? '').trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  // 解析 rowPath 到数组,再取首元素(不限定 object —— scalar 元素也可作样本)。
  let cur: unknown = parsed;
  if (rowPath !== '$' && rowPath !== '') {
    for (const seg of rowPath.split('.')) {
      if (isPlainObject(cur)) cur = (cur as Record<string, unknown>)[seg];
      else { cur = undefined; break; }
    }
  }
  if (!Array.isArray(cur) || cur.length === 0) return null;
  const first = cur[0];
  let json: string;
  try {
    json = JSON.stringify(first);
  } catch {
    return null;
  }
  return json.length > maxLen ? json.slice(0, maxLen) + '…(truncated)' : json;
}
