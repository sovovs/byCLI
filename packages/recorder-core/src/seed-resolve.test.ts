// resolveSeedParams(dashboard seed 输入 → value→param 解析)单测。
// 用户输入搜索值,扫 captured queryParams 的值反推参数名;精确(trim+小写)相等、非子串。
import { describe, it, expect } from 'vitest';
import { resolveSeedParams } from './normalize.js';
import type { RecorderNetworkEntry } from './types.js';

const entry = (queryParams: Record<string, unknown>): RecorderNetworkEntry => ({
  requestId: 'r', method: 'GET', url: 'https://x/api', queryParams,
  sourceCompleteness: { responseBody: 'present' } as never,
});

describe('resolveSeedParams · value→param 解析', () => {
  it('命中:值等于 seed 的参数名被解析出来', () => {
    const entries = [entry({ q: 'apple', page: '1' })];
    expect(resolveSeedParams(entries, 'apple')).toEqual(['q']);
  });

  it('未命中:没有参数值等于 seed → 空', () => {
    expect(resolveSeedParams([entry({ q: 'banana', page: '1' })], 'apple')).toEqual([]);
  });

  it('多命中:多个参数都等于 seed → 全列(交调用方/rank 判)', () => {
    const entries = [entry({ q: 'apple', keyword: 'apple' })];
    expect(resolveSeedParams(entries, 'apple').sort()).toEqual(['keyword', 'q']);
  });

  it('跨多 entry 去重:同名参数在多条 entry 命中只出现一次', () => {
    const entries = [entry({ q: 'apple' }), entry({ q: 'apple', extra: 'x' })];
    expect(resolveSeedParams(entries, 'apple')).toEqual(['q']);
  });

  it('宽松相等:trim + 大小写不敏感', () => {
    expect(resolveSeedParams([entry({ q: 'Apple' })], '  apple ')).toEqual(['q']);
  });

  it('不做子串匹配:seed 是某参数值的子串不算命中(防分页号/含词值误判)', () => {
    expect(resolveSeedParams([entry({ page: 'apple-2', n: '12apple34' })], 'apple')).toEqual([]);
  });

  it('空 seed / 全空白 → 空(不误命中空值参数)', () => {
    expect(resolveSeedParams([entry({ q: '' })], '')).toEqual([]);
    expect(resolveSeedParams([entry({ q: '' })], '   ')).toEqual([]);
  });

  it('非字符串参数值跳过(不抛)', () => {
    expect(resolveSeedParams([entry({ n: 123 as never, q: 'apple' })], 'apple')).toEqual(['q']);
  });

  it('无 queryParams 的 entry 安全跳过', () => {
    const e: RecorderNetworkEntry = { requestId: 'r', method: 'GET', url: 'https://x', sourceCompleteness: { responseBody: 'present' } as never };
    expect(resolveSeedParams([e], 'apple')).toEqual([]);
  });
});
