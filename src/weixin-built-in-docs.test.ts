import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

const forbiddenCrawlerProcessPatterns = [
  /\bfrom\s+['"](?:node:)?child_process['"]/u,
  /\brequire\(\s*['"](?:node:)?child_process['"]\s*\)/u,
  /\bimport\(\s*['"](?:node:)?child_process['"]\s*\)/u,
  /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(/u,
];

function containsForbiddenCrawlerProcess(source: string): boolean {
  return forbiddenCrawlerProcessPatterns.some(pattern => pattern.test(source));
}

describe('built-in weixin history command release artifacts', () => {
  it('keeps the production package and built-in adapter free of the legacy crawler runtime', () => {
    const packageFiles = ['package.json', 'package-lock.json']
      .map(file => fs.readFileSync(path.join(root, file), 'utf8'))
      .join('\n');
    const adapterDir = path.join(root, 'clis/weixin');
    const adapterFiles = fs.readdirSync(adapterDir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.js') && !entry.name.match(/(?:^|\.)test\.js$/u));
    const adapterSource = adapterFiles
      .map(entry => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'));

    expect(packageFiles).not.toMatch(/wechat-article-crawler|wechat-crawler/);
    expect(adapterSource.join('\n')).not.toMatch(/wechat-article-crawler|wechat-crawler/);
    expect(
      adapterFiles.filter((_, index) => containsForbiddenCrawlerProcess(adapterSource[index]!))
        .map(entry => path.relative(root, path.join(entry.parentPath, entry.name))),
    ).toEqual([]);
  });

  it.each([
    "import { spawn } from 'node:child_process'; spawn('wechat-crawler', []);",
    "const childProcess = require('child_process'); childProcess.execFile('wechat-crawler');",
    "import('node:child_process').then(({ spawnSync }) => spawnSync('wechat-crawler'));",
  ])('detects forbidden crawler process source: %s', source => {
    expect(containsForbiddenCrawlerProcess(source)).toBe(true);
  });

  it('publishes the three conditional commands with stable manifest contracts', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'cli-manifest.json'), 'utf8')) as Array<Record<string, unknown>>;
    const byName = new Map(
      manifest.filter(entry => entry.site === 'weixin').map(entry => [entry.name, entry]),
    );

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
