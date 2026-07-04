// responseSummary 单测:结构摘要压缩(score 模式)。覆盖 juejin article_rank 形状、解析失败兜底、
// object/array/scalar 分支、rowPath 业务字段偏好、体积上限。
import { describe, it, expect } from 'vitest';
import { buildResponseSummary, buildMergedResponseSummary, extractRowSample, repairTruncatedJsonPrefix, makeStructureAwareResponsePreview } from '../src/llm/responseSummary.js';

// juejin article_rank 缩样:{ err_no, err_msg, data:[ { content:{title,...}, author:{name,...}, content_counter:{view,like} } ] }
const juejinRankBody = JSON.stringify({
  err_no: 0,
  err_msg: 'success',
  data: [
    {
      content: { content_id: '1', title: 'React Renderer 架构', category_id: '68', tag_ids: ['a', 'b'] },
      content_counter: { view: 3432, like: 19, collect: 18, hot_rank: 1755 },
      author: { user_id: '14', name: '老王以为', avatar: 'https://x/a.png', is_followed: false },
    },
    {
      content: { content_id: '2', title: 'DeepSeek 招人', category_id: '68', tag_ids: ['c'] },
      content_counter: { view: 2763, like: 23, collect: 29, hot_rank: 1485 },
      author: { user_id: '95', name: '沉默王二', avatar: 'https://x/b.png', is_followed: false },
    },
    {
      content: { content_id: '3', title: '第三篇', extra_field: 'only-in-third' },
      content_counter: { view: 100 },
      author: { name: '作者三' },
    },
  ],
});

describe('buildResponseSummary · score 模式', () => {
  it('juejin article_rank 形状 → kind=object、rowPath=data、rowKeys 含 content.title/author.name,无样本值', () => {
    const s = buildResponseSummary(juejinRankBody, 'score', 200);
    expect(s.kind).toBe('object');
    expect(s.status).toBe(200);
    expect(s.topKeys).toEqual(expect.arrayContaining(['err_no', 'err_msg', 'data']));
    expect(s.rowPath).toBe('data');
    expect(s.rowKeys).toEqual(expect.arrayContaining(['content.title', 'author.name']));
    // 深度 ≤3 + 业务字段
    expect(s.rowKeys).toEqual(expect.arrayContaining(['content_counter.view', 'content_counter.like']));
    // 不含样本值:摘要里不应出现具体标题/作者名
    const blob = JSON.stringify(s);
    expect(blob).not.toContain('React Renderer');
    expect(blob).not.toContain('老王以为');
    // businessFieldHints best-effort
    expect(s.businessFieldHints).toEqual(expect.arrayContaining(['content.title']));
    // 体积:score 侧目标 ≤800 字符
    expect(blob.length).toBeLessThanOrEqual(800);
  });

  it('array 分析前 3 个元素 union 键(不止首个)', () => {
    // 首元素缺 extra,第三元素有 —— union 应含 extra
    const body = JSON.stringify([{ a: 1 }, { b: 2 }, { c: 3 }]);
    const s = buildResponseSummary(body, 'score');
    expect(s.kind).toBe('array');
    expect(s.topKeys).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });

  it('顶层 data[] 元素是 object 时选为 rowPath', () => {
    const body = JSON.stringify([
      { title: 't1', name: 'n1', view: 1 },
      { title: 't2', name: 'n2', view: 2 },
    ]);
    const s = buildResponseSummary(body, 'score');
    expect(s.kind).toBe('array');
    expect(s.rowPath).toBe('$');
    expect(s.rowKeys).toEqual(expect.arrayContaining(['title', 'name', 'view']));
  });

  it('15-doc 阶段二 #3:arrayPaths 过滤 count:0 空数组(pickRowPath 仍看全量,rowPath 不受影响)', () => {
    const body = JSON.stringify({
      data: [{ title: 't1', view: 1, tags: ['a'], empty_arr: [], theme_list: [] }],
      other_empty: [],
    });
    const s = buildResponseSummary(body, 'score');
    expect(s.rowPath).toBe('data'); // pickRowPath 用全量,rowPath 正常
    const paths = (s.arrayPaths ?? []).map((p) => p.path);
    // 非空数组保留(data、data[].tags),空数组过滤(other_empty、data[].empty_arr、data[].theme_list)
    expect(paths).toContain('data');
    expect((s.arrayPaths ?? []).every((p) => p.count > 0)).toBe(true);
    expect(paths).not.toContain('other_empty');
    expect(paths.some((p) => p.includes('empty_arr') || p.includes('theme_list'))).toBe(false);
  });

  it('解析失败 → { parse:"failed", textPrefix(≤160), truncated:true },不喂长文本', () => {
    const long = '<html><body>' + 'x'.repeat(5000) + '</body></html>';
    const s = buildResponseSummary(long, 'score', 200);
    expect(s.parse).toBe('failed');
    expect(s.kind).toBe('html');
    expect(s.truncated).toBe(true);
    expect(s.textPrefix!.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(s).length).toBeLessThan(400);
  });

  it('非 HTML 的坏 JSON → parse failed + kind=unknown', () => {
    const s = buildResponseSummary('{not valid json', 'score');
    expect(s.parse).toBe('failed');
    expect(s.kind).toBe('unknown');
  });

  it('scalar/空体兜底', () => {
    expect(buildResponseSummary('42', 'score').kind).toBe('scalar');
    expect(buildResponseSummary('"hi"', 'score').kind).toBe('scalar');
    expect(buildResponseSummary('', 'score').kind).toBe('unknown');
  });

  it('rowPath 偏好业务字段最丰富的数组(而非空壳/短数组)', () => {
    const body = JSON.stringify({
      meta: [{ code: 1 }, { code: 2 }], // 少业务字段
      results: [{ title: 'a', author: 'x', view: 1, like: 2 }], // 业务字段多
    });
    const s = buildResponseSummary(body, 'score');
    expect(s.rowPath).toBe('results');
  });
});

