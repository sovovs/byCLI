# byCLI Recorder Core npm Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `@sovovs/bycli-recorder-core@0.1.0` and repair `@sovovs/bycli@2.1.1` so a clean npm installation resolves every recorder runtime import.

**Architecture:** Keep recorder-core as the existing pure-domain workspace and publish it as a normal public scoped package. The main package declares it as a runtime dependency; a tarball-based clean-install check enforces the package boundary before the release workflow publishes recorder-core first and the main package second.

**Tech Stack:** npm workspaces, TypeScript, Node.js 22, GitHub Actions, npm provenance, npmjs, npmmirror.

---

## File map

- Create `scripts/check-package-install.mjs`: build-artifact contract check that packs both packages, installs them without workspace links, and imports a recorder entry point.
- Create `packages/recorder-core/README.md`: public package purpose, boundary, and usage.
- Create `packages/recorder-core/LICENSE`: package-local Apache-2.0 license copied exactly from the repository root.
- Modify `packages/recorder-core/package.json`: public package metadata and narrow file allowlist.
- Modify `package.json`: main version, recorder-core runtime dependency, and package-install check script.
- Modify `package-lock.json`: lock the main version and workspace dependency relationship.
- Modify `.github/workflows/release.yml`: test installable tarballs and publish workspaces in dependency order.

### Task 1: Add a failing clean-install package contract

**Files:**
- Create: `scripts/check-package-install.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing package-install checker**

Create `scripts/check-package-install.mjs` with this behavior:

```js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'bycli-package-install-'));
const artifacts = join(temp, 'artifacts');
const project = join(temp, 'project');

function run(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function pack(args) {
  const result = JSON.parse(run('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', artifacts, ...args,
  ]));
  assert.equal(result.length, 1);
  return {
    tarball: join(artifacts, result[0].filename),
    files: new Set(result[0].files.map(({ path }) => path)),
  };
}

try {
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(project, { recursive: true });
  const core = pack(['--workspace', '@sovovs/bycli-recorder-core']);
  const main = pack([]);

  for (const file of ['dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE']) {
    assert(core.files.has(file), `recorder-core tarball is missing ${file}`);
  }
  assert(![...core.files].some((file) => file.startsWith('src/')), 'recorder-core tarball includes src/');

  writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', core.tarball, main.tarball,
  ], project);

  const mainManifest = JSON.parse(readFileSync(join(
    project, 'node_modules/@sovovs/bycli/package.json',
  ), 'utf8'));
  assert.equal(mainManifest.dependencies?.['@sovovs/bycli-recorder-core'], '^0.1.0');

  const coreDirectory = join(project, 'node_modules/@sovovs/bycli-recorder-core');
  const recorderEntry = join(
    project, 'node_modules/@sovovs/bycli/dist/src/browser/analyze.js',
  );
  await import(pathToFileURL(recorderEntry).href);
  await import(pathToFileURL(join(coreDirectory, 'dist/index.js')).href);
  console.log('package install smoke test passed');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
```

Add this root script:

```json
"check:package-install": "node scripts/check-package-install.mjs"
```

- [ ] **Step 2: Build the current artifacts**

Run:

```bash
npm run build --workspace @sovovs/bycli-recorder-core
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 3: Run the checker and verify RED**

Run:

```bash
npm run check:package-install
```

Expected: FAIL because the recorder-core tarball lacks `README.md` or `LICENSE`, includes `src/`, and the installed main manifest lacks `@sovovs/bycli-recorder-core` in `dependencies`.

### Task 2: Make both npm tarballs installable

**Files:**
- Create: `packages/recorder-core/README.md`
- Create: `packages/recorder-core/LICENSE`
- Modify: `packages/recorder-core/package.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `scripts/check-package-install.mjs`

- [ ] **Step 1: Define recorder-core public metadata**

Update `packages/recorder-core/package.json` to retain its current entry points and scripts while adding:

```json
{
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/sovovs/byCLI.git",
    "directory": "packages/recorder-core"
  },
  "engines": {
    "node": ">=20.6.0"
  },
  "publishConfig": {
    "access": "public"
  },
  "files": [
    "dist/",
    "README.md",
    "LICENSE"
  ]
}
```

- [ ] **Step 2: Add package documentation and license**

Create `packages/recorder-core/README.md`:

```md
# @sovovs/bycli-recorder-core

Pure-domain recorder engine shared by byCLI and its recorder backend.

It provides canonicalization, normalization, pairing, aggregation, scoring,
ranking, verification, configuration, logging, metrics, and shared recorder
types. It performs no browser control, HTTP serving, filesystem writes, or
process output.

```js
import { rankSamples } from '@sovovs/bycli-recorder-core';

const result = rankSamples(samples);
```

