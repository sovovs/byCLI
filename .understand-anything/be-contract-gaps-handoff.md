# be 侧契约 gap 对齐议题(交 be / 契约 owner)

> ✅ **RESOLVED 2026-06-25** —— 两条 gap 均已处置:
> - **Gap 1**(用户拍板「改契约」):`recorder.openapi.yaml` `/recorder/init` 成功响应 **202→200**(同步,对齐 be 实际 + 前端,init 是短 FS 写)。前端零改。
> - **Gap 2**(用户拍板「契约 + 契约测试守卫」):bundle 加 `CaptureRawEntry` $def + `CaptureSample.entries` 改引它(修契约谎报);`canonical.ts` 导出 `CANONICAL_SCORING_RAW_FIELDS` + `packages/recorder-core/src/capture-contract.test.ts` 钉 `SCORING_FIELDS ⊆ CaptureRawEntry.properties`(漂移即红)。
> - **核查发现**:`timing`/`page`/`requestId` 早已不匹配但**无害**(sourceCompleteness.timing 全链不消费、requestId 有 fallback、page 结果级),故只钉评分关键字段(那些生产↔消费本就对齐)。残余:extension↔CaptureRawEntry 的 producer 侧自动校验仍缺(TS 类型不可运行时内省)。
> - 验证:bundle/openapi valid、recorder-core 62 / be 52 / 全量 unit 1259、tsc+契约漂移校验全过。详见记忆 [[frontend-be-contract-reconciliation]]。


> 来源:2026-06-25 dashboard 前端↔be **契约 reconciliation**(前端 client/类型/mock 向 be 真实契约对齐)
> 过程中发现两处 **be↔契约不一致**。前端侧已全部对齐 be 的**当前实际行为**并落地、全绿。
> 这两条是 **be / 契约侧**的待办,前端不改 be(避免撞 M7 会话)。完整背景见
> `.understand-anything/frontend-be-reconciliation-brief.md`。
>
> ⚠️ **两条都不是当前 bug**(happy path 已端到端验证通过,见 `dashboard-be/test/recorder-e2e-client.test.ts`),
> 是"契约没钉住现实"留下的定时雷。下面给现象 + 影响 + 推荐修法 + 前端耦合点。

---

## Gap 1 — `/recorder/init` 实际同步 200,但 OpenAPI 写 202(异步)

### 现状(file:line)
- be `dashboard-be/src/server.ts` `handleInit` 末尾 `json(res, 200, ok(r.data))` —— **同步 200**,直接回 `{report, dryRun}`,**不调 `createRequest`**(无 request 记录)。
- 契约 `dashboard-docs/system/adapter-recorder-system/schemas/recorder.openapi.yaml` `/recorder/init` 唯一成功响应是 **`"202"`**(init request accepted)。
- 对照:`handleAnalyze` / `handleVerify` **都** `createRequest` + 回 **202**,是真异步(轮询 `GET /recorder/requests/{id}`)。**只有 init 是同步**,是三者里的异类。

### 会导致什么
1. **OpenAPI codegen / 契约测试对 init 全错**:按 OpenAPI 生成的客户端会对 init 走"202 + 轮询 `GET /recorder/requests/{id}`",但 be 不建 request 记录 → 该轮询必然 `request_not_found`。
2. **一致性陷阱**:analyze/verify 异步、init 同步;读契约的人会假设三者都异步 → 把 init 当异步写 → 错。

### 推荐修法(二选一)
- **(A,推荐)改契约对齐现实**:OpenAPI `/recorder/init` 成功响应 `202` → `200`,描述改为同步返回 `{report, dryRun}`。
  理由:init 只是一次**短 FS 写**(原子写事务),同步合理;verify 异步是因为它 spawn runner 子进程、analyze 异步是因为它驱动浏览器链;init 没有长操作,不必异步。
- **(B)改 be 对齐契约**:`handleInit` 改 `createRequest` + 202 + 轮询(像 verify)。代价大、且对短 FS 写是过度设计。

### ⚠️ 前端耦合点(改之前必看)
前端 `dashboard/src/services/httpRecorderClient.ts` 的 `init` **已按"同步 200"实现**(用 `call` 直接拿 `{report,dryRun}`,**不轮询**)。
- 若选 (A):前端**零改**,皆大欢喜。
- 若选 (B) 把 init 改成 202 异步:**必须同步改前端** —— 把 `init` 从 `call` 改回 `callAsync`(轮询),否则前端拿到 `{accepted:true}` 当成 `{report,dryRun}`,InitStep 预览空白。