describe('buildResponseSummary · generate 模式', () => {
  it('juejin article_rank → itemFields 带样本值 + recommendedColumns + recommendedRowPath', () => {
    const s = buildResponseSummary(juejinRankBody, 'generate', 200);
    expect(s.kind).toBe('object');
    expect(s.status).toBe(200);
    // wrappers:顶层标量信封字段带样本值
    expect(s.wrappers).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'err_no', type: 'number', sample: 0 }),
      expect.objectContaining({ path: 'err_msg', type: 'string', sample: 'success' }),
    ]));
    // recommendedRowPath = data(行数据数组)
    expect(s.recommendedRowPath).toBe('data');
    // arrays:含 data 路径 + itemFields 带 path/type/sample
    const dataArr = s.arrays?.find((a) => a.path === 'data');
    expect(dataArr).toBeDefined();
    expect(dataArr!.count).toBe(3);
    const titleField = dataArr!.itemFields.find((f) => f.path === 'content.title');
    expect(titleField).toMatchObject({ type: 'string' });
    expect(titleField!.sample).toContain('React'); // 样本值存在(截断后仍含 React)
    // 数值样本原样
    const viewField = dataArr!.itemFields.find((f) => f.path === 'content_counter.view');
    expect(viewField).toMatchObject({ type: 'number', sample: 3432 });
    // recommendedColumns:name/path/type
    expect(s.recommendedColumns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'title', path: 'content.title', type: 'string' }),
      expect.objectContaining({ name: 'name', path: 'author.name', type: 'string' }),
    ]));
  });

  it('比 score 模式更详细(同一 body:generate 更大 + 有 itemFields/样本值,score 无)', () => {
    const gen = buildResponseSummary(juejinRankBody, 'generate', 200);
    const score = buildResponseSummary(juejinRankBody, 'score', 200);
    const genLen = JSON.stringify(gen).length;
    const scoreLen = JSON.stringify(score).length;
    expect(genLen).toBeGreaterThan(scoreLen);          // generate 更详细
    expect(gen.arrays).toBeDefined();                   // generate 有 itemFields
    expect(score.arrays).toBeUndefined();               // score 无 arrays(只 arrayPaths)
    expect(gen.recommendedColumns).toBeDefined();       // generate 有推荐列
    expect(score.recommendedColumns).toBeUndefined();
    // generate 有样本值,score 无(score 摘要不含具体值)
    expect(JSON.stringify(gen)).toContain('React');
    expect(JSON.stringify(score)).not.toContain('React');
    // 目标 ≤2500 字符
    expect(genLen).toBeLessThanOrEqual(2500);
  });

  it('字符串样本 ~30 截断、object/array 不内联样本值', () => {
    const body = JSON.stringify({
      data: [{ longText: 'x'.repeat(100), nested: { a: 1 }, list: [1, 2, 3] }],
    });
    const s = buildResponseSummary(body, 'generate');
    const dataArr = s.arrays?.find((a) => a.path === 'data');
    const longField = dataArr!.itemFields.find((f) => f.path === 'longText');
    expect(typeof longField!.sample).toBe('string');
    expect((longField!.sample as string).length).toBeLessThanOrEqual(31); // 30 + '…'
    // list[] 是 array 容器,type=array 无 sample
    const listField = dataArr!.itemFields.find((f) => f.path === 'list[]');
    expect(listField).toMatchObject({ type: 'array' });
    expect(listField!.sample).toBeUndefined();
  });

  it('降级参数:maxFieldPaths / maxSampleStr 生效', () => {
    const items = Array.from({ length: 50 }, (_, i) => `f${i}`);
    const row: Record<string, unknown> = {};
    for (const k of items) row[k] = 'value-' + k + '-' + 'y'.repeat(40);
    const body = JSON.stringify({ data: [row] });
    const full = buildResponseSummary(body, 'generate');
    const degraded = buildResponseSummary(body, 'generate', undefined, { maxFieldPaths: 40, maxSampleStr: 12 });
    const fullFields = full.arrays!.find((a) => a.path === 'data')!.itemFields.length;
    const degFields = degraded.arrays!.find((a) => a.path === 'data')!.itemFields.length;
    expect(degFields).toBeLessThanOrEqual(40);
    expect(degFields).toBeLessThanOrEqual(fullFields);
    // sample 更短
    const degSample = degraded.arrays!.find((a) => a.path === 'data')!.itemFields[0]!.sample as string;
    expect(degSample.length).toBeLessThanOrEqual(13); // 12 + '…'
  });

  it('解析失败 → 同 score 兜底(parse failed + textPrefix ≤160)', () => {
    const s = buildResponseSummary('<html>' + 'x'.repeat(500), 'generate', 200);
    expect(s.parse).toBe('failed');
    expect(s.kind).toBe('html');
    expect(s.textPrefix!.length).toBeLessThanOrEqual(160);
  });

  it('recommendedColumns 跨子对象铺开:含 content_counter.* 指标 + author.name(不被 content.* 独占)', () => {
    // 真机 juejin article_rank 完整行:content 子对象字段最多且含噪音(format/brief/status/ctime/mtime),
    // 旧逻辑按遍历序取前 N 会被 content.* 占满 → 漏掉指标/作者。新逻辑应跨子对象均衡。
    const fullRankBody = JSON.stringify({
      err_no: 0,
      err_msg: 'success',
      data: [
        {
          content: {
            content_id: '7656342465024540718', item_type: 2, format: '', author_id: '1433418891015310',
            title: 'React Renderer 分离的多平台架构', brief: '', status: 2, ctime: 0, mtime: 0,
            category_id: '6809637767543259144', tag_ids: ['a', 'b', 'c'],
          },
          content_counter: { view: 3432, like: 19, collect: 18, hot_rank: 1755, comment_count: 5, interact_count: 24 },
          author: { user_id: '1433418891015310', name: '老王以为', avatar: 'https://x/a.png', is_followed: false },
          author_counter: { level: 4, power: 2029, follower: 0, followee: 0, publish: 0, view: 0, like: 0, hot_rank: 0 },
          user_interact: { is_user_like: false, is_user_collect: false, is_follow: false },
        },
      ],
    });
    const s = buildResponseSummary(fullRankBody, 'generate', 200);
    const cols = s.recommendedColumns!;
    const paths = cols.map((c) => c.path);
    // 指标:至少一个 content_counter.* 计数字段被推荐
    const counterCols = paths.filter((p) => p.startsWith('content_counter.'));
    expect(counterCols.length).toBeGreaterThan(0);
    expect(paths).toEqual(expect.arrayContaining(['content_counter.view', 'content_counter.like']));
    // 作者:author.name 被推荐
    expect(paths).toContain('author.name');
    // 主体标识:content.title 仍在
    expect(paths).toContain('content.title');
    // 跨子对象铺开:推荐列覆盖 ≥3 个子对象分组(content / content_counter / author …)
    const groups = new Set(paths.map((p) => (p.includes('.') ? p.slice(0, p.indexOf('.')) : '')));
    expect(groups.size).toBeGreaterThanOrEqual(3);
    // content.* 不独占:不超过 per-subobject 上限(4)
    const contentCols = paths.filter((p) => p.startsWith('content.'));
    expect(contentCols.length).toBeLessThanOrEqual(4);
    // 噪音字段(format/status/ctime/mtime/brief)被业务价值排序压到 content 配额之外
    expect(paths).not.toContain('content.ctime');
    expect(paths).not.toContain('content.mtime');
    expect(paths).not.toContain('content.status');
  });
});

