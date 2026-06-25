// 契约漂移校验(03 章:prose 与 schema 必须一起更新,contract tests must fail on drift)。
// 前端 src/types/recorder.ts 的 ErrorCode 是手写"对齐"而非生成,本脚本双向比对它与
// schema bundle 的 $defs/ErrorCode,任一侧多/缺即 exit 1。零依赖(bundle 是纯 JSON)。
//
// 用法:node scripts/check-contract-drift.mjs   (见 package.json `check:contract`)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// bundle 物理位置:已随 dashboard-docs 迁移到 dashboard-docs/system/adapter-recorder-system/。
const BUNDLE = resolve(here, '../../dashboard-docs/system/adapter-recorder-system/schemas/adapter-recorder.bundle.json');
const TYPES = resolve(here, '../src/types/recorder.ts');

/** 从 bundle 读取一个 $defs enum(字符串数组) */
function bundleEnum(bundle, defName) {
  const def = bundle.$defs?.[defName];
  if (!def?.enum) throw new Error(`bundle $defs/${defName}.enum 不存在`);
  return def.enum;
}

/** 从 TS 源解析一个字符串联合类型的字面量成员(形如 `export type X = | 'a' | 'b';`) */
function tsUnion(src, typeName) {
  const m = src.match(new RegExp(`export type ${typeName}\\s*=\\s*([\\s\\S]*?);`));
  if (!m) throw new Error(`recorder.ts 未找到 type ${typeName}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** 双向 diff;返回 {missing(schema 有 TS 缺), extra(TS 有 schema 缺)} */
function diff(schemaVals, tsVals) {
  const s = new Set(schemaVals);
  const t = new Set(tsVals);
  return {
    missing: schemaVals.filter((v) => !t.has(v)),
    extra: tsVals.filter((v) => !s.has(v)),
  };
}

/** 读 bundle $defs/<name>.required(字符串数组;缺省空) */
function bundleRequired(bundle, defName) {
  const def = bundle.$defs?.[defName];
  if (!def) throw new Error(`bundle $defs/${defName} 不存在`);
  return def.required ?? [];
}

/** 从 TS 源提取 `export interface X { ... }` 的**顶层**字段名(深度感知,忽略嵌套对象与注释)。 */
function tsInterfaceTopFields(src, name) {
  const decl = src.match(new RegExp(`export interface ${name}\\s*\\{`));
  if (!decl) throw new Error(`recorder.ts 未找到 interface ${name}`);
  const open = src.indexOf('{', decl.index);
  let depth = 0;
  let end = -1;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) { end = j; break; }
    }
  }
  const body = src.slice(open + 1, end);
  const fields = new Set();
  let d = 0;
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (d === 0) {
      const fm = line.match(/^([A-Za-z_]\w*)\??\s*:/);
      if (fm) fields.add(fm[1]);
    }
    for (const ch of line) {
      if (ch === '{') d++;
      else if (ch === '}') d = Math.max(0, d - 1);
    }
  }
  return fields;
}

const bundle = JSON.parse(readFileSync(BUNDLE, 'utf8'));
const types = readFileSync(TYPES, 'utf8');

const checks = [{ schema: 'ErrorCode', ts: 'ErrorCode' }];

let failed = false;
for (const c of checks) {
  const { missing, extra } = diff(bundleEnum(bundle, c.schema), tsUnion(types, c.ts));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`✗ ${c.ts} 与 schema $defs/${c.schema} 漂移:`);
    if (missing.length) console.error(`  schema 有、前端缺: ${missing.join(', ')}`);
    if (extra.length) console.error(`  前端有、schema 缺: ${extra.join(', ')}`);
  } else {
    console.log(`✓ ${c.ts} 与 schema $defs/${c.schema} 一致 (${bundleEnum(bundle, c.schema).length} 项)`);
  }
}

// 接口必填字段校验:前端 interface 必须含 bundle $def 的全部 required 字段(防止重塑类型时漏字段)。
// 请求侧契约(InitRequest/VerifyRequest/CaptureStartRequest required)无前端 interface 对应,
// 由 dashboard-be/test/recorder-e2e-client.test.ts 端到端真链路覆盖(真 client 真发请求过 be 校验)。
const interfaceChecks = ['RecorderReport', 'VerifySummary', 'RankCandidate'];
for (const name of interfaceChecks) {
  const required = bundleRequired(bundle, name);
  const fields = tsInterfaceTopFields(types, name);
  const missing = required.filter((f) => !fields.has(f));
  if (missing.length) {
    failed = true;
    console.error(`✗ interface ${name} 缺 schema required 字段: ${missing.join(', ')}`);
  } else {
    console.log(`✓ interface ${name} 含 schema $defs/${name} 全部 required (${required.length} 项)`);
  }
}

if (failed) {
  console.error('\n契约漂移:更新 src/types/recorder.ts 或 schema bundle,使两侧一致。');
  process.exit(1);
}
console.log('契约校验通过。');
