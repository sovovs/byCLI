import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const extensionDir = path.resolve(path.dirname(scriptPath), '..');
const repoRoot = path.resolve(extensionDir, '..');

function dottedVersionParts(version) {
  if (!/^\d+(?:\.\d+)*$/.test(version)) {
    throw new Error(`Invalid dotted version: ${version}`);
  }
  return version.split('.').map((part) => Number(part));
}

export function compareDottedVersions(left, right) {
  const leftParts = dottedVersionParts(left);
  const rightParts = dottedVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function assertReleaseTagMatchesVersion(refName, version) {
  if (!refName?.startsWith('ext-v')) return;
  const tagVersion = refName.slice('ext-v'.length);
  if (tagVersion !== version) {
    throw new Error(`Extension tag ${refName} does not match package version ${version}.`);
  }
}

export function assertExtensionVersionAdvanced({ currentVersion, latestTag, hasExtensionChanges }) {
  if (!hasExtensionChanges || !latestTag?.startsWith('ext-v')) return;
  const latestVersion = latestTag.slice('ext-v'.length);
  if (compareDottedVersions(currentVersion, latestVersion) <= 0) {
    throw new Error(
      `Extension version ${currentVersion} must be greater than latest release ${latestVersion} when extension inputs change.`,
    );
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function latestReachableExtensionTag() {
  try {
    return execFileSync('git', [
      'tag',
      '--merged',
      'HEAD',
      '--list',
      'ext-v*',
      '--sort=-v:refname',
    ], { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n').filter(Boolean)[0];
  } catch {
    return undefined;
  }
}

function extensionChangedSince(tag) {
  try {
    execFileSync('git', ['diff', '--quiet', tag, '--', 'extension'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return false;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 1) {
      return true;
    }
    throw error;
  }
}

async function main() {
  const [manifest, extensionPackage, lockfile] = await Promise.all([
    readJson(path.join(extensionDir, 'manifest.json')),
    readJson(path.join(extensionDir, 'package.json')),
    readJson(path.join(extensionDir, 'package-lock.json')),
  ]);
  const version = extensionPackage.version;
  const versions = [
    ['manifest.json', manifest.version],
    ['package-lock.json', lockfile.version],
    ['package-lock.json packages[""]', lockfile.packages?.['']?.version],
  ];
  for (const [source, candidate] of versions) {
    if (candidate !== version) {
      throw new Error(`${source} version ${candidate ?? 'missing'} does not match package.json version ${version}.`);
    }
  }

  assertReleaseTagMatchesVersion(process.env.GITHUB_REF_NAME, version);
  const latestTag = latestReachableExtensionTag();
  assertExtensionVersionAdvanced({
    currentVersion: version,
    latestTag,
    hasExtensionChanges: latestTag ? extensionChangedSince(latestTag) : false,
  });
  process.stdout.write(`Extension release version verified: ${version}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