---

## Gap 2 — `/recorder/capture/read` 回**原始抓包条目**,非契约 `RecorderNetworkEntry`

### 现状(file:line)
- be `dashboard-be/src/server.ts` `handleCaptureRead`:`ctx.daemon.command({action:'network-capture-read',...})` → `const entries = r.data` → `storeSample(原始)` → 回 `{sessionId, sampleName, entries}`。**entries 是未规整的原始 CDP 条目**。
- 生产端 `extension/src/cdp.ts`:发 `requestBodyKind / responseStatus / responseContentType / responsePreview / startedAt / durationMs / page ...`。
- 消费端 `packages/recorder-core/src/canonical.ts`:读 `raw.method/url/responseStatus/responseContentType/responsePreview/requestBodyKind/requestBodyPreview/requestHeaders/startedAt/durationMs/page`,**在此处**算 `sourceCompleteness` 并产出契约的 `RecorderNetworkEntry`。
- 契约 `adapter-recorder.bundle.json` `$defs/RecorderNetworkEntry` required = `[requestId, method, url, sourceCompleteness]`,且含规整后的 host/pathname/queryParams/requestBodyShape/response/timing。

→ **规整(原始 → RecorderNetworkEntry)发生在 recorder-core rank 内部,不在 be 的 capture/read 边界**。即 capture/read 的 wire 形状 ≠ 契约 `CaptureSample.entries` 宣称的 `RecorderNetworkEntry`。

### 会导致什么
1. **契约谎报 captureRead 载荷**:`CaptureSample.entries` 契约是 `RecorderNetworkEntry`(带 `sourceCompleteness` 等),be 实际回原始 CDP 条目 → OpenAPI 消费者找不到这些字段。
2. **规整接缝隐式、无校验 —— 真正的健壮性雷**:今天 `extension/src/cdp.ts`(生产)和 `recorder-core/canonical.ts`(消费)字段名**碰巧完全一致**,所以 rank 正常。但 be capture 边界**没有任何 shape 校验**。哪天扩展抓包改个字段名(如 `responsePreview` 重命名),canonical 读不到 → `sourceCompleteness` 标缺失 → 评分下降 → **候选变少/变差,甚至 `insufficient_samples`,全程无报错、无契约测试拦截**。静默降级,排查极难。

### 推荐修法
- **(B,推荐)修契约 + 加守卫**:
  - 契约里明确 capture/read 回的是**原始 `CaptureRawEntry`**(新 $def,镜像 `extension/src/cdp.ts` 的实际字段),规整属 rank 内部产出 `RecorderNetworkEntry`;`CaptureSample.entries` 的语义随阶段区分。
  - **关键**:在 be capture 边界(或 recorder-core 入口)加一个 **shape 守卫 / 契约测试**,断言原始条目含 canonical 依赖的字段名。这样扩展抓包格式漂移会**立即失败报错**,而不是静默吃掉 rank 质量。
- **(A)be 在 capture/read 就规整成 `RecorderNetworkEntry`**:wire 直接对齐契约,但把规整提前、且 rank 需避免二次规整;改动更大。

### 生产↔消费字段对照(守卫该覆盖的)
canonical.ts 依赖:`method, url, responseStatus, responseContentType, responsePreview, responseBodyTruncated, requestBodyKind, requestBodyPreview, requestBodyTruncated, requestHeaders, startedAt, durationMs, page, requestId`
→ 守卫断言这些键在 `extension/src/cdp.ts` 输出里存在(或显式声明 optional 的容忍范围)。

---

## 附:前端这趟已落地的对齐(供 be 侧参照,别反手打穿)
- init:前端按**同步 200 + `{report,dryRun}`** 实现(见 Gap 1 耦合点)。
- verify:前端按 **202 + 轮询 `GET /recorder/requests/{id}` → `VerifySummary`** 实现(verify 保持异步即可,别动)。
- captureRead:前端 client 把原始条目映射成展示用 `NetworkEntry`(仅 UI;rank 在服务端做),Gap 2 怎么改都不影响前端展示链路。
- VerifySummary 已随 M7c 收紧成 `fieldCount`(非 `rowShape.keys`),bundle/recorder-core/前端四方一致 —— 若 be 侧还有未对齐处,以此为准。
