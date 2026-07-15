import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

const forbiddenChildProcessAccessPatterns = [
  /\bfrom\s+['"](?:node:)?child_process['"]/u,
  /\bimport\s+['"](?:node:)?child_process['"]/u,
  /\brequire\s*\(\s*['"](?:node:)?child_process['"]\s*\)/u,
  /\bimport\s*\(\s*['"](?:node:)?child_process['"]\s*\)/u,
  /\bprocess\.getBuiltinModule\(\s*['"](?:node:)?child_process['"]\s*\)/u,
];

function containsForbiddenCrawlerProcess(source: string): boolean {
  return forbiddenChildProcessAccessPatterns.some(pattern => pattern.test(source));
}

function listProductionJavaScript(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listProductionJavaScript(entryPath));
    } else if (entry.isFile()
      && entry.name.endsWith('.js')
      && !/\.(?:e2e\.)?(?:test|spec)\.js$/u.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

describe('built-in weixin history command release artifacts', () => {
  it('keeps the production package and built-in adapter free of the legacy crawler runtime', () => {
    const packageFiles = ['package.json', 'package-lock.json']
      .map(file => fs.readFileSync(path.join(root, file), 'utf8'))
      .join('\n');
    const adapterDir = path.join(root, 'clis/weixin');
    const adapterFiles = listProductionJavaScript(adapterDir);
    const adapterSource = adapterFiles
      .map(file => fs.readFileSync(file, 'utf8'));

    expect(packageFiles).not.toMatch(/wechat-article-crawler|wechat-crawler/);
    expect(adapterSource.join('\n')).not.toMatch(/wechat-article-crawler|wechat-crawler/);
    expect(
      adapterFiles.filter((_, index) => containsForbiddenCrawlerProcess(adapterSource[index]!))
        .map(file => path.relative(root, file)),
    ).toEqual([]);
  });

  it.each([
    "import { exec } from 'node:child_process'; exec('crawler');",
    "const childProcess = require('child_process'); childProcess.fork('crawler.js');",
    "import('node:child_process').then(({ exec }) => exec('crawler'));",
    "process.getBuiltinModule('child_process').fork('crawler.js');",
  ])('detects forbidden crawler process source: %s', source => {
    expect(containsForbiddenCrawlerProcess(source)).toBe(true);
  });

  it('allows adapter-local functions that happen to be named spawn or execFile', () => {
    expect(containsForbiddenCrawlerProcess(`
      function spawn(value) { return value; }
      const execFile = value => value;
      spawn('local');
      execFile('local');
    `)).toBe(false);
  });

  it('publishes the three conditional commands with stable manifest contracts', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'cli-manifest.json'), 'utf8')) as Array<Record<string, unknown>>;
    const byName = new Map(
      manifest.filter(entry => entry.site === 'weixin').map(entry => [entry.name, entry]),
    );
    for (const name of ['accounts', 'articles', 'save-articles']) {
      const command = byName.get(name) as { description?: string; args?: Array<{ help?: string }> };
      expect(command.description?.trim(), `${name} manifest description`).toBeTruthy();
      expect(command.args?.every(arg => Boolean(arg.help?.trim())), `${name} manifest arg help`).toBe(true);
    }

    expect(byName.get('accounts')).toMatchObject({
      browser: 'conditional',
      args: [
        { name: 'query', type: 'str', positional: true, required: true },
        { name: 'limit', type: 'int', default: 10 },
        { name: 'auth-source', type: 'str', default: 'browser', choices: ['browser', 'env'] },
      ],
      columns: ['nickname', 'fakeid', 'alias'],
    });
    const articles = byName.get('articles') as { args: Array<Record<string, unknown>> };
    expect(articles).toMatchObject({
      browser: 'conditional',
      columns: ['title', 'author', 'digest', 'publishedAt', 'url'],
    });
    expect(articles.args.find(arg => arg.name === 'fakeid')).toMatchObject({
      type: 'str', positional: true, required: true,
    });
    expect(articles.args.find(arg => arg.name === 'auth-source')).toMatchObject({
      type: 'str', default: 'browser', required: false, choices: ['browser', 'env'],
    });
    const saveArticles = byName.get('save-articles') as { args: Array<Record<string, unknown>> };
    expect(saveArticles).toMatchObject({
      browser: 'conditional',
      columns: ['title', 'status', 'stage', 'path', 'error', 'url'],
    });
    expect(saveArticles.args.find(arg => arg.name === 'output')).toMatchObject({
      type: 'str', default: './weixin-articles', required: false,
    });
    expect(saveArticles.args.find(arg => arg.name === 'auth-source')).toMatchObject({
      type: 'str', default: 'browser', required: false, choices: ['browser', 'env'],
    });
  });

  it('documents the built-in workflow and retires the obsolete plugin plan without deleting it', () => {
    const adapterDoc = fs.readFileSync(path.join(root, 'docs/adapters/browser/weixin.md'), 'utf8');
    const oldPlan = fs.readFileSync(path.join(root, 'docs/superpowers/plans/2026-07-14-bycli-plugin-wechat.md'), 'utf8');

    for (const required of [
      'weixin accounts', 'weixin articles', 'weixin save-articles',
      'WECHAT_TOKEN', 'WECHAT_COOKIE', 'WECHAT_FINGERPRINT',
      '部分失败', '扫码', 'fakeid',
    ]) expect(adapterDoc).toContain(required);
    expect(adapterDoc).not.toMatch(/plugin install|wechat-crawler|独立 npm/i);
    expect(oldPlan).toMatch(/Superseded/);
    expect(oldPlan).toMatch(/内置.*weixin/);
  });
});
