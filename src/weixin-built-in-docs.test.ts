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
  it('uses the published crawler root API without private or subprocess coupling', () => {
    const packageManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const adapterDir = path.join(root, 'clis/weixin');
    const adapterFiles = listProductionJavaScript(adapterDir);
    const adapterSource = adapterFiles
      .map(file => fs.readFileSync(file, 'utf8'));

    expect(packageManifest.dependencies?.['@sovovs/wechat-article-crawler'])
      .toBe('^1.1.3');
    expect(adapterSource.join('\n')).toContain(
      "import crawler from '@sovovs/wechat-article-crawler';",
    );
    expect(adapterSource.join('\n')).not.toMatch(
      /@sovovs\/wechat-article-crawler\/(?:src|bin)\//,
    );
    expect(
      adapterFiles.filter((_, index) => containsForbiddenCrawlerProcess(adapterSource[index]!))
        .map(file => path.relative(root, file)),
    ).toEqual([]);

    for (const file of [
      '_wechat/article-service.js', '_wechat/article-service.test.js',
      '_wechat/wechat-api.js', '_wechat/wechat-api.test.js',
      '_wechat/save-service.js', '_wechat/save-service.test.js',
    ]) {
      expect(fs.existsSync(path.join(adapterDir, file)), `${file} should be removed`).toBe(false);
    }

    for (const file of [
      'collections.js', 'collection-detail.js', 'user-growth.js', 'user-attributes.js',
      'freepublish-list.js', 'freepublish-get.js', 'published-articles.js', 'article-fetch.js',
      'open-platform-authorizer-info.js',
    ]) {
      expect(fs.existsSync(path.join(adapterDir, file)), `${file} should be published`).toBe(true);
    }
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

  it('publishes the history and collection commands with stable manifest contracts', () => {
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
      columns: ['title', 'author', 'digest', 'publishedAt', 'url', 'source', 'coverage'],
    });
    expect(articles.args.find(arg => arg.name === 'fakeid')).toMatchObject({
      type: 'str', positional: true, required: true,
    });
    expect(articles.args.find(arg => arg.name === 'name')?.help)
      .toBe('Official-account name; exact case-insensitive match required for browser Sogou fallback');
    expect(articles.args.find(arg => arg.name === 'auth-source')).toMatchObject({
      type: 'str', default: 'browser', required: false, choices: ['browser', 'env'],
    });
    const saveArticles = byName.get('save-articles') as { args: Array<Record<string, unknown>> };
    expect(saveArticles).toMatchObject({
      browser: 'conditional',
      columns: ['title', 'status', 'stage', 'path', 'error', 'url', 'source', 'coverage'],
    });
    expect(saveArticles.args.find(arg => arg.name === 'output')).toMatchObject({
      type: 'str', default: './weixin-articles', required: false,
    });
    expect(saveArticles.args.find(arg => arg.name === 'name')?.help)
      .toBe('Official-account name; exact case-insensitive match required for browser Sogou fallback');
    expect(saveArticles.args.find(arg => arg.name === 'auth-source')).toMatchObject({
      type: 'str', default: 'browser', required: false, choices: ['browser', 'env'],
    });

    expect(byName.get('collections')).toEqual({
      site: 'weixin',
      name: 'collections',
      description: 'List WeChat official-account content collections',
      access: 'read',
      domain: 'mp.weixin.qq.com',
      strategy: 'cookie',
      browser: true,
      args: [
        { name: 'limit', type: 'int', default: 20, required: false, help: 'Maximum number of collections to return' },
        { name: 'max-pages', type: 'int', default: 5, required: false, help: 'Maximum number of collection pages to scan' },
      ],
      columns: [
        'collectionId', 'title', 'collectionType', 'itemCount', 'views', 'continuousRead',
        'isUpdating', 'isBanned', 'isPaid', 'createdAt', 'updatedAt', 'coverUrl',
      ],
      type: 'js',
      modulePath: 'weixin/collections.js',
      sourceFile: 'weixin/collections.js',
      navigateBefore: false,
    });
    expect(byName.get('collection-detail')).toEqual({
      site: 'weixin',
      name: 'collection-detail',
      description: 'Show one WeChat content collection with its settings and items',
      access: 'read',
      domain: 'mp.weixin.qq.com',
      strategy: 'cookie',
      browser: true,
      args: [
        { name: 'collectionId', type: 'str', required: true, positional: true, help: 'Collection ID returned by weixin collections' },
        { name: 'max-pages', type: 'int', default: 5, required: false, help: 'Maximum number of collection pages to scan' },
      ],
      columns: [
        'collectionId', 'title', 'description', 'collectionType', 'coverUrl', 'itemCount',
        'createdAt', 'updatedAt', 'settingsJson', 'itemsJson',
      ],
      type: 'js',
      modulePath: 'weixin/collection-detail.js',
      sourceFile: 'weixin/collection-detail.js',
      navigateBefore: false,
    });
    expect(byName.get('user-growth')).toMatchObject({
      site: 'weixin',
      name: 'user-growth',
      access: 'write',
      strategy: 'cookie',
      browser: true,
      args: [
        { name: 'begin', type: 'str', required: false },
        { name: 'end', type: 'str', required: false },
        { name: 'source', type: 'str', default: 'all', required: false },
        { name: 'output', type: 'str', required: false },
      ],
      columns: [
        'date', 'source', 'source_code', 'new_followers', 'unfollows',
        'net_new_followers', 'cumulative_followers',
        'official_xls_path', 'official_xls_size',
      ],
      modulePath: 'weixin/user-growth.js',
    });
    expect(byName.get('user-attributes')).toMatchObject({
      site: 'weixin',
      name: 'user-attributes',
      access: 'read',
      strategy: 'cookie',
      browser: true,
      args: [
        { name: 'date', type: 'str', required: false },
        {
          name: 'dimension', type: 'str', default: 'all', required: false,
          choices: ['all', 'gender', 'age', 'language', 'region', 'platform', 'brand'],
        },
      ],
      columns: ['date', 'dimension', 'name', 'code', 'parent_code', 'count', 'percent'],
      modulePath: 'weixin/user-attributes.js',
    });
    for (const name of [
      'freepublish-list', 'freepublish-get', 'published-articles', 'article-fetch',
      'open-platform-authorizer-info',
    ]) {
      expect(byName.get(name), `${name} manifest entry`).toBeDefined();
    }
    expect(byName.get('freepublish-list')).toMatchObject({
      browser: false, strategy: 'local',
      columns: ['article_id', 'article_index', 'article_type', 'title', 'author', 'digest',
        'published_url', 'thumb_media_id', 'updated_at', 'content_html',
        'artifact_paths_json', 'image_info_json'],
    });
    expect(byName.get('freepublish-get')).toMatchObject({ browser: false, strategy: 'local' });
    expect(byName.get('published-articles')).toMatchObject({ browser: 'conditional' });
    expect(byName.get('article-fetch')).toMatchObject({ browser: 'conditional' });
    expect(byName.get('open-platform-authorizer-info')).toMatchObject({
      browser: false,
      strategy: 'local',
      columns: ['appid', 'nickname', 'username', 'principal_name'],
    });
  });

  it('documents the built-in workflow and retires the obsolete plugin plan without deleting it', () => {
    const adapterDoc = fs.readFileSync(path.join(root, 'docs/adapters/browser/weixin.md'), 'utf8');
    const oldPlan = fs.readFileSync(path.join(root, 'docs/superpowers/plans/2026-07-14-bycli-plugin-wechat.md'), 'utf8');

    for (const required of [
      'weixin accounts', 'weixin articles', 'weixin save-articles',
      'weixin collections', 'weixin collection-detail',
      'weixin user-growth', 'weixin user-attributes',
      'weixin freepublish-list', 'weixin freepublish-get',
      'weixin published-articles', 'weixin article-fetch',
      'weixin open-platform-authorizer-info',
      'bycli weixin collections --limit 20 --max-pages 5 -f json',
      "bycli weixin collection-detail '<collectionId>' --max-pages 5 -f json",
      'bycli weixin user-growth --begin 2026-08-01 --end 2026-08-28 --source all -f json',
      'bycli weixin user-growth --begin 2026-08-01 --end 2026-08-28 --source all-sources --output ./weixin-user-growth -f json',
      'bycli weixin user-attributes --date 2026-08-28 --dimension all -f json',
      'new_followers', 'cumulative_followers', 'parent_code', 'percent',
      'all-sources', 'official_xls_path', 'official_xls_size',
      'only when `--output` is provided', 'aggregate “全部来源” workbook',
      '91', '100', 'brand',
      'collectionId', 'collectionType', 'AUTH_REQUIRED',
      'settingsJson', 'itemsJson', 'compact JSON strings', 'JSON.parse',
      'row-shape', 'nested business data',
      'request URL must include the temporary token',
      'Referer, output, errors, or committed artifacts',
      'redacts it',
      'WECHAT_TOKEN', 'WECHAT_COOKIE', 'WECHAT_FINGERPRINT',
      'WECHAT_APPID', 'WECHAT_APPSECRET', 'WECHAT_ACCESS_TOKEN',
      'WECHAT_COMPONENT_APPID', 'WECHAT_COMPONENT_APPSECRET', 'WECHAT_COMPONENT_VERIFY_TICKET',
      '--content none', '--content inline', '--content file',
      'api-not-configured', 'api-not-authorized',
      '部分失败', '扫码', 'fakeid', 'macOS',
    ]) expect(adapterDoc).toContain(required);
    expect(adapterDoc).not.toContain('never expose the session token');
    expect(adapterDoc.indexOf('bycli weixin collections --limit 20 --max-pages 5 -f json'))
      .toBeLessThan(adapterDoc.indexOf("bycli weixin collection-detail '<collectionId>' --max-pages 5 -f json"));
    expect(adapterDoc).not.toMatch(/plugin install|独立 npm/i);
    expect(oldPlan).toMatch(/Superseded/);
    expect(oldPlan).toMatch(/内置.*weixin/);
  });
});