describe('repairTruncatedJsonPrefix · 截断 JSON 修复(fix B)', () => {
  it('半截尾元素 → 丢弃 + 闭合 array/object,保住已完整元素', () => {
    const truncated = '{"data":[{"a":1},{"b":2},{"c":"half';
    const fixed = repairTruncatedJsonPrefix(truncated);
    expect(fixed).not.toBeNull();
    const parsed = JSON.parse(fixed!);
    expect(parsed).toEqual({ data: [{ a: 1 }, { b: 2 }] });
  });

  it('buildResponseSummary(score) 对半截 body → rowPath=data、2 元素、repaired:true', () => {
    const truncated = '{"data":[{"a":1},{"b":2},{"c":"half';
    const s = buildResponseSummary(truncated, 'score');
    expect(s.parse).toBeUndefined();
    expect(s.kind).toBe('object');
    expect(s.rowPath).toBe('data');
    expect(s.repaired).toBe(true);
    expect(s.truncated).toBe(true);
    const arr = buildResponseSummary(truncated, 'generate').arrays?.find((a) => a.path === 'data');
    expect(arr!.count).toBe(2);
  });

  it('截断在字符串中间(含转义引号)→ 丢半截字符串值,保住之前的完整成员', () => {
    const truncated = '{"title":"he said \\"hi","body":"un終わ';
    const fixed = repairTruncatedJsonPrefix(truncated);
    expect(fixed).not.toBeNull();
    const parsed = JSON.parse(fixed!);
    expect(parsed).toEqual({ title: 'he said "hi' });
  });

  it('截断刚好在逗号后 → 去掉尾逗号并闭合', () => {
    const truncated = '{"data":[{"a":1},{"b":2},';
    const fixed = repairTruncatedJsonPrefix(truncated);
    expect(fixed).not.toBeNull();
    expect(JSON.parse(fixed!)).toEqual({ data: [{ a: 1 }, { b: 2 }] });
  });

  it('已是合法 JSON → buildResponseSummary 先 parse 成功,不标 repaired', () => {
    const s = buildResponseSummary(juejinRankBody, 'score');
    expect(s.repaired).toBeUndefined();
    expect(s.parse).toBeUndefined();
  });

  it('深层嵌套对象里截断 → 逐层闭合', () => {
    const truncated = '{"a":{"b":{"c":[{"x":1},{"y":';
    const fixed = repairTruncatedJsonPrefix(truncated);
    expect(fixed).not.toBeNull();
    expect(JSON.parse(fixed!)).toEqual({ a: { b: { c: [{ x: 1 }] } } });
  });

  it('非 JSON(HTML/纯文本)→ null → textPrefix 兜底', () => {
    expect(repairTruncatedJsonPrefix('<html><body>oops')).toBeNull();
    expect(repairTruncatedJsonPrefix('not json at all')).toBeNull();
    const s = buildResponseSummary('<html><body>' + 'x'.repeat(500), 'score', 200);
    expect(s.parse).toBe('failed');
    expect(s.kind).toBe('html');
    expect(s.repaired).toBeUndefined();
  });

  it('只能救回空 {} / [] → null(视为没救回来)', () => {
    expect(repairTruncatedJsonPrefix('{"a":')).toBeNull(); // 半截值,无完整成员
    expect(repairTruncatedJsonPrefix('[')).toBeNull();
  });

  it('真机 article_rank 半截 body(generate)→ recommendedColumns 含 content_counter.* + author.name(非 parse:failed)', () => {
    // 一个完整 item + 一个被从中间切断的 item(模拟上游 mid-string 截断)。
    const truncated =
      '{"err_no":0,"err_msg":"success","data":[' +
      '{"content":{"content_id":"1","title":"React Renderer 架构","category_id":"68"},' +
      '"content_counter":{"view":3432,"like":19,"collect":18,"hot_rank":1755},' +
      '"author":{"user_id":"14","name":"老王以为","avatar":"https://x/a.png"}},' +
      '{"content":{"content_id":"2","title":"DeepSeek 招';
    const s = buildResponseSummary(truncated, 'generate', 200);
    expect(s.parse).toBeUndefined();
    expect(s.repaired).toBe(true);
    expect(s.recommendedRowPath).toBe('data');
    const paths = s.recommendedColumns!.map((c) => c.path);
    expect(paths).toContain('content.title');
    expect(paths).toContain('author.name');
    expect(paths.some((p) => p.startsWith('content_counter.'))).toBe(true);
  });
});

