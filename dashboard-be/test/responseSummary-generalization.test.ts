// 泛化压测:证明 columns/rowPath/union 逻辑对**多种** API 响应形状成立(不止 juejin article_rank)。
// 每个 fixture 独立 it;断言 rowPath 精确 + 关键字段 ∈ itemFields + 关键字段 ∈ recommendedColumns +
// 噪音 ∉ columns + 不崩/不 parse:failed(不断言完整列顺序)。
import { describe, it, expect } from 'vitest';
import { buildResponseSummary, buildMergedResponseSummary } from '../src/llm/responseSummary.js';

const colPaths = (s: { recommendedColumns?: Array<{ path: string }> }) => (s.recommendedColumns ?? []).map((c) => c.path);
const itemPaths = (s: { arrays?: Array<{ itemFields: Array<{ path: string }> }> }) =>
  (s.arrays ?? []).flatMap((a) => a.itemFields.map((f) => f.path));

describe('responseSummary 泛化压测 · generate/merged 多形状', () => {
  it('1. 顶层数组 [{id,name,price}] → kind=array、rowPath=$、itemFields 含 id/name/price、columns 含 name/price', () => {
    const s = buildResponseSummary(JSON.stringify([{ id: 1, name: 'n', price: 9.9 }]), 'generate', 200);
    expect(s.parse).toBeUndefined();
    expect(s.kind).toBe('array');
    expect(s.recommendedRowPath).toBe('$');
    expect(s.rowPath).toBe('$');
    expect(itemPaths(s)).toEqual(expect.arrayContaining(['id', 'name', 'price']));
    expect(colPaths(s)).toEqual(expect.arrayContaining(['name', 'price']));
  });

  it('2. 深嵌套 {data:{result:{list:[…]}}} → rowPath=data.result.list、columns 含 title/view', () => {
    const s = buildResponseSummary(
      JSON.stringify({ data: { result: { list: [{ id: 1, title: 't', view: 3 }] } } }),
      'generate',
      200,
    );
    expect(s.parse).toBeUndefined();
    expect(s.rowPath).toBe('data.result.list');
    expect(colPaths(s)).toEqual(expect.arrayContaining(['title', 'view']));
  });

  it('3. 多竞争数组 → 选业务字段最丰富的(hot)', () => {
    const a = buildResponseSummary(
      JSON.stringify({ hot: [{ id: 1, title: 't', view: 3 }], recommend: [{ code: 1 }] }),
      'generate',
      200,
    );
    expect(a.rowPath).toBe('hot');
    expect(colPaths(a)).toEqual(expect.arrayContaining(['title', 'view']));
  });

  it('3b. 反向:业务字段在 recommend → 选 recommend', () => {
    const b = buildResponseSummary(
      JSON.stringify({ hot: [{ code: 1 }], recommend: [{ id: 1, title: 't', like: 3 }] }),
      'generate',
      200,
    );
    expect(b.rowPath).toBe('recommend');
    expect(colPaths(b)).toEqual(expect.arrayContaining(['title', 'like']));
  });

  it('4. 分页 wrapper {data:{items:[…],total,cursor,has_more}} → rowPath=data.items、columns 含 id/title、分页元数据不入 columns 而进 wrappers', () => {
    const s = buildResponseSummary(
      JSON.stringify({ data: { items: [{ id: 1, title: 't' }], total: 100, cursor: 'x', has_more: true } }),
      'generate',
      200,
    );
    expect(s.parse).toBeUndefined();
    expect(s.rowPath).toBe('data.items');
    expect(colPaths(s)).toEqual(expect.arrayContaining(['id', 'title']));
    // 分页元数据(total/cursor/has_more)是行数组的同级标量,不是行列 —— 不得入 recommendedColumns。
    const cp = colPaths(s);
    expect(cp).not.toContain('total');
    expect(cp).not.toContain('cursor');
    expect(cp).not.toContain('has_more');
    expect(cp).not.toContain('data.total');
    // Bug A 修复:同级分页标量应被捕获进 wrappers(带点分父路径)。
    const wrapPaths = (s.wrappers ?? []).map((w) => w.path);
    expect(wrapPaths).toEqual(expect.arrayContaining(['data.total', 'data.cursor', 'data.has_more']));
  });

  it('5. 扁平对象数组 [{id,title,url,time}] → columns 含 title/url/id(跨子对象均衡不误删扁平字段)', () => {
    const s = buildResponseSummary(JSON.stringify([{ id: 1, title: 't', url: 'u', time: 5 }]), 'generate', 200);
    expect(s.parse).toBeUndefined();
    expect(s.rowPath).toBe('$');
    expect(colPaths(s)).toEqual(expect.arrayContaining(['title', 'url', 'id']));
  });

  it('6. 中文字段 [{标题,作者,阅读量}] → itemFields 含全部字段、columns 非空且含这些字段', () => {
    const s = buildResponseSummary(JSON.stringify([{ 标题: '文章', 作者: '张三', 阅读量: 100 }]), 'generate', 200);
    expect(s.parse).toBeUndefined();
    expect(itemPaths(s)).toEqual(expect.arrayContaining(['标题', '作者', '阅读量']));
    expect(colPaths(s).length).toBeGreaterThan(0);
    expect(colPaths(s)).toEqual(expect.arrayContaining(['标题', '作者', '阅读量']));
  });

  it('6b. 拼音字段 [{biaoti,zuozhe,yueduliang}] → columns 非空且含这些字段', () => {
    const s = buildResponseSummary(JSON.stringify([{ biaoti: 'a', zuozhe: 'b', yueduliang: 10 }]), 'generate', 200);
    expect(s.parse).toBeUndefined();
    expect(itemPaths(s)).toEqual(expect.arrayContaining(['biaoti', 'zuozhe', 'yueduliang']));
    expect(colPaths(s).length).toBeGreaterThan(0);
    expect(colPaths(s)).toEqual(expect.arrayContaining(['biaoti', 'zuozhe', 'yueduliang']));
  });

  it('7. 类型冲突合并:count 一体 number 一体 string → itemFields type 并集、primaryType 平票偏 string、columns 仍含 count/title', () => {
    const s = buildMergedResponseSummary(
      [
        { body: JSON.stringify({ data: [{ count: 123, title: 'A' }] }), status: 200, paramSig: 'a' },
        { body: JSON.stringify({ data: [{ count: '123', title: 'B' }] }), status: 200, paramSig: 'b' },
      ],
      'generate',
    );
    expect(s.recommendedRowPath).toBe('data');
    const countField = s.arrays!.find((a) => a.path === 'data')!.itemFields.find((f) => f.path === 'count')!;
    expect(countField.type).toBe('number|string'); // itemFields 保类型并集
    const countCol = s.recommendedColumns!.find((c) => c.path === 'count');
    expect(countCol?.type).toBe('string'); // 平票偏 string
    expect(colPaths(s)).toEqual(expect.arrayContaining(['count', 'title']));
  });

  it('8. 错误响应混入合并:一体 data[] 一体 {error,code} → rowPath=data、columns 含 title、error/code 不入 columns', () => {
    const s = buildMergedResponseSummary(
      [
        { body: JSON.stringify({ data: [{ title: 'A', view: 1 }] }), status: 200, paramSig: 'a' },
        { body: JSON.stringify({ error: 'rate limit', code: 429 }), status: 429, paramSig: 'b' },
      ],
      'generate',
    );
    expect(s.recommendedRowPath).toBe('data');
    expect(colPaths(s)).toContain('title');
    expect(colPaths(s)).not.toContain('error');
    expect(colPaths(s)).not.toContain('code');
  });

  it('9. GraphQL 深嵌套 {data:{viewer:{repositories:{nodes:[…]}}}} → rowPath=data.viewer.repositories.nodes、columns 含 name/url/stargazerCount', () => {
    const s = buildResponseSummary(
      JSON.stringify({ data: { viewer: { repositories: { nodes: [{ name: 'n', url: 'u', stargazerCount: 5 }] } } } }),
      'generate',
      200,
    );
    expect(s.parse).toBeUndefined();
    expect(s.rowPath).toBe('data.viewer.repositories.nodes');
    expect(itemPaths(s)).toEqual(expect.arrayContaining(['name', 'url', 'stargazerCount']));
    expect(colPaths(s)).toEqual(expect.arrayContaining(['name', 'url', 'stargazerCount']));
  });

  it('10. 无数组单对象 {status,config:{…}} → 无 rowPath / 无 recommendedColumns(不臆造列)', () => {
    const s = buildResponseSummary(JSON.stringify({ status: 'ok', config: { theme: 'dark', version: '1' } }), 'generate', 200);
    expect(s.parse).toBeUndefined();
    expect(s.kind).toBe('object');
    expect(s.rowPath).toBeUndefined();
    expect(s.recommendedRowPath).toBeUndefined();
    expect(s.recommendedColumns ?? []).toHaveLength(0);
  });
});