Licensed under Apache-2.0.
```

Create `packages/recorder-core/LICENSE` as an exact byte-for-byte copy of the
repository root `LICENSE`. Verify with:

```bash
cmp LICENSE packages/recorder-core/LICENSE
```

Expected: exit 0 with no output.

- [ ] **Step 3: Declare the runtime dependency and repair versions**

Update the root package metadata to:

```json
{
  "version": "2.1.1",
  "dependencies": {
    "@sovovs/bycli-recorder-core": "^0.1.0"
  }
}
```

Preserve all existing dependencies and the already committed Node engine
requirement. Regenerate only the lockfile metadata:

```bash
npm install --package-lock-only --ignore-scripts
```

Expected: the root lock entry reports `2.1.1` and depends on
`@sovovs/bycli-recorder-core: ^0.1.0`; the workspace entry remains `0.1.0`.

- [ ] **Step 4: Rebuild and verify GREEN**

Run:

```bash
npm run build --workspace @sovovs/bycli-recorder-core
npm run build
npm run check:package-install
```

Expected: PASS with `package install smoke test passed`.

- [ ] **Step 5: Commit the package contract repair**

Stage only the six package-contract files and commit:

```bash
git add package.json package-lock.json packages/recorder-core/package.json \
  packages/recorder-core/README.md packages/recorder-core/LICENSE \
  scripts/check-package-install.mjs
git commit -m "fix(release): publish recorder core dependency"
```

### Task 3: Publish workspaces in dependency order

**Files:**
- Modify: `.github/workflows/release.yml`
- Test: `scripts/check-package-install.mjs`

- [ ] **Step 1: Add release gates before publication**

After the main package build, add:

```yaml
      - name: Test recorder core
        run: npm test --workspace @sovovs/bycli-recorder-core

      - name: Verify installable npm tarballs
        run: npm run check:package-install
```

- [ ] **Step 2: Publish recorder-core before the main package**

Immediately before the existing main `npm publish` step, add:

```yaml
      - name: Publish recorder core to npm
        run: npm publish --workspace @sovovs/bycli-recorder-core --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Keep the existing main publication command as the next npm publication step.
Any recorder-core publication failure therefore stops the job before the main
package is published.

- [ ] **Step 3: Verify workflow syntax and local gates**

Run:

```bash
npm test --workspace @sovovs/bycli-recorder-core
npm run check:package-install
git diff --check
```

Expected: all tests pass, the smoke test prints its success line, and the diff
check has no output.

- [ ] **Step 4: Commit the release workflow**

```bash
git add .github/workflows/release.yml
git commit -m "ci: publish recorder core before bycli"
```

### Task 4: Run full pre-release verification

**Files:**
- Verify only; do not modify unrelated files.

- [ ] **Step 1: Run builds and type checks**

```bash
npm run build --workspace @sovovs/bycli-recorder-core
npm run typecheck --workspace @sovovs/bycli-recorder-core
npm run build
npm run typecheck
```

Expected: four commands exit 0.

- [ ] **Step 2: Run recorder-core and repository test suites**

```bash
npm test --workspace @sovovs/bycli-recorder-core
npm test
```

Expected: all tests pass with no failed projects.

- [ ] **Step 3: Re-run the distribution boundary check**

```bash
npm run check:package-install
npm pack --workspace @sovovs/bycli-recorder-core --dry-run --json --ignore-scripts
npm pack --dry-run --json --ignore-scripts
```

Expected: the smoke test passes; recorder-core contains `dist`, README, and
LICENSE but no `src`; the main manifest declares the runtime dependency.

- [ ] **Step 4: Review the release diff**

```bash
git status --short
git diff HEAD~2 --check
git diff HEAD~2 -- package.json package-lock.json \
  packages/recorder-core/package.json .github/workflows/release.yml \
  scripts/check-package-install.mjs
```

Expected: only the approved package-publication changes are present. Preserve
all earlier commits and user work.

### Task 5: Publish and verify npmjs and npmmirror

**Files:**
- External release state only.

- [ ] **Step 1: Push main and create the patch tag**

```bash
git push origin main
git tag -a v2.1.1 -m "byCLI v2.1.1"
git push origin v2.1.1
```

Expected: `main` and the annotated tag are accepted by GitHub and the Release
workflow starts. Do not retry publication locally if GitHub reports an npm
authentication failure; repair the `NPM_TOKEN` repository secret first.

- [ ] **Step 2: Verify npmjs publication order**

After the workflow finishes successfully, run:

```bash
npm view @sovovs/bycli-recorder-core version --registry=https://registry.npmjs.org
npm view @sovovs/bycli version --registry=https://registry.npmjs.org
```

Expected:

```text
0.1.0
2.1.1
```

- [ ] **Step 3: Verify a clean npmjs installation**

In a new temporary directory, run:

```bash
npm init -y
npm install @sovovs/bycli@2.1.1 --ignore-scripts --registry=https://registry.npmjs.org
node -e "import(require('node:url').pathToFileURL(require('node:path').resolve('node_modules/@sovovs/bycli/dist/src/browser/analyze.js')).href).then(()=>console.log('npmjs recorder import ok'))"
```

Expected: installation succeeds and prints `npmjs recorder import ok`.

- [ ] **Step 4: Wait for and verify npmmirror synchronization**

Poll without republishing:

```bash
npm view @sovovs/bycli-recorder-core version --registry=https://registry.npmmirror.com
npm view @sovovs/bycli version --registry=https://registry.npmmirror.com
```

Expected: `0.1.0` and `2.1.1`. Then repeat the clean installation command with
`--registry=https://registry.npmmirror.com` and expect
`npmmirror recorder import ok`.

- [ ] **Step 5: Verify final repository and release state**

```bash
git status --short
git ls-remote --tags origin refs/tags/v2.1.1 refs/tags/v2.1.1^{}
```

Expected: the worktree is clean and the peeled tag points at the verified
release commit.