describe('extractRowSample', () => {
  it('取 rowPath 首元素原始 JSON(≤1200)', () => {
    const sample = extractRowSample(juejinRankBody, 'data', 1200);
    expect(sample).toBeTruthy();
    expect(sample).toContain('React Renderer'); // 首元素真实值
    expect(sample!.length).toBeLessThanOrEqual(1200 + 15);
  });

  it('超长 → 截断带标记', () => {
    const body = JSON.stringify({ data: [{ big: 'z'.repeat(3000) }] });
    const sample = extractRowSample(body, 'data', 1200);
    expect(sample!.length).toBeLessThanOrEqual(1200 + 15);
    expect(sample).toContain('truncated');
  });

  it('无 rowPath / 解析失败 / 空数组 → null', () => {
    expect(extractRowSample(juejinRankBody, undefined)).toBeNull();
    expect(extractRowSample('not json', 'data')).toBeNull();
    expect(extractRowSample(JSON.stringify({ data: [] }), 'data')).toBeNull();
  });
});

describe('makeStructureAwareResponsePreview · fix C 结构感知预览', () => {
  // article_rank 类形状:data[] 大量元素 + 深嵌套 object。
  const bigRankBody = JSON.stringify({
    err_no: 0,
    err_msg: 'success',
    data: Array.from({ length: 20 }, (_, i) => ({
      content: { content_id: String(i), title: `文章标题 ${i}`, category_id: '68', tag_ids: ['a', 'b'] },
      content_counter: { view: 1000 + i, like: i, collect: i * 2, hot_rank: 2000 - i },
      author: { user_id: String(i), name: `作者${i}`, avatar: `https://x/${i}.png`, is_followed: false },
    })),
  });

  it('大 JSON(data[] 20 项)超 maxChars → json_sample,可 parse、≤3 项、嵌套结构完整', () => {
    const r = makeStructureAwareResponsePreview({ body: bigRankBody, contentType: 'application/json', maxChars: 500 });
    expect(r.previewMode).toBe('json_sample');
    expect(r.responseBodyTruncated).toBe(true);
    // 合法 JSON(根因修的核心):下游能可靠 parse。
    const parsed = JSON.parse(r.responsePreview) as { data: unknown[] };
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data.length).toBeLessThanOrEqual(3);
    // 首元素嵌套结构完整(content/content_counter/author 全在)—— 这是 generate 拿全字段路径的前提。
    const first = parsed.data[0] as Record<string, Record<string, unknown>>;
    expect(first.content.title).toBeDefined();
    expect(first.content_counter.view).toBeDefined();
    expect(first.author.name).toBeDefined();
  });

  it('json_sample 喂 buildResponseSummary(generate)→ 拿到 content_counter.* + author.name(非 parse:failed)', () => {
    const r = makeStructureAwareResponsePreview({ body: bigRankBody, contentType: 'application/json', maxChars: 500 });
    const s = buildResponseSummary(r.responsePreview, 'generate', 200);
    expect(s.parse).toBeUndefined();
    expect(s.rowPath).toBe('data');
    const paths = (s.arrays ?? []).flatMap((a) => a.itemFields.map((f) => f.path));
    expect(paths).toEqual(expect.arrayContaining(['content.title', 'author.name']));
    expect(paths.some((p) => p.startsWith('content_counter.'))).toBe(true);
  });

  it('超长字符串值 → 截断但预览仍是合法 JSON', () => {
    const body = JSON.stringify({ data: [{ blob: 'z'.repeat(5000), n: 1 }] });
    const r = makeStructureAwareResponsePreview({ body, contentType: 'application/json', maxChars: 300, maxStringLength: 80 });
    expect(r.previewMode).toBe('json_sample');
    const parsed = JSON.parse(r.responsePreview) as { data: Array<{ blob: string; n: number }> };
    expect(parsed.data[0].blob.length).toBeLessThanOrEqual(80);
    expect(parsed.data[0].n).toBe(1); // number 原样
  });

  it('非 JSON content-type → text_prefix(旧行为)', () => {
    const r = makeStructureAwareResponsePreview({ body: '<html><body>hello</body></html>', contentType: 'text/html', maxChars: 10 });
    expect(r.previewMode).toBe('text_prefix');
    expect(r.responseBodyTruncated).toBe(true);
  });

  it('不以 {/[ 起头(纯文本)→ text_prefix', () => {
    const r = makeStructureAwareResponsePreview({ body: 'plain text response ' + 'x'.repeat(100), maxChars: 20 });
    expect(r.previewMode).toBe('text_prefix');
    expect(r.responsePreview.length).toBeLessThanOrEqual(20);
  });

  it('已小 JSON → full,原样不变', () => {
    const body = JSON.stringify({ err_no: 0, data: [{ id: 1, name: 'x' }] });
    const r = makeStructureAwareResponsePreview({ body, contentType: 'application/json' });
    expect(r.previewMode).toBe('full');
    expect(r.responseBodyTruncated).toBe(false);
    expect(r.responsePreview).toBe(body);
  });

  it('小体积但坏 JSON(上游已截断)→ text_prefix(交给 fix B 下游修复)', () => {
    const r = makeStructureAwareResponsePreview({ body: '{"data":[{"a":1},{"b":', contentType: 'application/json' });
    expect(r.previewMode).toBe('text_prefix');
  });

  it('body > jsonParseMaxBytes → text_prefix(不 parse 巨体)', () => {
    const huge = '[' + '1,'.repeat(60) + '1]'; // 合法 JSON 但超 tiny jsonParseMaxBytes
    const r = makeStructureAwareResponsePreview({ body: huge, contentType: 'application/json', maxChars: 10, jsonParseMaxBytes: 20 });
    expect(r.previewMode).toBe('text_prefix');
  });

  it('降级梯度:即便 3 项仍超 maxChars → 收窄到更少项/更短字符串直到 ≤ maxChars', () => {
    // 每项含长字符串,3 项 × 长串远超极小 maxChars,强制走 3→2→1 / 160→80→30 梯度。
    const body = JSON.stringify({ data: Array.from({ length: 10 }, (_, i) => ({ t: 'y'.repeat(200), i })) });
    const r = makeStructureAwareResponsePreview({ body, contentType: 'application/json', maxChars: 120 });
    expect(r.previewMode).toBe('json_sample');
    expect(r.responsePreview.length).toBeLessThanOrEqual(120);
    // 仍是合法 JSON。
    expect(() => JSON.parse(r.responsePreview)).not.toThrow();
  });

  it('顶层数组超 maxChars → json_sample、≤3 元素、合法', () => {
    const body = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: i, title: `t${i}` })));
    const r = makeStructureAwareResponsePreview({ body, contentType: 'application/json', maxChars: 100 });
    expect(r.previewMode).toBe('json_sample');
    const parsed = JSON.parse(r.responsePreview) as unknown[];
    expect(parsed.length).toBeLessThanOrEqual(3);
  });

  it('深度超 maxDepth → 深层容器置空,预览仍合法', () => {
    const body = JSON.stringify({ a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } }, pad: 'p'.repeat(200) });
    const r = makeStructureAwareResponsePreview({ body, contentType: 'application/json', maxChars: 150, maxDepth: 2 });
    expect(() => JSON.parse(r.responsePreview)).not.toThrow();
  });
});

