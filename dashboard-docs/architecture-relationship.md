<!--
  维护说明(给未来的 Claude / 协作者):
  本文件描述 dashboard 前端、dashboard-be 后端、byCLI 主仓三者的关系与边界。
  它是“关系/边界”视角的活文档,不是契约源(契约源永远是 system/schemas/)。
  当以下任一发生变化时,必须同步更新本文件,并刷新顶部「最后核实」日期:
    - dashboard-be 从空目录开始落地(路由、技术栈、ownership 归属变化)
    - 主仓 daemon 新增/修改 /recorder/* 或浏览器能力路由
    - 前端 transport 切换机制(bootstrap / factory)变动
    - 三层 ownership 铁律或安全门禁义务调整
  相关 memory:dashboard-three-layer-split / dashboard-recorder-client-seam。
  最后核实:2026-06-25(M2 shell + 同源托管① + 联调② 已落地;**M1 导航 spike 全部 P0 + 真实链路 live no-hit PASS**;**M3 navigate/capture page lease**;**M4 rank 抽 packages/recorder-core 共享包 + be rank 接线**;**M5a analyze 抽包 + be 经 /command 收 signals**;**M5b init:纯片段抽包 + 主仓 init module + daemon /v1/init 高级端点(A' 首次落地)+ be 转发**;**M5c verify:纯片段抽包(seedArgs HMAC/parseRunnerEvent/normalize)+ 主仓 verify module + daemon /v1/verify + be 转发**;**M6a verify runner 机制:recorder-core 加 validateRunnerConfig/buildRunnerArgs 纯片段 + 主仓 src/recorder/runner/(verify-runner-main internal 命令 + 真实 spawn RunnerPort:input.json 0600/0700 + JSONL + 超时 + 字节封顶 + cleanup)+ verify.ts 默认 runner 翻真实 + main.ts internal fast-path,真实 CLI 端到端冒烟 PASS、主仓 unit 1189 + runner 22 测试全过、be 44 不回归**;**M6b browser adapter 连回 daemon 已落地:子进程直接 `new Page`(不经 BrowserBridge,避免误 spawn/重启 daemon)经 `BYCLI_DAEMON_PORT` 连回父 daemon 拿 Page、preNav、finally closeWindow;daemon 启动 `setDefaultRunnerDaemonPort(PORT)` 注入端口;marker 加 `ownerPid`+spawn 后回填 child pid;startup reap(`runner/reap.ts`:只清 ownerPid 已死真孤儿 + ps cmdline pid-reuse 守卫,SIGTERM→SIGKILL+删 temp);真实子进程冒烟连回 daemon PASS(extension_not_connected,非 not-yet/ECONNREFUSED)、runner 单测 40 全过、全量 unit 无回归(8 失败均 Wikipedia/imdb/v2ex 网络 e2e);M6b 用 default profile + ephemeral session,profile 选择留后续**;**M6c verify runner 收尾:maxConcurrency 并发封顶 + FIFO 队列(queueLimit=HIGH_LEVEL_QUEUE_LIMIT 默认 10)+ 队列满 queue_full 拒绝(429,daemon /v1/verify 映射,be envelope 已认)+ stdout buffer-until-close 严格 duplicate-result(08:67)+ 短 exit-grace 防 result 后 child 不退被误判 timeout;recorder-core RunnerConfig 加 queueLimit;runner 单测 46 全过、全量 unit 无回归。M6 三片全收口**;**M7b temp TTL + M7a HMAC 已落地:M7b 经 Codex 独立对抗复审发现并修复 age-reap 误杀活跃 run 回归(`reap.ts` 加 `effectiveLeakThresholdMs` 把年龄阈值下限封底 `timeoutMs+killGraceMs`,daemon 传 `minLeakAgeMs`;短 RECORDER_TEMP_TTL_MS 不再误杀 live verify);M7a 加 `src/recorder/runner/session-keys.ts`〔daemon 进程内存 `SessionKeyRegistry`,per-session randomBytes salt,永不过 wire、重启自动轮换 + TTL 驱逐〕,daemon /v1/verify 用 `keyFor(body.sessionId)` 替换 `daemon-${PORT}` 占位,be 转发非密 sessionId;**Codex #3 已修:verify runner JSONL 协议改走专用 fd 3(`buildRunnerArgs` 加 `--protocol-fd`、子进程 stdio `['ignore','ignore','ignore','pipe']` 把 adapter stdout/stderr 送 /dev/null),用户 console.log 再不能污染/伪造协议——真实 dist fd3 冒烟 PASS、runner 单测 69、全量 unit 1247 passed 无回归**;**Codex #2/M7c 脱敏核心 + #5 幂等防覆盖 + #4 信号 lease 释放(SIGTERM handler + cancel SIGTERM-first + `releaseActiveLease`)+ #6 owner pid-reuse 守卫(`isOwnerPidReused` startTime 探针)+ #7 子进程自看门狗(`--max-runtime-ms` 孤儿兜底)已修,Codex 7 条全清;recorder-core 56 + runner 80 + be 50 + 全量 unit 1258 全过、真实 dist 冒烟(fd3 + SIGTERM→143 + watchdog unref)PASS**;**M7c 收尾审计(Codex 二轮独立审计 4 条):execute-stage code 白名单 + hint 丢 / rowShape.keys→fieldCount 全链契约迁移(列名不出子进程)/ parseRunnerEvent 不回显 type / load 阶段 adapter-eval 错误脱敏;recorder-core 59 + runner 81 + be 51 + 全量 unit 1259 全过、契约漂移校验通过、真实 dist fieldCount 冒烟(无列名)PASS**;**M7d gates·XSS 审计(Codex 独立 gate 审计):in-scope 网页威胁已挡,加 CSP(`static.ts` script-src 'self' 'nonce' + frame-ancestors none + X-Frame-Options DENY,每响应 nonce↔inline bootstrap)+ safeEqual hash 定长无长度泄漏;Electron XSS=N/A(无 shell);残余全是 same-uid out-of-scope(daemon /v1/* + WS X-byCLI presence、static token 注入、GET 对账)已文档化;be 52 全过(+CSP 端到端测试)**;tsc+build 净。**M7 安全里程碑收尾(a/b/c/d 全落地)**;对照 dashboard-be/src(security/{gates,bootstrap}、static.ts)、packages/recorder-core/src、src/recorder/{highlevel,runner}/(runner/reap.ts、session-keys.ts、runner-port.ts、verify-runner-main.ts)、dashboard/(VerifySummary/VerifyStep)、src/daemon.ts、04-security-model.md)
-->

> 文档目录已迁移:`dashboard/docs/` → `dashboard-docs/`(system/ 子层 + TDD.md 入根),本文件与 README、schemas 均在 `dashboard-docs/`。

# dashboard 前端 / dashboard-be 后端 / byCLI 主仓 三者关系

> 视角:**关系与边界**。契约细节看 `system/schemas/`(单一来源),页面/系统设计看各自模块文档。
> 状态标注:✅ 已落地 · 🟡 骨架/设计期 · ⬜ 空/未开工。

## 一句话

byCLI 主仓提供**浏览器自动化底座**(daemon + Chrome 扩展 + browser 能力);`dashboard-be` 是计划中的 **Recorder Local Service 的 HTTP 形态**,封装主仓能力 + 补安全门禁;`dashboard` 前端是**录制工作台 UI**,只通过 `RecorderClient` 接缝访问 Local Service,默认跑 mock。

## 分层全景

```
┌──────────────────────────────────────────────────────────────┐
│  dashboard/  (前端 · Umi Max + antd 5)              ✅ 已落地    │
│  /docs 方案文档 · /workbench 8 步录制工作台                      │
│  useRecorderSession ──> RecorderClient (接口)                  │
│                          ├─ mockRecorder      ✅ 默认           │
│                          └─ httpRecorderClient 🟡 骨架,无联调   │
└───────────────────────────────┬──────────────────────────────┘
                                 │ HTTP (localhost, feature-gated)
                                 │ 仅当 sessionStorage 注入 bootstrap 时启用
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│  dashboard-be/  (Recorder Local Service 的 HTTP 形态)  🟡 M5c   │
│  已落地 shell:health/bind/confirm-auth/requests/cancel + 04 门禁 │
│  M3:navigate/capture/* 经 daemon /command(page lease+fail-fast)│
│  M4:rank 经共享包 rankSamples(capture/read 冻结样本→rank 读)   │
│  M5a:analyze 经 /command 收 signals + 纯 analyzeSite(共享包)   │
│  M5b:init 转发 daemon /v1/init(FS 写在主仓,be 只转发)        │
│  M5c:verify 转发 daemon /v1/verify(M6a 起走真实子进程 runner)  │
│  独立 ESM 进程,经 daemon bridge(不 import 主仓 src/)          │
│  全部 recorder 端点已接线(无 feature_disabled 占位)            │
│  规则:封装不重造;核心 application/domain 能力归主仓/共享包       │
└───────────────────────────────┬──────────────────────────────┘
        │ import(纯 domain 包,无 IO)        │ POST /v1/init、/v1/verify(FS/子进程高级端点)
        ▼                                     ▼
┌──────────────────────────────────────────────────────────────┐
│  packages/recorder-core/  (@sovovs/bycli-recorder-core)  ✅ M4 │
│  纯 domain:canonical/normalize/pairing/score/rank + analyze + init/verify 纯片段(零 IO)│
│  verify 纯片段含 M6a runner config 校验 + buildRunnerArgs(no shell)│
│  M9a Q2 改良A:transport-crypto(safeEqual/randomToken)+ errors(ErrorCode/RecorderError)│
│    抽进本包作单一源,be bootstrap/envelope re-export;HTTP-status 映射留传输层│
│  留尾 #3/#1a:metrics(createMetrics)+ logging(createLogger,sink 注入保零 IO)抽进本包│
│    单一源,be metrics.ts/logger.ts + wrapper-metrics.ts re-export;GET /metrics 端点留传输层│
│  主仓 + be + M9 wrapper 都 import;npm workspace 软链;84 测试 │
└──────────────────────────────────────────────────────────────┘
└───────────────────────────────┬──────────────────────────────┘
                                 │ daemon HTTP + X-byCLI header
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│  byCLI 主仓 (src/)  ✅ 浏览器自动化底座 + high-level 托管        │
│  daemon.ts: /ping /status /logs /shutdown /command             │
│             + /v1/init(M5b high-level FS 端点,A' 首次落地)     │
│             + /v1/verify(high-level 子进程端点,M6a 起走真实 runner)│
│  browser/ : navigate / analyze / capture / exec 等能力          │
│  recorder/highlevel/ : analyze(IPage 版)/ init(写文件+provenance)/ verify(委托真实 RunnerPort)│
│  recorder/runner/ (M6a): verify-runner-main(internal 命令,load+validate+run)│
│             + runner-port(spawn+JSONL+超时+字节封顶+input.json 0600/0700+cleanup)+ config│
│  recorder/http/ (M9 ✅ a+b+c): 可选 High-Level HTTP wrapper(独立 loopback server,    │
│    `internal highlevel-http` 启动,默认关,端口 19827;X-byCLI+token+Origin 门禁;     │
│    init/verify/analyze/status/health + gated /metrics 全落地〔202+自有 request registry │
│    + finish-logger/metrics〕;verify 委托 verifyAdapter+defaultRunnerPort、status 代理   │
│    runner getRunStatus、seed 不泄漏;analyze 后台 daemon-backed Page〔M6b 连回〕+       │
│    analyze_timeout/daemon_unavailable;与 daemon /v1/* 两套独立路由族 ADR-0007,直调     │
│    highlevel 模块不经 be)                                                          │
│  导航安全(M1 P0 已落地):url-policy + navigation-guard           │
│   扩展侧 Fetch before-send 拦截 + direct-CDP opt-in guardNavigation│
│  Chrome 扩展 : 经 /command + extension connection 执行浏览器动作 │
│  DEFAULT_DAEMON_PORT=19825                                      │
└──────────────────────────────────────────────────────────────┘
```

## 三者职责与边界

| 层 | 角色 | 现状 | 不该做什么 |
| --- | --- | --- | --- |
| `dashboard/` | 录制工作台 UI(ADR-0001 的「可选 localhost HTTP UI」) | ✅ 前端流程跑通,mock 驱动 | 不直接连 daemon;不持有 daemon/high-level token;不重定义契约类型 |
| `dashboard-be/` | Recorder Local Service 的 feature-gated HTTP 形态 | 🟡 M5c:health/bind/confirm-auth/cancel + navigate/capture(M3)+ rank(M4)+ analyze(M5a)+ init/verify 转发(M5b/c)全接线,无 feature_disabled 占位 | 不重造主仓已有能力;核心 application/domain/high-level 模块不留在 be 私有目录 |
| byCLI 主仓 `src/` | daemon + 扩展 + browser 能力底座 + high-level 托管;真实 Local Service 能力的最终归属 | ✅ 底座在;daemon 加 high-level `/v1/init`+`/v1/verify`(ADR-0007);high-level modules + recorder-core 共享包 | — |

## 数据流(目标形态,接后端后)

`UI 动作 → RecorderClient → (HTTP) dashboard-be /recorder/* → 主仓 daemon /command + X-byCLI → Chrome 扩展执行 → 逐层回传 RequestEnvelope`

当前形态:
- 默认:`UI 动作 → RecorderClient → mockRecorder`(内存假数据,不触达 daemon)。
- 同源托管(① 已通):be serve dashboard build 产物 + 注入 bootstrap → `UI → httpRecorderClient → be /recorder/*`,health/bind/confirm-auth/cancel 真实走通;navigate 及之后 feature_disabled(等 M1)。be→daemon /command 段待 M3。

## 联调形态约束(踩坑留痕)

- **跨源行不通**:04 章 no-CORS 设计下 be 对 OPTIONS 预检返回 404,Umi dev :8000 与 be :19826 不同源 → 预检过不了。真实浏览器联调**必须 be 同源托管**(`RECORDER_UI_DIST` 指向 dashboard/dist)。
- 同源托管时浏览器 Origin = be 自己的源,`loadConfig` 已自动把 be 自身 origin 并入 `ALLOWED_ORIGINS`。
- 真跑:`RECORDER_UI_DIST=../dashboard/dist RECORDER_PORT=19826 node dist/server.js` → 浏览器开 `http://127.0.0.1:19826/workbench`。

## transport 切换(前端唯一开关点)

- `dashboard/src/services/recorderClient.ts` 的 `getRecorderClient()` 读 `sessionStorage['__bycli_recorder_bootstrap__']`。
- 同源托管时 be 注入该 key;也可手动注入 `{enabled:true, baseUrl, token, csrfToken}`(= `FEATURE_LOCALHOST_HTTP_UI=true` + 04 章 bootstrap)→ 切 `httpRecorderClient`;缺失即回落 `mockRecorder`。
- 详见 memory `dashboard-recorder-client-seam`。

## 三条 ownership 铁律(否则三层互相打架)

1. **契约单一来源 = 整个 `system/schemas/`**(四文件并列:三个 OpenAPI〔`recorder` / `high-level` / `daemon-high-level`〕管 transport/route/envelope,`adapter-recorder.bundle.json` 管共享 `$defs`)。前端类型手写对齐,由 `dashboard/scripts/check-contract-drift.mjs` 守 ErrorCode 漂移。
2. **dashboard-be 是封装不是重造**:只放 HTTP adapter + bootstrap + 安全门禁;可复用的 application/domain/high-level 最终归主仓 `src/` 或共享包。
3. **安全门禁不可选**:实现 dashboard-be 即承担 04 章全套(只听 `127.0.0.1`、Origin allowlist、`X-Recorder` header gate、CSRF token、POST-only side-effect、启动随机 token)。不实现门禁不得对外宣称 Local Service。

## 当前阻塞(接后端前)

| # | 阻塞 | 归属 |
| --- | --- | --- |
| 1 | ~~dashboard-be 空~~ → M2 shell 已落地;~~daemon `/command` 封装~~ → **M3 已落地**(daemonBridge.command + navigate/capture 经 daemon) | dashboard-be ✅ |
| 2 | ~~M1 导航 spike~~ → **已落地**(url-policy + 扩展 Fetch 拦截 + direct-CDP guardNavigation,真实链路 live no-hit PASS) | 主仓 ✅ |
| 3 | ~~rank/analyze/init/verify feature_disabled~~ → **全接线**(M4 rank / M5a analyze / M5b init / M5c verify);~~verify 真正执行待 M6 runner~~ → **M6a non-browser + M6b browser adapter 均经真实子进程 runner 执行**(M6b:子进程连回 daemon 拿 Page,default profile);**init 原子写事务 + 崩溃恢复已补(07:95-117)** | 主仓 + dashboard-be ✅ |

M1 + M3 + M4 已落地:M1 导航 spike(主仓 URL policy + request interception)真实链路验证通过(扩展经 `chrome.debugger` arm Fetch before-send,daemon→扩展→浏览器全链路 PASS,tier=ip-observed-only,ADR-0006)。M3 把 dashboard-be 的 navigate/capture 经 daemon `/command` 接通(`daemonBridge.command` + page lease + stale fail-fast,28 测试)。M4 core engine(`src/recorder/core/`:canonical/normalize/pairing/score/rank,纯函数,fixture 12 测试全过)——经 Codex 对抗复审定 **B-revised**:默认 ScoringProfile v1 非叠加、正向上限 60 < HIGH_MIN 75,**默认 profile 下 high 不可达**(high 留给 operator-tuned profile / scoring v2),mutation hard reject + POST read-like 强制 review 已修。下一颗扣子是 **M5**(High-Level 模块:analyzeBrowser/createAdapterDraft/verifyAdapter),be 的 rank/init/verify 端点待 M4 引擎接线(rank)+ M5(init/verify)。

---

# 落地计划全景(整套系统:做了什么 / 为什么 / 接下来)

> 权威里程碑定义与验收口径见 `system/adapter-recorder-system/11-roadmap-and-acceptance.md`;实现进度细节见 memory `adapter-recorder-impl-progress.md`。本节是**给人看的一处通览**,随里程碑推进维护。
> 状态:✅ 已落地 · 🟡 部分/进行中 · ⬜ 未开工。

## 总目标(为什么做这套系统)

把"录制真实浏览器网络请求 → 生成站点 adapter → verify"做成**可复用服务 + 录制工作台 UI**。架构上拆三层(见上文):前端只经 `RecorderClient` 接缝、后端 `dashboard-be` 是 feature-gated 的 Recorder Local Service HTTP 形态、核心能力归 byCLI 主仓 `src/`。**耦合度最低**是铁律:be 经 daemon HTTP 契约调主仓,不 import 主仓源码。

## 里程碑全景(M0–M10)

| 里程碑 | 内容 | 为什么这样做 | 状态 |
| --- | --- | --- | --- |
| **M0** TDD 治理 + schemas | 契约单一来源 = `system/schemas/`(bundle `$defs` + 三 OpenAPI);依赖边界规则;ADR 清单 | 契约先行、防腐;设计变更必须落到模块文档 + 进 CI gate | ✅ |
| **M1** 导航 + URL policy spike | URL policy(canonicalize/DNS/forbidden ranges)+ request interception(before-send 拦截)+ IP tier 分级 | 11 章列为**实现期唯一硬门禁**:带登录态浏览器导航若不在请求发送前拦截,DNS rebinding/重定向会泄露内网/云元数据 | ✅ 真实链路 PASS |
| **M2** Recorder Local Service shell | be 独立 ESM 进程 + daemon bridge;health/bind/confirm-auth/requests/cancel + 04 章安全门禁全套 | 先把"外壳 + 安全门禁"立起来,导航类端点占位 feature_disabled 等 M1 | ✅ shell+同源托管+联调 |
| **M3** strict page lease + daemon client | page ownership、stale page fail-fast、capture start/read 经 daemon `/command` | M1 证明导航可安全拦截后,把 be 的 navigate/capture 从 feature_disabled 真正接到主仓 daemon | ✅ daemonBridge.command + page lease + 28 测试 |
| **M4** canonical capture + core engine | mapper(`sourceCompleteness`)、Normalize/Rank/Diff、scoreExplanation、fixture 10/10 | 核心 application/domain,归主仓 `src/` 或共享包(不留 be 私有) | ✅ src/recorder/core/ 五模块 + fixture 12 测试(Codex B-revised:默认 profile high 不可达) |
| **M5** High-Level 模块 | `analyzeBrowser` / `createAdapterDraft` / `verifyAdapter` + in-process 集成 | 把 CLI 的 analyze/init/verify 抽成可复用服务 | ✅ M5a analyze(be /command)/ M5b init(daemon /v1/init)/ M5c verify(daemon /v1/verify) |
| **M6** verify runner | JSONL 内部命令、async registry、timeout/cancel/stdout cap、input.json 安全 | verify 必须子进程隔离(adapter JS 同用户权限) | ✅ **M6a+M6b+M6c 全落地**(M6a:spawn+JSONL+超时+字节封顶+input.json 0600/0700+cleanup+non-browser 真执行;M6b:browser adapter 直接 new Page 经 BYCLI_DAEMON_PORT 连回 daemon 拿 Page + startup reap〔ownerPid 守卫〕;M6c:maxConcurrency 并发封顶 + FIFO 队列〔queueLimit〕+ queue_full 拒绝 429 + buffer-until-close 严格 duplicate-result + exit-grace;runner 46 单测全过) |
| **M7** 安全/数据策略 | CSRF/Origin/header/token 门禁、Electron XSS 防御、seedArgs HMAC、temp TTL、脱敏 | 04 章安全模型收尾 | ✅ **M7 全落地(a HMAC / b temp TTL / c 脱敏 / d gates·CSP),Codex 三轮独立审计全清**。M7b:reap age-based 清理 + 3 个 RECORDER_* 配置键 + daemon 周期 sweep(**Codex 对抗复审 #1 修复:age-reap 阈值下限封底 `timeoutMs+killGraceMs`,短 TTL 不再误杀活跃 run**)。M7a:daemon 进程内存 `SessionKeyRegistry`(per-session randomBytes salt,永不过 wire,daemon 重启自动轮换 + TTL 驱逐)替换 `daemon-${PORT}` 占位,be 转发非密 sessionId。**Codex #3 已修(运行器协议隔离)**:verify runner 协议改走专用 fd 3(`buildRunnerArgs` 加 `--protocol-fd`、子进程 stdio `['ignore','ignore','ignore','pipe']`,adapter stdin/stdout/stderr → /dev/null),用户 `console.log` 再不能污染或伪造 JSONL 协议(真实 dist fd3 冒烟 PASS)。**Codex #2/M7c 脱敏核心已落地**(`normalizeRunnerResult` 对 execute 阶段 adapter 错误 message 脱敏,按 stage 非 code 判定)。**Codex #5 已修**(`startVerify` 幂等防覆盖)。**Codex #4·#6·#7 已修**:#4 子进程 SIGTERM/SIGINT handler + cancel 改 SIGTERM-first,被杀前 best-effort 释放浏览器 lease(`releaseActiveLease`);#6 reap 加 `startTime` 探针 + `isOwnerPidReused`(ownerPid 活但启动晚于 run 创建=pid 复用=孤儿,探不到则保守不杀);#7 子进程自看门狗 `--max-runtime-ms`(孤儿场景跨平台自我终结,win32 reaper 杀不掉也兜底);真实 dist 冒烟 PASS(SIGTERM→exit143、watchdog unref 不挂正常运行)。**M7c 收尾审计已完成(Codex 二轮独立审计 4 条全处置)**:① execute 阶段 `error.code` 也是 adapter 可控→白名单收口(仅 `auth_required` 等放行,余者 collapse `adapter_runtime_error`)+ hint 一并丢;② `rowShape.keys`→**`fieldCount`**(全链契约迁移:recorder-core/bundle/dashboard,列名永不出子进程,用户拍板「严格」)+ 契约漂移校验通过;③ `parseRunnerEvent` 不再回显攻击者可控 type;④ load 阶段区分 runner 生成 vs adapter import 抛错,后者脱敏(用户拍板「Codex 套路」);**残余**:恶意 adapter `fs.writeSync(3)` 伪造仍可绕(需 out-of-process attestation,post-MVP)。**M7d gates·XSS 审计已完成(Codex 独立 gate 审计)**:in-scope 威胁(恶意网页)已挡——POST 全套门禁、读 GET header+origin+token、缺 Origin 非绕过、无 CORS、同源 token 注入受 SOP;**加 CSP**(`static.ts`:`script-src 'self' 'nonce-<每响应>'` + frame-ancestors none + X-Frame-Options DENY,addresses 04 XSS-in-UI)、safeEqual 改 hash 定长(无长度泄漏);**Electron XSS = N/A**(无 electron 依赖/shell,录制器 UI 是 be 托管 Web app);**残余全是 same-uid 本地进程(04 章 threat model 显式 out-of-scope)**:daemon /v1/* + WS 仅 X-byCLI presence、static token 注入、GET 状态对账——已文档化 + 未来加固向(daemon bearer token / 钉 extension ID)。**M7 安全里程碑收尾,Codex 三轮独立审计全清** |
| **M8** config/observability | RecorderConfig/HighLevelConfig/ScoringProfile/FeatureFlags schema、`ConfigPort.reload()` 热加载、结构化日志+requestId、metrics | 配置外置 + 特性开关 + 可观测 | ✅ **M8 全落地(a 配置整合 / b 结构化日志 / c metrics / d 热加载)**。**M8a 配置整合**(recorder-core `config.ts`:`resolveScoringProfile` 读 RANK_SCORE_* + `resolveFeatureFlags` 读 FEATURE_*/RELEASE_CHANNEL/LOCAL_EXPERIMENT_PROFILE,纯 env 注入、fail-fast config_invalid;be config 接线 + handleRank 按 FEATURE_PREVIEW_SCORING_PROFILE 选 profile〔09:170:flag off 用 default、on 才应用 override〕)。**M8b 结构化日志已落地**(be `logger.ts`:`LogFields` 只含 09 allowed 字段→forbidden〔token/cookie/body/seed〕by-construction 进不来;level 过滤 + `cycleLevel`/`setLevel` 运行时调节〔SIGUSR2〕;接 ctx + 请求完成单点 finish-logger〔operation/status/durationMs〕+ verify accepted/failed 带 requestId;LOG_LEVEL 此前死配置现已消费)。**M8c metrics 已落地**(be `metrics.ts`:counters〔name+sorted labels〕+ histograms〔count/sum/min/max〕+ snapshot,标签只放非敏感 enum;接 finish-logger〔`recorder_requests_total{operation,status,errorCode}` + `recorder_request_duration_ms` 直方图〕+ idempotency_conflict;sendFail 回填 errorCode〔顺带让 M8b 完成日志带 errorCode〕;SIGUSR1 dump 快照。daemon/runner 侧指标 be 够不着,记后续〔**留尾 #1 已清,见下**〕)。**M8d ConfigPort.reload 热加载已落地**(be `config-port.ts`:`current()`/`version()`/`reload(env)` 版本化快照;reload 校验后只换热字段〔LOG_LEVEL 即时全局回调 logger.setLevel、scoringProfile、featureFlags 热子集、poll〕、**安全/restart 字段永钉死启动值**〔token/origins/端口/registry/restart flags〕,失败保旧记 config_invalid;handleRank/createRequest 改读 `config.current()`;SIGHUP 触发)。**M8 Codex 独立复审处置**:operation label 折叠动态 requestId(`recorder.requests`,防 metric 基数无界)、移除 SIGUSR1 dump(与 Node inspector 冲突;metrics 经 snapshot()/M9)、信号 handler 全套 try/catch 隔离防崩;hot-reload pinning / forbidden 字段 / LOG_LEVEL 例外经复审确认干净。**M8 收口,下一步 M9/M10**。**留尾 #1 已清(daemon/runner 侧观测,2026-06-25)**:#1a 结构化 logger 抽进 recorder-core(sink 注入保零 IO)+ 主仓 `src/recorder/observability/logger.ts` `createRecorderLogger`〔daemon/runner 专用,CLI emoji `log` 不动〕;#1b daemon `metrics`/`logger` 单例 + `GET /metrics`〔X-byCLI 门禁同 /status〕+ /v1/* 请求完成 choke-point〔`daemon_requests_total{operation,status,errorCode}` + `daemon_verify_duration_ms`〕+ verify/requests requestId 贯通日志 + `commandResultUnknown` 计数;#1c runner-port 注入 metrics/logger〔`setDefaultRunnerObservability`,daemon 共享单例〕,settle 单点记 `runner_verify_total{status}`/`runner_timeout_total`/`runner_protocol_error_total`/`runner_queue_depth`/`runner_queue_rejected_total` + reap/sweep/session-keys 计数;#1d temp-store 容量守卫〔recorder-core `validateTempCapacity` 三键 + LOW<HIGH;runner 写 temp 前测用量,超 high watermark→sweep→仍超→`temp_store_full`(507),fail-closed;daemon `setDefaultRunnerTempGuard` 注入,仅 daemon 强制〕。真实 daemon 冒烟 PASS(/metrics 显 daemon_requests_total + startup_reap;temp 容量接线启动不破)。LOG_LEVEL 仅 daemon 启动读一次〔无 ConfigPort,热加载留后续〕 |
| **M9** 可选 High-Level HTTP wrapper | loopback wrapper、Origin/header/token 门禁、`/health` + `/v1/requests/{id}` | high-level 能力的可选 HTTP 暴露 | ✅ **M9 全落地(a+b+c)**。M9c analyze:`POST /v1/browser/analyze` 后台构造 daemon-backed `new Page`〔M6b 连回模式不经 BrowserBridge〕跑 analyzeBrowserWithTimeout,202 立即返 + 后台 finalize〔report / analyze_timeout(504,status timeout)/ daemon_unavailable(503)〕,**留尾 #2 已清:nearest-adapter registry 经 `loadAdapterRegistry()` 从 cli-manifest.json 轻量加载**〔wrapper 跳过 discovery,`getRegistry()` 在此进程为空〕;真实 dist 无 daemon 冒烟 → daemon_unavailable("fetch failed")优雅失败。27 wrapper 测试 + 真实 dist 冒烟全 PASS、全量 unit 4918 passed〔失败全网络 e2e〕。**下一步 M10 验收**。〔历史:M9a 已落地(`src/recorder/http/` 独立 loopback server,`internal highlevel-http` opt-in 启动、bind 127.0.0.1:19827;**门禁 X-byCLI + 启动随机 X-byCLI-Token + Origin allowlist**,比 daemon X-byCLI presence 强一档;`POST /v1/adapters/init`〔同步→202+自有 request registry+poll〕/`GET /v1/requests/{id}`〔ownership+TTL→404〕/`GET /health`;**Q2 改良A**:safeEqual/randomToken/ErrorCode 抽进 recorder-core〔be re-export,HTTP-status 映射留传输层,⏳待 Codex 复核〕;与 daemon /v1/* 两套独立路由族 ADR-0007;Q2 改良A 经 Codex 复核确认。**M9b verify 已落地**:`POST /v1/adapters/verify` 委托 verifyAdapter+defaultRunnerPort〔setDefaultRunnerDaemonPort 注入 daemon 端口供 browser-verify 连回拿 Page〕,handleRequestStatus 代理 runner getRunStatus+long-poll〔终态 finalize summary-only〕,keyFor 取 sessionHmacKey;**raw executionSeedArgs 绝不进 registry/202/log**〔真实 dist 子进程往返 seed canary 0 泄漏〕;gated `/metrics` 端点〔M8 复审遗留〕;23 wrapper 测试+真实 dist 冒烟 PASS〔含真 runner spawn〕、全量 unit 4913 passed〔失败全网络 e2e〕。M9c 见上。〕 |
| **M10** MVP 验收 | 11 章 MVP Acceptance 全项通过 | 收口 | ✅ **验收通过(2026-06-25)**:13 行验收表逐行映射到通过的测试/证据;三套测试全绿(recorder-core 84 / dashboard-be 73 / 主仓 4834 + 1 skipped);schema gate 本地校验通过(3 OpenAPI 3.1.0/无 nullable、bundle `$defs`、ref 全指向 bundle)。四留尾全清(#5 flag 接线 / #1a–d daemon·runner 观测 / #2 nearest-adapter / #4 fd3 forge = post-MVP)。覆盖率 ≥80% 与真 daemon e2e〔ubuntu-only〕由 CI 强制 |

## 已经做了什么(截至 2026-06-22)

- **M0/M2 已落地**:schemas 契约源 + be M2 shell(daemon bridge、5 端点、04 门禁全套、同源 UI 托管、前端↔be 联调通);前端 8 步录制工作台(mock 驱动)。
- **M1 已落地并真实链路验证**(本会话主线):
  - **为什么先做 M1**:11 章把它定为实现期唯一硬门禁——导航不安全则整条 capture 链路不能开。
  - **做了什么**:经 Codex 对抗式复审(4×P0+4×P1+3×P2)后,(a) 钉死契约口径(ADR-0006 把 `ip-observed-only` 收紧为强信任 allowlist、声明 DNS 预检不可消除 TOCTOU、11 章加 armed-before-nav + live no-hit 验收);(b) 主仓 `src/browser/url-policy.ts`+`navigation-guard.ts`(纯函数可单测);(c) 扩展侧 `extension/src/url-policy.ts`(syntax-only 镜像)+ `cdp.ts` Fetch guard + `handleNavigate` 改 blank-first→arm→navigate;(d) direct-CDP `goto` 加 opt-in `guardNavigation`。
  - **怎么验证的**:三个真实 Chrome 回归脚本(`scripts/m1-*.mjs`),direct-CDP + daemon→扩展→浏览器全链路均 live no-hit PASS(禁止目标 0 命中);111 单测全过。

## 接下来做什么

1. ✅ **M3 已落地**:`daemonBridge.command` + be navigate/capture 经 daemon `/command`,page lease ownership + stale page fail-fast,28 测试全过。
2. ✅ **M4 已落地**:`src/recorder/core/`(canonical/normalize/pairing/score/rank,纯函数)+ fixture 12 测试全过。经 Codex 对抗复审定 **B-revised**:默认 ScoringProfile v1 非叠加、正向上限 60 < HIGH_MIN 75 → 默认 profile 下 **high 不可达**(high 留给 operator-tuned profile / scoring v2,已写进 06/09);mutation hard reject + POST read-like 强制 review 已修;06/10 fixture 期望按真实 band 重核(search-get-json-list→low 45)。
3. ✅ **M5a analyze 已落地**:Codex 定托管 **A'**,但落地撞 daemon-无-Page,改 **option-1**:纯 `analyzeSite` 抽进 `packages/recorder-core`(主仓 `src/browser/analyze.ts` 改 re-export,cli.ts 不变),be `handleAnalyze` 经现有 `/command` 收 signals(navigate+exec probe+cookies+capture)→ 调纯 analyzeSite → AnalyzeReport。daemon 不动(瘦代理)。be 34 测试全过。**能力边界分治**:浏览器类(analyze)be 经 /command 编排,FS/子进程类(init/verify)待定。
4. ✅ **M5b init 已落地**:createAdapterDraft —— 纯片段抽包(validateAdapterName/renderAdapterTemplate/buildProvenanceHeader/computeDryRunDiff)+ 主仓 init module(写 report+adapter,带 provenance header + commit marker,dry-run + overwrite/shadow + responsibleUse 门禁 + config snapshot 注入)+ **daemon /v1/init 高级端点**(A' 首次真正落地 daemon high-level surface,FS 写在主仓)+ be 转发(不自己写 adapter 路径)。be 38 测试全过。**原子写事务 + 崩溃恢复已补(07:95-117)**:manifest(preparing→committed)+ atomicWrite(temp+fsync+rename+parent-dir fsync)report→adapter→marker;崩溃恢复 `recoverInitTransactions`(纯 `decideInitRecovery` 6 状态:roll-forward 写 marker / commit / quarantine 无 provenance adapter / rolled_back)daemon 启动触发,只动 manifest 引用或带 provenance header 的文件。
5. ✅ **M5c verify 已落地(接口+委托)**:纯片段抽包(deriveEvidenceSeedArgs HMAC / parseRunnerEvent / normalizeRunnerResult)+ 主仓 verify module(校验 name → 派生 evidenceSeedArgs → 委托 `RunnerPort`,M5c 给 stub 返回 runner_protocol_error)+ daemon /v1/verify + be 转发。be 41 测试全过。raw executionSeedArgs 永不入 status/report/log。**runner 本体(spawn/JSONL/隔离/input.json/超时/reap)待 M6**。
6. ✅ **M6a + M6b + M6c 全落地(M6 verify runner 全收口)**:M6a `RunnerPort` 真实子进程(spawn + JSONL + 超时/字节封顶 + 环境隔离 + input.json 0600/0700 + cleanup,non-browser 真执行);M6b browser adapter 直接 `new Page` 经 `BYCLI_DAEMON_PORT` 连回 daemon 拿 Page(不经 BrowserBridge)+ marker `ownerPid`/child pid 回填 + startup reap(`runner/reap.ts`);M6c `maxConcurrency` 并发封顶 + FIFO 队列(`queueLimit`)+ 队列满 `queue_full`(429,daemon 映射)+ stdout buffer-until-close 严格 duplicate-result(08:67)+ exit-grace。**下一颗扣子 = M7**(安全/数据策略:session-keyed HMAC、temp TTL、脱敏收尾)。✅ M5b init 原子写事务 + 崩溃恢复已补、H-002 主仓 free-form 已清(browser 从 strategy 派生;InitInput = be 派生的 derived draft inputs,03:74)。
7. ✅ **M5b 后补已落地**:init 原子写事务(txn manifest preparing→committed + atomicWrite temp/fsync/rename/parent-fsync,report→adapter→marker)+ 崩溃恢复表(`recoverInitTransactions`:roll-forward/commit/quarantine/rolled_back,纯 `decideInitRecovery` 6 状态,daemon 启动触发);H-002 清尾(browser 从 strategy 派生,COOKIE/UI⇒true)。
6. ✅ **be rank 接线已落地**:M4 引擎抽成 `packages/recorder-core`,be `POST /recorder/rank` 接 `rankSamples`;capture/read 冻结样本进 session,rank 读 A/B 算 candidates。顺带修两处 M3 状态机 bug(captureRead 允许 capture_b、captureStart 第二次 →capture_b)。
8. ✅ **留尾清理已落地(M10 前,2026-06-25)**:**#2** wrapper analyze nearest-adapter 接真 registry(`loadAdapterRegistry()` 读 cli-manifest.json);**#3** metrics 抽进 recorder-core(be+wrapper re-export,消副本 drift);**#1a–d** daemon/runner 侧观测全补(结构化 logger + metrics + temp 容量守卫,详见 M8 行);**#5** 三个 restart-only FEATURE flag 接线:`FEATURE_LOCALHOST_HTTP_UI` 真接线(be 同源托管由 flag 主控,UI_DIST 降级为「服哪个 build」)、`FEATURE_ADMIN_LOG_LEVEL_TOGGLE` 真 endpoint(`POST /recorder/admin/log-level`,flag on 才注册、走全套门禁)、`FEATURE_DIRECT_CDP_CAPTURE` 标 reserved(gate 的能力不存在,文档化 + 保留 restart-only pin);**#4** fd3 forge = post-MVP(out-of-process attestation)未做。core 84 + be 73 + 主仓 4942 unit 全过(唯一失败 imdb 网络 e2e)。
7. **post-MVP / 已知边界**:DNS rebinding 扩展侧无 DNS 关不掉,需 ADR-0006 strict proxy;scoring v2 叠加模型需新增 cap 字段;`ui/`、`api/` 文档子层待补(README 步骤 3/4);留尾 #4 fd3 forge(恶意 adapter `fs.writeSync(3)` 伪造协议,需 out-of-process attestation)。

## 相关计划文档索引

- **里程碑权威定义 + 验收**:`system/adapter-recorder-system/11-roadmap-and-acceptance.md`
- **M1 P0-1 扩展侧实现计划**(本会话):`.claude/m1-p0-1-extension-plan.md`
- **dashboard-be 实现计划(M2/M3 在 be 层)**:`dashboard-be/IMPLEMENTATION_PLAN.md`
- **实现进度总览(逐里程碑状态)**:memory `adapter-recorder-impl-progress.md`
