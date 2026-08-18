import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from './output.js';

describe('output TTY detection', () => {
  const originalIsTTY = process.stdout.isTTY;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, writable: true });
    logSpy.mockRestore();
  });

  it('outputs YAML in non-TTY when format is default table', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    // commanderAdapter always passes fmt:'table' as default — this must still trigger downgrade
    render([{ name: 'alice', score: 10 }], { fmt: 'table', columns: ['name', 'score'] });
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(out).toContain('name: alice');
    expect(out).toContain('score: 10');
  });

  it('outputs table in TTY when format is default table', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    render([{ name: 'alice', score: 10 }], { fmt: 'table', columns: ['name', 'score'] });
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(out).toContain('alice');
  });

  it('respects explicit -f json even in non-TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    render([{ name: 'alice' }], { fmt: 'json' });
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(JSON.parse(out)).toEqual([{ name: 'alice' }]);
  });

  it('shows elapsed time when elapsed is 0', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    render([{ name: 'alice' }], { fmt: 'table', columns: ['name'], elapsed: 0 });
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(out).toContain('0.0s');
  });

  it('explicit -f table overrides non-TTY auto-downgrade', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    render([{ name: 'alice' }], { fmt: 'table', fmtExplicit: true, columns: ['name'] });
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    // Should be table output, not YAML
    expect(out).not.toContain('name: alice');
    expect(out).toContain('alice');
  });

  it('serialises object columns as JSON instead of [object Object]', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    const row = { id: '1', extra: { category: '后端', is_original: true } };
    for (const fmt of ['table', 'md', 'csv', 'plain']) {
      logSpy.mockClear();
      render([row], { fmt, fmtExplicit: true, columns: ['id', 'extra'] });
      const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(out, fmt).not.toContain('[object Object]');
      // csv escapes the inner quotes, so only assert on the payload itself.
      expect(out.replace(/""/g, '"'), fmt).toContain('"category":"后端"');
    }
  });

  it('quotes a JSON-serialised cell in csv so the commas stay inside one field', () => {
    render([{ id: '1', extra: { a: 1, b: 2 } }], { fmt: 'csv', fmtExplicit: true, columns: ['id', 'extra'] });
    const lines = logSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(lines[0]).toBe('id,extra');
    expect(lines[1]).toBe('1,"{""a"":1,""b"":2}"');
  });

  it('keeps array columns readable in flat formats', () => {
    render([{ tags: ['Go', 'API'] }], { fmt: 'md', fmtExplicit: true, columns: ['tags'] });
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(out).toContain('["Go","API"]');
  });

  it('prints single markdown payloads without wrapping them in a table', () => {
    render([{ markdown: '# Title\n\nBody' }], { fmt: 'md' });
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(out).toBe('# Title\n\nBody');
    expect(out).not.toContain('| markdown |');
  });
});