describe('buildMergedResponseSummary · bounded-union 跨调用字段合并', () => {
  // 同 endpoint(article_rank 形状)两次调用:body-A 只有 content_counter.view,body-B 额外有 content_counter.share。
  const bodyA = JSON.stringify({
    err_no: 0, err_msg: 'success',
    data: [{ content: { content_id: '1', title: 'A 篇' }, content_counter: { view: 100, like: 5 }, author: { name: '作者甲' } }],
  });
  const bodyB = JSON.stringify({
    err_no: 0, err_msg: 'success',
    data: [{ content: { content_id: '2', title: 'B 篇' }, content_counter: { view: 200, like: 8, share: 3 }, author: { name: '作者乙' } }],
  });

  it('字段并集:body-A 有 view、body-B 额外有 share → 合并 recommendedColumns 含二者(+ author.name)', () => {
    const s = buildMergedResponseSummary(
      [{ body: bodyA, status: 200, paramSig: 'type=hot' }, { body: bodyB, status: 200, paramSig: 'type=new' }],
      'generate',
    );
    expect(s.recommendedRowPath).toBe('data');
    expect(s.parsedBodyCount).toBe(2);
    const paths = s.recommendedColumns!.map((c) => c.path);
    // union:两次调用的指标都进 columns(view 在两体、share 只在 B)
    expect(paths).toContain('content_counter.view');
    expect(paths).toContain('content_counter.share');
    // 作者跨子对象也在
    expect(paths).toContain('author.name');
    // itemFields 也体现并集
    const dataArr = s.arrays!.find((a) => a.path === 'data')!;
    const itemPaths = dataArr.itemFields.map((f) => f.path);
    expect(itemPaths).toEqual(expect.arrayContaining(['content_counter.view', 'content_counter.share']));
  });

  it('覆盖率过滤:低业务价值字段仅 1/6 体出现(total>2, rate<0.5)→ 排除出 recommendedColumns', () => {
    // 6 个体:全部有 note(中性/低价值),仅 1 个额外有 misc_meta(低价值罕见字段)。
    const withMeta = JSON.stringify({ data: [{ note: 'x', misc_meta: 'rare' }] });
    const plain = JSON.stringify({ data: [{ note: 'x' }] });
    const calls = [
      { body: withMeta, status: 200, paramSig: 'p=0' },
      ...Array.from({ length: 5 }, (_, i) => ({ body: plain, status: 200, paramSig: `p=${i + 1}` })),
    ];
    const s = buildMergedResponseSummary(calls, 'generate');
    expect(s.parsedBodyCount).toBe(6);
    const paths = s.recommendedColumns!.map((c) => c.path);
    expect(paths).toContain('note');           // 6/6 覆盖 → 保留
    expect(paths).not.toContain('misc_meta');  // 1/6 覆盖 + 低价值 → 覆盖率过滤剔除
    // 但 itemFields 仍保留(只是不推荐成列)
    const itemPaths = s.arrays!.find((a) => a.path === 'data')!.itemFields.map((f) => f.path);
    expect(itemPaths).toContain('misc_meta');
    const metaField = s.arrays!.find((a) => a.path === 'data')!.itemFields.find((f) => f.path === 'misc_meta');
    // occurrence 元数据在 itemFields 上不带(FieldSchema),覆盖率语义体现在过滤结果里
    expect(metaField).toBeDefined();
  });

  it('高业务价值字段低覆盖(rate≥0.33)可破例进入,受 cap=5 限制', () => {
    // 6 个体,仅 2 个(2/6≈0.33)带 like_count(高价值)。应破 0.5 门槛进入。
    const withLike = JSON.stringify({ data: [{ title: 't', like_count: 9 }] });
    const plain = JSON.stringify({ data: [{ title: 't' }] });
    const calls = [
      { body: withLike, status: 200, paramSig: 'p=0' },
      { body: withLike, status: 200, paramSig: 'p=1' },
      ...Array.from({ length: 4 }, (_, i) => ({ body: plain, status: 200, paramSig: `p=${i + 2}` })),
    ];
    const s = buildMergedResponseSummary(calls, 'generate');
    const paths = s.recommendedColumns!.map((c) => c.path);
    expect(paths).toContain('like_count'); // 高价值 2/6=0.33 破例进入
  });

  it('噪音黑名单:err_no/debug 字段 100% 覆盖仍排除出 recommendedColumns', () => {
    const body = JSON.stringify({ data: [{ title: 't', view: 1, debug: 'trace-info', err_no: 0, request_id: 'abc' }] });
    const s = buildMergedResponseSummary(
      [{ body, status: 200, paramSig: 'p=0' }, { body, status: 200, paramSig: 'p=1' }, { body, status: 200, paramSig: 'p=2' }],
      'generate',
    );
    const paths = s.recommendedColumns!.map((c) => c.path);
    expect(paths).toContain('title');
    expect(paths).not.toContain('debug');
    expect(paths).not.toContain('err_no');
    expect(paths).not.toContain('request_id');
    // 但仍留在 itemFields(只是不推荐成列)
    const itemPaths = s.arrays!.find((a) => a.path === 'data')!.itemFields.map((f) => f.path);
    expect(itemPaths).toEqual(expect.arrayContaining(['debug', 'err_no', 'request_id']));
  });

  it('rowPath 投票:多数体 rowPath=data,少数噪音 rowPath=logs → winner=data', () => {
    const dataBody = JSON.stringify({ data: [{ title: 't', view: 1 }] });
    const logsBody = JSON.stringify({ logs: [{ ts: 1, level: 'info' }] });
    const calls = [
      { body: dataBody, status: 200, paramSig: 'p=0' },
      { body: dataBody, status: 200, paramSig: 'p=1' },
      { body: dataBody, status: 200, paramSig: 'p=2' },
      { body: logsBody, status: 200, paramSig: 'p=3' },
    ];
    const s = buildMergedResponseSummary(calls, 'generate');
    expect(s.recommendedRowPath).toBe('data');
    expect(s.rowPathWinnerRate).toBeGreaterThanOrEqual(0.6);
    expect(s.mixedRowPath).toBeFalsy();
  });

  it('rowPath 投票 <0.6 且多 rowPath 带业务字段 → mixedRowPath + reviewRequired,winner 单用', () => {
    // 两组各带业务字段的 rowPath,票数 1:1(rate=0.5 < 0.6)。
    const usersBody = JSON.stringify({ users: [{ name: 'u', follower: 3 }] });
    const postsBody = JSON.stringify({ posts: [{ title: 'p', like: 5 }] });
    const s = buildMergedResponseSummary(
      [{ body: usersBody, status: 200, paramSig: 'p=0' }, { body: postsBody, status: 200, paramSig: 'p=1' }],
      'generate',
    );
    expect(s.mixedRowPath).toBe(true);
    expect(s.reviewRequired).toBe(true);
    // 另一组数组仍列在 arrays 但不并入 recommendedColumns(只用 winner)
    expect(s.recommendedRowPath).toBeDefined();
  });

  it('类型冲突 number|string:type=并集、primaryType 取多数(平票偏 string);itemFields 保并集', () => {
    // 3 个体:count 两次是 number、一次是 string → primaryType=number、type="number|string"。
    const numBody = JSON.stringify({ data: [{ title: 't', count: 42 }] });
    const strBody = JSON.stringify({ data: [{ title: 't', count: 'N/A' }] });
    const s = buildMergedResponseSummary(
      [{ body: numBody, status: 200, paramSig: 'p=0' }, { body: numBody, status: 200, paramSig: 'p=1' }, { body: strBody, status: 200, paramSig: 'p=2' }],
      'generate',
    );
    const countField = s.arrays!.find((a) => a.path === 'data')!.itemFields.find((f) => f.path === 'count')!;
    expect(countField.type).toBe('number|string'); // itemFields 保类型并集
    // recommendedColumns 用 primaryType(多数 number)
    const countCol = s.recommendedColumns!.find((c) => c.path === 'count');
    expect(countCol?.type).toBe('number');
  });

  it('平票类型冲突偏 string:count 一次 number 一次 string → primaryType=string', () => {
    const numBody = JSON.stringify({ data: [{ title: 't', count: 42 }] });
    const strBody = JSON.stringify({ data: [{ title: 't', count: 'x' }] });
    const s = buildMergedResponseSummary(
      [{ body: numBody, status: 200, paramSig: 'p=0' }, { body: strBody, status: 200, paramSig: 'p=1' }],
      'generate',
    );
    const countCol = s.recommendedColumns!.find((c) => c.path === 'count');
    expect(countCol?.type).toBe('string');
  });

  it('采样上限:>6 个不同调用 → 最多合并 6 个体', () => {
    const calls = Array.from({ length: 12 }, (_, i) => ({
      body: JSON.stringify({ data: [{ title: `t${i}`, view: i }] }),
      status: 200,
      paramSig: `p=${i}`, // 全不同签名,避免去重折叠
    }));
    const s = buildMergedResponseSummary(calls, 'generate');
    expect(s.mergedBodyCount).toBeLessThanOrEqual(6);
    expect(s.parsedBodyCount).toBeLessThanOrEqual(6);
  });

  it('同 query-param 签名重复 → 折叠到首(几)条(去重)', () => {
    const body = JSON.stringify({ data: [{ title: 't', view: 1 }] });
    const calls = Array.from({ length: 8 }, () => ({ body, status: 200, paramSig: 'type=hot' })); // 全同签名
    const s = buildMergedResponseSummary(calls, 'generate');
    // 每签名上限 3(MERGE_MAX_BODIES_PER_SAMPLE)
    expect(s.mergedBodyCount).toBeLessThanOrEqual(3);
  });

  it('score 模式:合并 rowKeys 并集,无 recommendedColumns', () => {
    const s = buildMergedResponseSummary(
      [{ body: bodyA, status: 200, paramSig: 'type=hot' }, { body: bodyB, status: 200, paramSig: 'type=new' }],
      'score',
    );
    expect(s.rowPath).toBe('data');
    expect(s.recommendedColumns).toBeUndefined();
    expect(s.rowKeys).toEqual(expect.arrayContaining(['content_counter.view', 'content_counter.share', 'author.name']));
  });

  it('2xx 优先:非 2xx 体不当代表(status 透传)', () => {
    const errBody = JSON.stringify({ err_no: 1, err_msg: 'fail' });
    const okBody = JSON.stringify({ data: [{ title: 't', view: 1 }] });
    const s = buildMergedResponseSummary(
      [{ body: errBody, status: 500, paramSig: 'p=0' }, { body: okBody, status: 200, paramSig: 'p=1' }],
      'generate',
    );
    // 2xx 的 data 体被选为 winner rowPath
    expect(s.recommendedRowPath).toBe('data');
  });

  it('全不可解析 → 退回单体 parse:failed 兜底', () => {
    const s = buildMergedResponseSummary(
      [{ body: '<html>oops', status: 200 }, { body: 'not json', status: 200 }],
      'generate',
    );
    expect(s.parse).toBe('failed');
  });

  it('空输入 → kind=unknown', () => {
    expect(buildMergedResponseSummary([], 'generate').kind).toBe('unknown');
  });

  it('单体等价:一个体的合并结果 ≈ 单体 buildResponseSummary(recommendedColumns 一致)', () => {
    const single = buildResponseSummary(bodyA, 'generate', 200);
    const merged = buildMergedResponseSummary([{ body: bodyA, status: 200 }], 'generate');
    expect(merged.recommendedRowPath).toBe(single.recommendedRowPath);
    const mPaths = merged.recommendedColumns!.map((c) => c.path).sort();
    const sPaths = single.recommendedColumns!.map((c) => c.path).sort();
    expect(mPaths).toEqual(sPaths);
  });
});
