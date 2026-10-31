import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'bycli-package-install-'));
const artifacts = join(temp, 'artifacts');
const project = join(temp, 'project');
const mainStage = join(temp, 'main-package');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // npm is a .cmd shim on Windows and needs shell dispatch when invoked
    // from Node's child_process API.
    shell: process.platform === 'win32',
  });
}

function pack(cwd) {
  const result = JSON.parse(run(npmCommand, [
    'pack', '--json', '--ignore-scripts', '--pack-destination', artifacts,
  ], cwd));
  assert.equal(result.length, 1);
  return {
    tarball: join(artifacts, result[0].filename),
    files: new Set(result[0].files.map(({ path }) => path)),
  };
}

try {
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(mainStage, { recursive: true });
  for (const path of [
    'package.json', 'dist', 'clis', 'cli-manifest.json', 'scripts',
    'README.md', 'README.zh-CN.md', 'LICENSE', 'NOTICE',
  ]) {
    cpSync(join(root, path), join(mainStage, path), { recursive: true });
  }
  mkdirSync(join(mainStage, 'extension'));
  for (const file of ['manifest.json', 'popup.html', 'popup.js', 'icons', 'dist']) {
    cpSync(join(root, 'extension', file), join(mainStage, 'extension', file), { recursive: true });
  }

  const core = pack(join(root, 'packages/recorder-core'));
  const main = pack(mainStage);
  assert(main.files.has('extension/dist/build-info.json'), 'bycli tarball is missing extension build metadata');

  for (const file of [
    'clis/auth/login.js',
    'clis/auth/status.js',
    'clis/auth/sites.js',
    'clis/auth/_shared.js',
    'clis/auth/_recipes.js',
    'dist/src/download/media-validation.js',
    'clis/_shared/video-submit.js',
    'clis/_shared/output-filename.js',
    'clis/weibo/_comments.js',
    'clis/weibo/_article-publish.js',
    'clis/toutiao/_article-download.js',
    'clis/toutiao/_video-stats.js',
    'clis/_shared/read-response-capture.js',
    'clis/xiaohongshu/_image-prepare.js',
    'clis/xiaohongshu/_stats.js',
    'clis/xiaohongshu/publish-video.js',
    'clis/xiaohongshu/publish-images.js',
    'clis/sohu/download.js',
    'clis/sohu/publish-video.js',
    'clis/sohu/publish-gallery.js',
    'clis/sohu/publish-article.js',
    'clis/juejin/_article-stats.js',
    'clis/juejin/publish-article.js',
    'clis/csdn/_article-receipt.js',
    'clis/csdn/publish-article.js',
  ]) {
    assert(main.files.has(file), `bycli tarball is missing native connector file ${file}`);
  }
  assert(![...main.files].some((file) => /^scripts\/verify-native-.*\.mjs$/.test(file)),
    'bycli tarball includes account-bound native connector probes');
  assert(![...main.files].some((file) => file.startsWith('artifacts/')),
    'bycli tarball includes local acceptance evidence');

  for (const file of ['dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE']) {
    assert(core.files.has(file), `recorder-core tarball is missing ${file}`);
  }
  assert(![...core.files].some((file) => file.startsWith('src/')), 'recorder-core tarball includes src/');

  writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(npmCommand, [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', core.tarball, main.tarball,
  ], project);

  const mainManifest = JSON.parse(readFileSync(join(
    project, 'node_modules/@sovovs/bycli/package.json',
  ), 'utf8'));
  assert.equal(mainManifest.dependencies?.['@sovovs/bycli-recorder-core'], '^0.1.0');
  assert.equal(mainManifest.dependencies?.['@sovovs/wechat-article-crawler'], '^1.1.3');

  const coreDirectory = join(project, 'node_modules/@sovovs/bycli-recorder-core');
  const crawlerDirectoryInstalled = join(project, 'node_modules/@sovovs/wechat-article-crawler');
  const crawlerManifest = JSON.parse(readFileSync(
    join(crawlerDirectoryInstalled, 'package.json'), 'utf8',
  ));
  assert.equal(crawlerManifest.version, '1.1.3');
  const projectRequire = createRequire(join(project, 'package.json'));
  const crawlerEntry = projectRequire.resolve('@sovovs/wechat-article-crawler');
  const crawlerModule = await import(pathToFileURL(crawlerEntry).href);
  const crawlerApi = crawlerModule.default ?? crawlerModule;
  for (const name of [
    'CrawlerError', 'createWechatApi', 'collectArticles',
    'isTrustedWechatArticleUrl', 'saveArticles',
  ]) {
    assert.ok(crawlerApi[name], `crawler root API missing ${name}`);
  }
  const recorderEntry = join(
    project, 'node_modules/@sovovs/bycli/dist/src/browser/analyze.js',
  );
  await import(pathToFileURL(recorderEntry).href);
  await import(pathToFileURL(join(coreDirectory, 'dist/index.js')).href);
  const installedRoot = join(project, 'node_modules/@sovovs/bycli');
  const { installedExtensionBuild } = await import(pathToFileURL(join(installedRoot, 'dist/src/browser/extension-build.js')).href);
  assert.equal(installedExtensionBuild().valid, true, 'installed extension artifact must match its build metadata');
  const config = join(temp, 'private-config');
  const smokeEnv = { ...process.env, BYCLI_CONFIG_DIR: config };
  const installedCli = join(installedRoot, 'dist/src/main.js');
  const authSites = JSON.parse(execFileSync(process.execPath, [installedCli, 'auth', 'sites', '-f', 'json'], {
    cwd: project, env: smokeEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  for (const platform of ['weibo', 'zhihu', 'xiaohongshu', 'juejin']) {
    assert(authSites.some(row => row.platform === platform), `installed CLI is missing auth recipe ${platform}`);
  }
  execFileSync(process.execPath, [installedCli, 'adapter', 'eject', 'weixin-channels'], { cwd: project, env: smokeEnv, stdio: 'pipe' });
  const help = execFileSync(process.execPath, [installedCli, 'weixin-channels', 'video-publish', '--help', '-f', 'json'], { cwd: project, env: smokeEnv, encoding: 'utf8' });
  assert(help.includes('retry-cover-upload'), 'ejected adapter did not load its complete dependency closure');
  console.log('package install smoke test passed');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
