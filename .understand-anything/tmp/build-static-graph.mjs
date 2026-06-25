import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const outDir = path.join(root, '.understand-anything');
const intermediate = path.join(outDir, 'intermediate');
const scan = JSON.parse(fs.readFileSync(path.join(intermediate, 'scan-result.json'), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const gitCommitHash = process.argv[2] || 'unknown';

const structureFiles = fs.readdirSync(intermediate)
  .filter((name) => /^structure-batch-\d+\.json$/.test(name))
  .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0));

const structures = new Map();
for (const file of structureFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(intermediate, file), 'utf8'));
  for (const result of data.results ?? []) structures.set(result.path, result);
}

function complexity(lines) {
  if (lines > 700) return 'complex';
  if (lines > 180) return 'moderate';
  return 'simple';
}

function nodeType(file) {
  if (file.fileCategory === 'config') return 'config';
  if (file.fileCategory === 'docs' || file.language === 'markdown') return 'document';
  if (file.fileCategory === 'infra') return 'resource';
  return 'file';
}

function layerFor(filePath) {
  if (filePath.startsWith('extension/')) return 'browser-extension';
  if (filePath.startsWith('dashboard-be/') || filePath.startsWith('src/recorder/') || filePath.startsWith('packages/recorder-core/')) return 'recorder-system';
  if (filePath.startsWith('src/browser/') || filePath === 'src/daemon.ts' || filePath.startsWith('src/commands/daemon')) return 'browser-daemon-runtime';
  if (filePath.startsWith('src/pipeline/') || filePath.startsWith('src/download/') || filePath.startsWith('src/observation/')) return 'capture-pipeline-observability';
  if (filePath.startsWith('src/')) return 'cli-core';
  if (filePath.startsWith('packages/')) return 'workspace-packages';
  if (filePath.startsWith('autoresearch/')) return 'autoresearch-evaluation';
  if (filePath.startsWith('skills/')) return 'skills';
  return 'project-config-docs';
}

const layerDefs = {
  'cli-core': ['CLI Core', 'Top-level command registration, adapter discovery, execution, output formatting, plugin management, and runtime helpers.'],
  'browser-daemon-runtime': ['Browser & Daemon Runtime', 'Local daemon, browser session routing, CDP/page abstractions, URL policy, tab targeting, and browser automation primitives.'],
  'capture-pipeline-observability': ['Capture, Pipeline & Observability', 'Network/article/media download pipeline, observation sessions, artifacts, retention, and capture processing.'],
  'browser-extension': ['Browser Bridge Extension', 'Chrome extension service worker, CDP bridge, tab leases, URL policy, and browser-side command execution.'],
  'recorder-system': ['Recorder System', 'High-level recorder services, dashboard backend, recorder-core package, sample ranking, init, analyze, and verify boundaries.'],
  'workspace-packages': ['Workspace Packages', 'Standalone workspace packages and reusable library surfaces.'],
  'autoresearch-evaluation': ['Autoresearch Evaluation', 'Research/evaluation scripts, task sets, presets, and reliability experiments.'],
  'skills': ['Skills', 'Bundled byCLI skills and references.'],
  'project-config-docs': ['Project Config & Top-Level Docs', 'Repository configuration, manifests, root documentation, release metadata, and design notes outside excluded directories.'],
};

const nodes = [];
const edges = [];
const nodeIds = new Set();
const fileNodeId = (p) => `${nodeType({ path: p }) === 'config' ? 'config' : 'file'}:${p}`;
const actualFileNodeId = new Map();

for (const file of scan.files) {
  const structure = structures.get(file.path);
  const id = `${nodeType(file)}:${file.path}`;
  actualFileNodeId.set(file.path, id);
  nodeIds.add(id);
  const functionCount = structure?.functions?.length ?? 0;
  const classCount = structure?.classes?.length ?? 0;
  const exportCount = structure?.exports?.length ?? 0;
  const tags = [...new Set([
    file.language,
    file.fileCategory,
    layerFor(file.path),
    ...(exportCount ? ['exports'] : []),
    ...(file.path.endsWith('.test.ts') || file.path.endsWith('.test.js') ? ['test'] : []),
  ])].filter(Boolean);
  nodes.push({
    id,
    type: nodeType(file),
    name: path.basename(file.path),
    filePath: file.path,
    summary: `${file.language} ${file.fileCategory} file in ${path.dirname(file.path)} with ${file.sizeLines} lines${functionCount ? `, ${functionCount} functions` : ''}${classCount ? `, ${classCount} classes` : ''}${exportCount ? `, ${exportCount} exports` : ''}.`,
    tags,
    complexity: complexity(file.sizeLines),
  });

  for (const fn of (structure?.functions ?? []).slice(0, 40)) {
    const fnId = `function:${file.path}#${fn.name}:${fn.startLine}`;
    nodeIds.add(fnId);
    nodes.push({
      id: fnId,
      type: 'function',
      name: fn.name,
      filePath: file.path,
      lineRange: [fn.startLine, fn.endLine],
      summary: `Function ${fn.name} defined in ${file.path}.`,
      tags: ['function', file.language],
      complexity: complexity((fn.endLine ?? fn.startLine) - (fn.startLine ?? 0) + 1),
    });
    edges.push({ source: id, target: fnId, type: 'contains', direction: 'forward', weight: 0.8 });
  }

  for (const cls of (structure?.classes ?? []).slice(0, 20)) {
    const clsId = `class:${file.path}#${cls.name}:${cls.startLine}`;
    nodeIds.add(clsId);
    nodes.push({
      id: clsId,
      type: 'class',
      name: cls.name,
      filePath: file.path,
      lineRange: [cls.startLine, cls.endLine],
      summary: `Class or interface ${cls.name} defined in ${file.path}.`,
      tags: ['class', file.language],
      complexity: complexity((cls.endLine ?? cls.startLine) - (cls.startLine ?? 0) + 1),
    });
    edges.push({ source: id, target: clsId, type: 'contains', direction: 'forward', weight: 0.8 });
  }
}

