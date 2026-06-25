// deriveAdapterName 单测(此前零测试;真候选验证过 host/pathname 形状一致,见 be e2e)。
import { describe, it, expect } from 'vitest';
import { deriveAdapterName, slug } from './adapterName';

const mk = (host: string, pathname: string) => ({ endpoint: { host, pathname } } as never);

describe('deriveAdapterName', () => {
  it('host + 末段 pathname → site/command(真候选形状)', () => {
    expect(deriveAdapterName(mk('api.github.com', '/search/repositories'))).toBe('api-github-com/repositories');
    expect(deriveAdapterName(mk('x.com', '/api/search'))).toBe('x-com/search');
  });
  it('空 host/pathname → site/command 兜底', () => {
    expect(deriveAdapterName(mk('', ''))).toBe('site/command');
  });
  it('根路径(无路径段)→ command 兜底', () => {
    expect(deriveAdapterName(mk('foo.com', '/'))).toBe('foo-com/command');
  });
  it('特殊字符 slug 化 + 去首尾连字符', () => {
    expect(deriveAdapterName(mk('My_Site.IO', '/v2/Get-Items/'))).toBe('my-site-io/get-items');
  });
  it('产出始终是合法的两段 site/command(契约 [A-Za-z0-9_-])', () => {
    const name = deriveAdapterName(mk('a b.c!!d', '/x/@y@/'));
    expect(name.split('/')).toHaveLength(2);
    expect(name).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+$/);
  });
});

describe('slug', () => {
  it('小写 + 非字母数字归一连字符 + 去首尾', () => {
    expect(slug('Hello, World!')).toBe('hello-world');
    expect(slug('--a__b--')).toBe('a-b');
    expect(slug('')).toBe('');
  });
});
