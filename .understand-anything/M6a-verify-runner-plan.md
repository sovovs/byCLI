# M6a · Verify Runner 机制(甲:先跳通链路)

## 目标
替换 `stubRunnerPort`,落地真实子进程 runner 的**机制**:async registry + spawn + JSONL + 超时/字节封顶 + input.json 安全 + cleanup。证明 `verifyAdapter → RunnerPort → spawn → JSONL → 终态` 整条委托链端到端跑通。

**留后续(M6b/c)**:子进程连回 daemon 拿 Page 执行 browser adapter、startup reap、并发封顶细化。

## 落地分片

### 1. 纯片段补 `packages/recorder-core/src/verify.ts`(已有 parse/normalize)
- 复用现有 `parseRunnerEvent`/`normalizeRunnerResult`/`deriveEvidenceSeedArgs`。
- 新增纯校验:`validateRunnerConfig`(VERIFY_RUNNER_* 范围校验,对齐 09 章,越界→config_invalid)。
- 新增 `buildRunnerArgs`(纯:requestId+name+inputPath → args 数组,无 shell string)。

### 2. 主仓 internal 命令 `bycli internal verify-runner --jsonl`(新文件 `src/recorder/runner/verify-runner-main.ts`)
- 隐藏 internal 命令(cli.ts 注册,hideHelp)。
- emit `started` → 读 input.json → load adapter(`pathToFileURL` 动态 import,复用 execution.ts 模式)→ validate → emit `result`。
- M6a:browser 类 adapter(`browser !== false`)报 `runner_protocol_error`/`auth_required` not-yet(Page 经 daemon 待 M6b);non-browser adapter 真跑 func。
- stdout 只 JSONL;stderr 诊断;唯一终态 result。

### 3. 主仓真实 RunnerPort `src/recorder/runner/runner-port.ts`(替换 stub)
- async registry:`Map<requestId, VerifyRun>`,requestId 在 spawn **前**创建。
- input.json 安全写:`mkdtempSync` 0700 → owner/mode/realpath/lstat 校验 → 0600 exclusive create(`wx`)→ 写 raw seedArgs(不进 status/log)。
- `spawn`(args 数组,no shell)→ 逐行喂 `parseRunnerEvent` → 超时(`VERIFY_RUNNER_TIMEOUT_MS`,SIGTERM graceful → `KILL_GRACE_MS` → SIGKILL)→ stdout/stderr 字节封顶截断。
- `getVerifyStatus`/`cancelVerify`(idempotent,kill child + cleanup temp)。
- cleanup:done/cancel/timeout 删 temp dir。

### 4. config 解析(主仓侧)
- 主仓加 VERIFY_RUNNER_* env 读取 + zod/手写校验(对齐 09 章默认值/范围),复用 be `config.ts` 的 `intFromEnv` 模式。

### 5. 接线
- `src/recorder/highlevel/verify.ts`:默认 runner 由 `stubRunnerPort` 改为真实 RunnerPort(保留 stub 供测试注入)。
- daemon `/v1/verify`:已接 `verifyAdapter`,自动走真实 runner;`getVerifyStatus` 经 `/v1/requests/{id}`(若需,本片可加或留 M6b)。
- `sessionHmacKey`:M6a 仍 `daemon-${PORT}` 占位(真 session-keyed HMAC 随 M7)。

## 验证
- recorder-core 新单测(validateRunnerConfig / buildRunnerArgs)。
- runner-port 集成测试:用 fixture non-browser adapter 真 spawn → 收 started+result;超时用例(慢 adapter→timeout);malformed JSONL→runner_protocol_error;cancel idempotent;input.json 权限(0600)+ cleanup 验证;raw seedArg 不出现在 status。
- daemon `/v1/verify` happy-path(non-browser adapter)。
- 全套:recorder-core 包测试 + 主仓 vitest(runner)+ be 41 测试不回归;包+be+主仓 tsc 净;包先 build 出 dist。

## 文档/记忆
- arch 文档按 per-milestone 同步 4 处(be/daemon/包/核实日期,接下来→M6b)。
- 更新 `adapter-recorder-impl-progress.md`:M6a 落地、下一颗扣子 M6b(子进程连回 daemon 跑 browser adapter + startup reap)。

## 已知 scope 边界(M6a 不做,记入下一颗扣子)
- browser adapter 真执行(子进程连回 daemon `/command` 拿 Page)→ M6b。
- startup reap(09:重启校验 marker→kill→清理)→ M6b/c。
- M5b 后补:多文件原子写事务 + 崩溃恢复表(独立于 runner)。