for (const [sourcePath, targets] of Object.entries(scan.importMap ?? {})) {
  const source = actualFileNodeId.get(sourcePath);
  if (!source) continue;
  for (const targetPath of targets) {
    const target = actualFileNodeId.get(targetPath);
    if (!target) continue;
    edges.push({
      source,
      target,
      type: 'imports',
      direction: 'forward',
      description: `${sourcePath} imports ${targetPath}`,
      weight: 0.9,
    });
  }
}

const layerNodeIds = new Map();
for (const file of scan.files) {
  const layer = layerFor(file.path);
  if (!layerNodeIds.has(layer)) layerNodeIds.set(layer, []);
  layerNodeIds.get(layer).push(actualFileNodeId.get(file.path));
}
const layers = [...layerNodeIds.entries()]
  .map(([id, ids]) => ({
    id: `layer:${id}`,
    name: layerDefs[id]?.[0] ?? id,
    description: layerDefs[id]?.[1] ?? 'Project files grouped by path and role.',
    nodeIds: ids.filter((nodeId) => nodeId && nodeIds.has(nodeId)),
  }))
  .filter((layer) => layer.nodeIds.length > 0);

function present(...ids) {
  return ids.filter((id) => nodeIds.has(id));
}

const tour = [
  {
    order: 1,
    title: 'CLI startup and command surface',
    description: 'Start at the executable entry point and command registration layer to understand how byCLI boots, discovers adapters, and exposes commands.',
    nodeIds: present('file:src/main.ts', 'file:src/cli.ts', 'file:src/commanderAdapter.ts', 'file:src/discovery.ts'),
  },
  {
    order: 2,
    title: 'Browser bridge and daemon path',
    description: 'Follow the local daemon and browser abstractions that route CLI browser commands into Chrome/CDP or the extension bridge.',
    nodeIds: present('file:src/daemon.ts', 'file:src/browser/page.ts', 'file:src/browser/cdp.ts', 'file:src/browser/daemon-client.ts'),
  },
  {
    order: 3,
    title: 'Extension-side automation',
    description: 'Inspect the Chrome extension service worker and CDP helper that manage tab leases, navigation, screenshots, cookies, and network capture.',
    nodeIds: present('file:extension/src/background.ts', 'file:extension/src/cdp.ts', 'file:extension/src/url-policy.ts', 'file:extension/src/protocol.ts'),
  },
  {
    order: 4,
    title: 'Capture and pipeline services',
    description: 'Review the pipeline, download, and observation modules that collect browser evidence and process fetched or captured content.',
    nodeIds: present('file:src/pipeline/executor.ts', 'file:src/download/index.ts', 'file:src/observation/session.ts', 'file:src/observation/artifact.ts'),
  },
  {
    order: 5,
    title: 'Recorder architecture',
    description: 'Use the recorder backend and recorder-core package to understand the high-level capture, ranking, init, analyze, and verify workflow.',
    nodeIds: present('file:dashboard-be/src/server.ts', 'file:packages/recorder-core/src/index.ts', 'file:src/recorder/highlevel/init.ts', 'file:src/recorder/highlevel/verify.ts'),
  },
].filter((step) => step.nodeIds.length > 0);

const graph = {
  version: '1.0.0',
  kind: 'codebase',
  project: {
    name: packageJson.name ?? 'OpenCLI',
    languages: scan.languages,
    frameworks: scan.frameworks,
    description: packageJson.description ?? scan.description,
    analyzedAt: new Date().toISOString(),
    gitCommitHash,
  },
  nodes,
  edges,
  layers,
  tour,
};

const corePath = pathToFileURL('/Users/lijiahui/.codex/understand-anything/understand-anything-plugin/packages/core/dist/index.js').href;
const { validateGraph } = await import(corePath);
const validation = validateGraph(graph);
const finalGraph = validation.data ?? graph;
fs.writeFileSync(path.join(outDir, 'knowledge-graph.json'), JSON.stringify(finalGraph, null, 2), 'utf8');
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({
  gitCommitHash,
  generatedAt: graph.project.analyzedAt,
  mode: 'static-script',
  sourceFiles: scan.totalFiles,
  validation: {
    success: validation.success,
    issueCount: validation.issues?.length ?? 0,
  },
}, null, 2), 'utf8');
console.log(`knowledge graph written: ${finalGraph.nodes.length} nodes, ${finalGraph.edges.length} edges, ${finalGraph.layers.length} layers`);
if (!validation.success) {
  console.error(`validation issues: ${validation.issues?.length ?? 0}`);
}
