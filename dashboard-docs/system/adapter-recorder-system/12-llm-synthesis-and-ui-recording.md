# 12 · LLM Synthesis & UI-Node Recording

> 状态:**第 1 阶段(LLM 合成 MVP)已落地**(见 [[recorder-llm-synthesis-mvp]] / architecture-relationship Post-M10 行);**第 2 阶段(UI 节点录制 + 多模态喂 LLM)= 设计已定、未实现**。本模块是该方向的权威设计,实现时照此推进。

## 目标

把录制器的产物从「启发式挑接口 + 人手填 func」推进到「**综合多模态录制痕迹(UI 操作 + 截图 + API)→ LLM 判断 + 生成 adapter**」。两个核心问题:

1. **录制的数据怎么组织、怎么喂给 LLM**(第 1 阶段只喂了 API 痕迹 + 单张截图,需系统化)。
2. **UI 节点录制怎么做**(用户真实 click/input/navigate 序列,当前不存在)。

---

## A. 统一录制数据模型 —— 多轨时间线 trace

把一次录制(一个 sample,如 A)归一成**按 `ts` 排序的事件流**,直接复用主仓已有的多轨模型 `src/observation/events.ts`(`ObservationStream = action | network | console | screenshot | state | error`):

| 轨 | 事件 | 来源 |
|---|---|---|
| `user-action`(扩展 `action` 轨语义) | click(stable selector + 可见文本 + role)/ input(字段标识 + **值的 shape,脱敏**)/ submit / navigate / scroll / keydown(Enter 等关键键) | **第 2 阶段新增**(见 C) |
| `network` | method / url / pathname / status / contentType / 响应体(截断 + shape) | 已有(`network-capture-*`) |
| `screenshot` | 关键时刻 base64(jpeg) | 第 1 阶段已接(captureRead 抓 1 张),第 2 阶段每步可选 |
| `state` | 导航后 url + 可选 DOM/AX snapshot | 可选增强 |

**关键:因果对齐。** be 侧把每个 `network` 事件关联到触发它的 `user-action`(标注 `triggeredBy: <action id>`)。这样 LLM 看到的是因果链「点搜索按钮 → 触发 `GET /api/search?q=cat` → 响应 list」,而非一堆孤立请求 —— 这正是 LLM 判断「哪个接口是这步操作出来的」的依据。

> **M-UI-3 已落地(2026-06-26):** 纯函数 `packages/recorder-core/src/timeline.ts` `correlateTimeline(actions, entries, {windowMs=5000})` → 每条 network 标 `triggeredBy + confidence`。信号:**时间邻近 ×  initiator 权重**(script 1 / other .6 / parser .25 / preload .1 / 缺失 .7 中性 —— 把 autosuggest/analytics/preload 旁路压下去,Codex F2)+ 同 frame 约束(两侧都有 frameId 才生效)。扩展网络条目补 `initiatorType`/`frameId`(`requestWillBeSent`,只取 type 不取 JS stack),manifest→1.0.19。7 单测;**未接 synthesize(M-UI-4)**。注:user-action 暂无 frameId(OOPIF 跨 frame 约束待补),关联主靠 ts+initiator。

**A/B 差分仍是支柱。** A、B 两条对齐后的时间线(不同输入)让 LLM 看出「同操作序列、同 endpoint、只有输入值变」→ 精准识别动态参数,比当前纯启发式 `pairing.ts` 更鲁棒(尤其对加密/拼接参数)。

---

## B. 数据 → LLM 的组织 / 裁剪 / prompt(本方向的重点)

第 1 阶段落点在 `dashboard-be/src/llm/synthesize.ts`,以下是把它从「单接口 + 单图」演进到「多模态时间线」的策略。

### B1. 喂之前先裁剪(token 预算)
- **network**:只保留与候选 endpoint 同 path 的请求 + 响应体截断(MVP 已 4000 char);其余请求降为一行摘要(method+path+status)。
- **user-action**:序列化成简洁步骤行,不带海量 DOM(只 selector + 文本 + 值 shape)。
- **screenshot**:**选 1–3 张关键截图**(操作起点 / 触发接口那刻 / 结果页),**不是每步都喂**(image token 贵)。
- **预估**:用 `messages.count_tokens` 预估,超预算则进一步降采样(先丢非候选 network 详情,再减截图)。

> **M-UI-4 已落地(2026-06-26):** `synthesize.ts` 的 `SynthesisSample` 加 `actions`;`buildSampleSummary(sample, candidate)` 用 `correlateTimeline` 把候选 endpoint 的每次调用标 `triggeredBy`(指向触发它的操作)+ `triggerConfidence`,prompt 现含**每样本的操作序列**(type/selector/valueShape/text/key,cap 50)+ **因果标注的 endpointCalls**(裁掉旁路,只留候选相关 + 4000 字响应体)+ 截图。be `handleInit` 把 `stored.actions` 传进 synthesize。synthesize 5 单测(断言 prompt 含 triggeredBy/valueShape/keydown + `act_` 关联),Tier A 2 全绿。

> **LLM 接入 + 网关兼容(2026-06-26):** 配置 `RECORDER_LLM_API_KEY` / `RECORDER_LLM_BASE_URL`(第三方 Anthropic 兼容网关,如 `api.ikuncode.cc`)/ `RECORDER_LLM_MODEL`(默认 `claude-opus-4-8`)/ `FEATURE_LLM_SYNTHESIS`,全在 `config.ts`,SDK `new Anthropic({apiKey, baseURL, authToken:null})`。**刻意用 `RECORDER_LLM_*` 项目命名空间(不用 `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`)**——避免与 Claude Code 等在 shell 预置的同名 env 冲突(`node --env-file` 不覆盖已存在 env);`authToken:null` 挡住 SDK 自动读 `ANTHROPIC_AUTH_TOKEN`。**实测发现第三方网关不支持 `output_config`(structured output)+ `thinking:adaptive`** → 改用**可移植方案**:plain `messages.create` + prompt 要求只输出 JSON + `extractJson` 稳健解析(剥 ``` 围栏 + 取首尾 `{}`)。真 Anthropic 与网关都通。gated live 实测 `BYCLI_LLM_LIVE=1`(`test/llm-live.test.ts`,key 走 env):①原始连通 ✓ ②完整合成生成合理 func/columns ✓。

### B2. prompt 结构
- **system**:角色 + byCLI adapter DSL 约束(func 签名、fetch 优先、columns 形状、不带 import / 不带 `cli()` 包裹 —— 那层归模板)。
- **user content**:`[ text(候选 endpoint + 两条对齐时间线 + 因果标注) , image(A 关键截图) , image(B 关键截图) ]`。
- **structured output**(`output_config.format` json_schema,MVP 已用):`{ funcBody, columns, description, access }`,可加 `confidence` 让模型自评。

### B3. 判断 vs 生成(可选拆两调)
- MVP = **单调**:启发式 `rank` 选候选 + LLM 只生成 func。
- 第 2 阶段可让 **LLM 也参与判断**:把对齐时间线喂进去,让模型从因果链排序/确认候选(增强或复核启发式 rank)。**但必须保留启发式 `rank` 作 fallback**(确定性、可单测,符合 06 章 deterministic 原则)—— LLM 判断走 feature-gate,失败/关闭即退回启发式。

---

## C. UI 节点录制(第 2 阶段实现方案)

### 能力现状(调研结论)
扩展经 `chrome.debugger`(CDP)。**无 DOM 事件监听**:现有 click/type 全是 agent **合成**(`Input.dispatch*`),非监听用户;`exec` 走 `Runtime.evaluate` 一次性求值,无长驻监听回传通道;manifest **无 `content_scripts` / `webRequest`**。`CDP_ALLOWLIST`(`extension/src/background.ts`)有 `Runtime.enable`,但**无 `Runtime.addBinding`**;`registerListeners`(`extension/src/cdp.ts`)的 `chrome.debugger.onEvent` 订阅了 `Network.*` / `Runtime.executionContext*`,**未订阅 `Runtime.bindingCalled`**。

### 推荐路线 A — CDP Runtime binding(复刻 network-capture 模式,不加页面权限)
> **M-UI-1 已落地(2026-06-26):** `extension/src/ui-capture.ts`(纯:`UI_LISTENER_SOURCE` 注入脚本 + `parseUiEvent` 归一,7 单测)+ `cdp.ts`(`startUiCapture`/`readUiCapture` + `uiCaptures` ring-cap + `Runtime.bindingCalled` 分支 + teardown 清理)+ `background.ts`(`ui-capture-start/read` handler)+ `protocol.ts` action。manifest→1.0.18,扩展 91 测试全绿。**修正:无需改 CDP_ALLOWLIST**(专用 handler 直接 `sendCommand`,绕过白名单,同 `Network.enable`)。**仍未验证:CSP/注入世界/OOPIF 真 Chrome 行为(Codex F3)→ 随 M-UI-2 e2e 做 spike。**
1. ~~`CDP_ALLOWLIST` 加 `Runtime.addBinding`~~(不需要)。`startUiCapture` 直接 `Runtime.enable`+`Page.enable`+`Runtime.addBinding`+`Page.addScriptToEvaluateOnNewDocument`(覆盖后续导航)+`Runtime.evaluate`(覆盖当前已开页,脚本内防重复装)。
2. 录制开始(对照 `startNetworkCapture`):daemon 经扩展 `Runtime.addBinding({name:'__bycli_ui'})` 注册全局回传函数 + `Page.addScriptToEvaluateOnNewDocument` 注入监听脚本:`addEventListener` 抓 click/input/submit/keydown,提取 **stable selector + 可见文本 + role + 值 shape**,调 `window.__bycli_ui(JSON.stringify(evt))`。
3. `registerListeners` 的 `onEvent` 加 `Runtime.bindingCalled` 分支 → push 进 per-tab `uiCaptureState` buffer(对照 `networkCaptures` Map)。
4. `ui-capture-read`(read-and-drain,对照 `readNetworkCapture`)→ daemon → be → 存进 session sample 的 `user-action` 轨。
5. be 协议 + 状态机:录制窗口期(`page_ready`、recording 中)开 ui-capture;`captureRead` 冻结样本时连同 ui-actions 一起冻结。**复用现有「开始/结束录制」两步 UX** —— 用户在 byCLI tab 操作期间,UI 事件持续被捕获。

> **M-UI-2 已落地 + 真 Chrome 验证(2026-06-26):** be `handleCaptureStart` 同发 best-effort `ui-capture-start`(失败不阻断网络录制)、`handleCaptureRead` 经 `readUiActions` 读 `ui-capture-read` 存进 `registry.storeSample` 的 `actions` 轨(captureRead 响应带 `actionsCount/actionsDropped`);daemon 通用透传无需改。**真 Chrome 双验证通过**(C1 gated e2e,example.com):① 直连 daemon 抓到 click/input(仅 valueShape email)/keydown,**raw value 不外泄**;② be-path `client.captureStart/captureRead` → `sample.actions` 录到 click+Enter。be 88 单测 + Tier A 2 全绿。**仍未覆盖:严格 CSP 站点 / OOPIF 跨 frame**(下一步用真实登录站点 spike)。

> **M-UI-OOPIF 已落地 + 真机双通道 PASS(2026-06-28,分支 recorder-iframe-capture,manifest 1.0.26):** 跨源 iframe(OOPIF)是独立 CDP target,原抓取只挂顶层 → 录不到。修法=flat autoAttach(`Target.setAutoAttach{flatten,filter:[iframe],waitForDebuggerOnStart:true}`)按 **sessionId** 纳管子 session(子事件 source 是 `{tabId,sessionId}` 非 targetId),`armChildSession` 用 `{tabId,sessionId}` 把**同一套** Network.enable + UI binding/监听脚本武装进每个 iframe 子 session(finally `runIfWaitingForDebugger` 放行防卡),事件按 sessionId 归并回父 tab buffer。**新增归属字段**:network entry + UserActionEvent 都打 `frameSessionId`(来源子 session)+ `frameUrl`(iframe 文档 URL,取自 `attachedToTarget.targetInfo.url`,脱敏)——见 CaptureRawEntry 契约。**#3 错关联防护**:`timeline.ts` 用 `frameSessionId ?? 'top'` **强相等**约束(iframe 内操作绝不关联到顶层/别的 iframe 请求);synthesize 透传两侧 frameSessionId/frameUrl。能力位 `ChildArmState{autoAttach,network,ui,overCap}` 幂等(network/ui 先后启动经 rearmChildSessions 后补)+ per-tab 50 子 session 背压 + generation guard 防 rearm/detach 复活。**真机 PASS**(juejin iframe 测试页):网络 122 条 iframe 请求带 frameSessionId+frameUrl(含 wss,token 脱敏),UI 录到 iframe 内 click/input(仅 valueShape)/keydown/submit/navigate 带 frameSessionId,顶层事件无标记。Codex 四轮对抗复审收敛。**残尾**:capture 期 per-frame exec(sendCommandInFrameTarget)仍走 `{targetId}` 直接 attach,与 flat autoAttach 互斥退路(capture 中不发 per-frame exec);彻底解需 frameId↔sessionId 探针。

### 备选路线 B — content_scripts(不推荐)
manifest 加 `content_scripts` 注入监听脚本,`chrome.runtime.sendMessage` 发到 background 缓冲。更直白但要加页面注入权限 + manifest 改动 + 跨 origin 注入策略,且与现有 `chrome.debugger` 架构不一致。仅当路线 A 的注入脚本被目标站点 CSP 拦时再考虑(需验证 `addScriptToEvaluateOnNewDocument` 注入世界是否受页面 CSP 约束)。

### 脱敏(强制)
input 值可能含密码/PII → 只存**值的 shape**(长度/类型/是否 email-like);`type=password` 字段**完全不录值**。对齐 07/M7c 脱敏链 + ADR-0005。

---

## D. 安全与边界

- **数据外发**:UI 事件 + 截图 + 真实响应外发 Anthropic API → ADR-0005 egress 条款已涵盖;UI input 值须先按 C 脱敏后才出会话。
- **注入监听**:是只读监听(不改页面行为),但仍是注入代码 → 限定 binding 名、录制结束即移除 binding + 注入脚本。
- **生成代码**:LLM 生成 func 仍走 `verify-runner` 子进程隔离 + dry-run 人工审阅 + provenance 标注(同第 1 阶段)。

---

## E. 演进路径

1. ✅ **第 1 阶段(已落地)**:API 痕迹 + 单截图 → LLM 生成 func/columns + dry-run 审阅(`synthesize.ts`)。
2. ✅ **第 2 阶段(已落地,M-UI-1~5)**:`user-action` 录制(扩展 CDP binding,M-UI-1,真 Chrome 验证)→ be 协议接 ui-capture(M-UI-2,真 Chrome be-path 验证)→ 因果对齐 `correlateTimeline`(M-UI-3)→ synthesize 喂因果时间线(M-UI-4)→ 前端 CaptureStep 展示用户操作轨(M-UI-5)。**剩余**:严格 CSP/OOPIF 真实站点 spike;user-action frameId(OOPIF 跨 frame 约束);Codex F4 语义 verify。
3. ⏳ **可选**:LLM 参与候选判断(timeline → rank 增强),保留启发式 fallback。
4. 🔭 **更远**:UI 回放型 adapter(把 user-action 录成可回放步骤,生成模拟点击的 adapter)—— 适合接口加密、必须走 UI 的站点。本模块先做「UI 操作作辅助证据」,回放型是独立方向。

## F. Codex 深度评审纳入(2026-06-26)—— P0 硬化项 + 设计细化

第 1 阶段实现 + 本模块设计经 Codex 对抗式评审。**用户决定本轮不改 MVP 代码**(功能 feature-gated 默认关),以下作为「**default-on 上线前必做的硬化项**」+ 设计细化记录在案,勿丢。

### F1. 上线前必做的安全硬化(三个 P0)
1. **write 必须引用已审阅的 artifact**:当前 `handleInit` 的 dry-run 和 write 都会调 `synthesize`;直接 POST `write`(未先 dry-run)会**绕过人工审阅、现场合成并写 raw code**([dashboard-be/src/server.ts](../../../dashboard-be/src/server.ts) `handleInit`)。改:拆出独立 synthesize → 产 `synthesisId/hash`;`write` 只接受已预览确认的 `synthesisId`,**write 路径禁止再调模型**。
2. **外发前置同意**:✅ **已补(2026-06-26)**。synthesize 现仅在 init 请求带 `llmEgressAcknowledgedAt` 时才跑(用户点「用 AI 生成(发送痕迹)」才传);无同意 → 空骨架预览、零外发。be 经 `llmSynthesisOffered` 布尔告知前端 AI 可用(不泄 key),前端先弹同意 CTA 再带 ack 重新预览;同意记入 session、后续 preview/write 复用。涉及 `handleInit`(egressAck 门 + llmSynthesisOffered)/ client seam init 加 `llmEgressAcknowledgedAt` / model previewInit(egressConsent) / InitStep CTA。
3. **funcBody 不是在沙箱里跑**:08 章明确 verify-runner「not a security sandbox / same-user perms」。模板/手写 adapter 时无妨(代码是人写的),但 **LLM 生成代码 + 响应体可能藏 prompt injection** → 可诱导 `fs`/`child_process`/外发的 func,人工审阅会疲劳。本项目 04 章把 same-uid 进程列 out-of-scope,故这不是「防外部攻击者」而是「**防注入内容变成本地代码执行**」。务实做法:对生成的 `funcBody` 加 **AST 静态白名单**(禁 `import()`/`require`/`process`/`fs`/`child_process`/`eval`/`Function`,fetch 限候选 origin);完整 OS 沙箱/独立用户是更大的后续项。
4. (小修)**合成缓存并发**:`getSynthesis→await synthesize→storeSynthesis` 无 in-flight 锁,双击/重试会**重复调模型 + 重复外发**;缓存 key 应含 `model + sample hash + prompt/schema 版本`(现仅 candidateId)。

### F2. 数据→LLM 组织的细化(并入 A/B)
- **因果对齐别只靠时间窗**:点击后常伴随 autosuggest/analytics/GraphQL batch/preload,同 path+时间窗会**错配,把旁路请求当数据源**。优先用 **CDP request initiator**(Network.requestWillBeSent 的 `initiator`/`frameId`)做关联,时间窗仅作兜底,并记 `triggeredByConfidence`。
- **trace schema 要可验证**:`src/observation/events.ts` 现无 `requestId/initiator/frameId/triggeredBy/actionId` —— 第 2 阶段先落地带这些字段 + 单调 `ts` + 候选窗口边界的 trace schema,再谈喂 LLM。
- **裁剪先结构化再摘要化**:候选请求留 schema + 少量样本,非候选只留 method/path/status/count;截图选取由 action/network anchor 决定(不是「结束时一张」);喂前用 `count_tokens` 预估。

### F3. UI 录制路线的风险(并入 C)
- **CSP / 注入世界是未验证假设**:`addScriptToEvaluateOnNewDocument` 注入脚本是否被严格 CSP 站点拦、main vs isolated world、binding 暴露范围 —— **第 2 阶段先做 spike 实测**(顶层 + OOPIF + 严格 CSP 站点 + SPA 动态 iframe),再铺开。
- **背压**:network buffer 现为无上限数组,照搬到高频 `input/scroll/keydown` 更危险 → UI 事件 buffer 必须 **ring cap + 事件合并 + 采样 + drop 计数**。
- **selector 脆性**:别用单一 stable selector → 多候选评分(role/text/testid/css/xpath)并记 brittleness。

### F4. verify 语义断言(backlog)
runner 成功仅回 `rows/fieldCount`,`ok=true` 可能来自**错接口/空数组/静态 mock/写死输入**,且模板把 LLM 的 `{name,path,type}` columns 降成 name 数组丢了 schema。verify 增强:候选 endpoint **确被调用**、动态参数随 seed 变化、输出字段与 columns/path/type 对齐、A/B replay 差异符合预期(`rows>0` 只是最低信号)。

## 关键文件索引(实现时)
- 数据模型:`src/observation/events.ts`(多轨 stream)。
- UI 捕获:`extension/src/cdp.ts`(`registerListeners` 加 `bindingCalled`、注入监听)、`extension/src/background.ts`(`CDP_ALLOWLIST` 加 addBinding;`ui-capture-start/read` action 分发);daemon 透传;`dashboard-be/src/server.ts`(capture 协议扩展)+ `registry.ts`(sample 加 `actions` 轨)。
- LLM 喂数据:`dashboard-be/src/llm/synthesize.ts`(prompt 组织 / 裁剪 / 时间线序列化)。

## M-UI-OOPIF-P2 · embedded_iframe 一体化录制(2026-06-29 落地)

混合录制模式的 iframe 半边(投屏半边见 [[dashboard-inline-recording-screencast]] 记忆 + ADR 0008 修订)。dashboard 自己的 tab 内嵌跨源目标站 iframe,扩展 attach dashboard tab,经已落地的 OOPIF flat autoAttach 录 iframe 内请求(带 frameSessionId)。受 `FEATURE_EMBEDDED_IFRAME_RECORDING` gate、默认关;`tab_projection`(投屏)行为零变化。

**端到端流程(两模式前端流程一致,差异全吸收进 be handler — 应用层策略)**:
- `bind`:`recordingMode='embedded_iframe'` → be gate(flag off → `feature_disabled`)→ createSession(`leaseKind='bound_dashboard_tab'`、记 `targetUrl`)→ 发 daemon `bind` 绑当前聚焦 dashboard tab 拿 targetId 作 bound page lease(不开新 tab)。
- `navigate`:embedded 模式是**状态推进 no-op**——推到 `page_ready`(让 captureStart 可开窗)但不发任何 daemon tab/navigate 命令(page lease 已在 bind 建立)。**注**:早期实现硬拒 `invalid_state` 会使模式不可跑(navigate→captureStart 链断),已改 no-op。
- `captureStart`:对 bound dashboard tab 开 `network-capture-start` + `ui-capture-start`(含 iframe autoAttach)。用户直接在 iframe 里原生操作。
- `captureRead`:be 对 embedded 会话下发 `targetFrameUrl`(=session.targetUrl);扩展据此把网络/UI 噪音过滤到目标 iframe(+descendants)子 session,丢顶层 dashboard 自己的 be API/截图轮询请求。

**噪音过滤(采集适配层,extension `cdp.ts`)**:`readNetworkCapture`/`readUiCapture` 加可选 `filter:{targetFrameUrl}`。解析顺序(别只靠 URL exact,站会重定向/补 query/SPA):`normalizedUrl exact → same-origin+pathname → 多候选报 `ambiguous_iframe_target``。多层 iframe:`sessionToParent` 记父链,过滤收 `目标 frameSessionId + 所有 descendants`(嵌套真实 API 不丢)。无 filter(投屏)路径完全不走过滤。

**CSP frame-src(be `static.ts:buildCsp` + `resolveFrameSrc`,B+A 混合,Codex 2026-06-29 裁定)**:flag off → 无 frame-src(现状);flag on 未配 override → `frame-src https:`(填 URL 即录);flag on + `RECORDER_IFRAME_FRAME_SRC` → 只放该 https origin 列表(CI/企业)。只放 https:,绝不 http:/data:/blob:/*。主 XSS 防线 `script-src 'self'+nonce` 未动;embedded_iframe 定性为 privileged/local recording mode。`embeddedIframeRecording` flag 经 bootstrap 注入前端,BindStep 据此显示「页内嵌入」选项。

**契约**:新 ErrorCode `ambiguous_iframe_target`(已同步 core/be envelope+server/前端 types/bundle/M9 wrapper 六处)。`targetFrameUrl` 是 be→扩展的传输内部字段(同 windowMode/pattern),不进 recorder.openapi 公共契约(CaptureReadRequest 前端→be 不带,be 从 session 派生)。

**已知约束**:debugger infobar 落 dashboard 自己 tab(Chrome 强制,代码不可抑制)——产品取舍,前端顶部留间距缓解;反嵌登录站 iframe 渲染失败 → EmbeddedFrame onError/超时兜底提示切投屏;capture 启动前已加载完的 iframe 首批请求无法补回(OOPIF 已知局限)。

**关键文件**:be `static.ts`(buildCsp/resolveFrameSrc)、`config.ts`(IFRAME_FRAME_SRC env)、`server.ts`(handleBind 发 daemon bind + handleNavigate no-op + captureRead 下发 targetFrameUrl)、`session/registry.ts`(targetUrl);扩展 `cdp.ts`(sessionToParent + resolveTargetFrameSessions + collectDescendants + applyFrameFilter + AmbiguousIframeTargetError)、`background.ts`(read handler 透传 filter + errorCodeOf)、`protocol.ts`(Command.targetFrameUrl);前端 `BindStep`(Segmented 模式选择)、`CaptureStep`(按模式渲 EmbeddedFrame vs LivePreview)、`EmbeddedFrame.tsx`(新)、`useRecorderSession`(recordingMode 贯穿)、`recorderClient`(isEmbeddedIframeRecordingAvailable + bootstrap flag)。

## M-SEED-INPUT · dashboard 录制声明搜索关键词 → 评分识别 seed→param(2026-06-29 落地)

**问题**:dashboard 录出的候选普遍 15 分 low。评分引擎(`score.ts`)的 `seed_arg_maps_to_param`(+20)/`response_echoes_seed`(+10)只读 `CaptureSample.seedArgsEvidence`,而 be 在 `/recorder/rank` 构造样本时从不填它 → 两信号恒 false → 候选理论分上限 25(JSON)+5(session)= 30,带动态字段 −10 就剩 15。

**修复**:让用户在 CaptureStep 录制态声明本次搜索关键词(A/B 各填**不同**词,贴合引擎 A/B value-differencing 原设计),be 据此构造 seedArgsEvidence 喂 rank。

**数据流**:CaptureStep 关键词输入(`seedA`/`seedB` 存 useRecorderSession)→ 结束录制时随 `captureRead(sample, seed)` 下发 → be handleCaptureRead 读 `body.seed` → `resolveSeedParams(entries, seed)`(recorder-core 新纯函数:扫已抓 entries 的 queryParams **值**,精确 trim+小写相等反推参数名,非子串)→ `deriveEvidenceSeedArgs({paramName: seed}, hmacKey)`(已存在,HMAC、只留 placeholder/type/length)→ storeSample 存 `seedEvidence` → handleRank 填进 `CaptureSample.seedArgsEvidence`。

**🔒 seed 持久化边界(Codex 2026-06-29 裁定方案 A)**:raw seed **只在 be 处理 captureRead 那一刻内存中用于 value→param 解析,用完即弃,绝不持久化/落盘/出日志/进 storeSample**。seedEvidence 只含 HMAC(`usage:'display_only'`、`comparableAcrossRuns:false`),符合 M7c「raw seed never stored」不变量。会话级 HMAC key = `sha256(vault.token + sessionId)`。**不把 raw seed 带进 verify-runner**(那是方案 B=另一个安全边界变更,scope creep,本次不做)。注:**抓到的 entries 里 query 含关键词是真实流量、用户本就可见,不在脱敏范围**;脱敏针对的是 seedEvidence 与跨进程/产物扩散。

**局限**:关键词没进任何 query 值(SSR/POST body/SPA 仅页面 URL)→ resolveSeedParams 0 命中 → 回退现状 15 分(只记 no_param_match 计数日志,不记 seed 原文)。LLM 路径已能从 navigation URL diff 推断(`llm/score.ts`),确定性 rank 暂不扫页面 URL,可作后续增强。

**关键文件**:core `normalize.ts`(`resolveSeedParams`)+ `verify.ts`(`deriveEvidenceSeedArgs` 复用);be `server.ts`(handleCaptureRead 解析 + handleRank 喂)+ `session/registry.ts`(samples.seedEvidence);前端 `CaptureStep.tsx`(关键词 Input)+ `useRecorderSession.ts`(seedA/B + setSeed + stopCapture 透传)+ `recorderClient/httpRecorderClient/mockRecorder`(captureRead seed 参数)。契约:recorder.openapi `CaptureReadRequest.seed`。详见记忆 [[recorder-scoring-and-seed-gap]]。

## M-PIPELINE-UX · 多选保存 / verify 并行 / 投屏滚动顺滑(2026-06-29 落地)

真机三项体验改进:

- **多选保存(N5)**:PipelineStep 每张草稿卡片带 checkbox(**全部可勾选含不可用**,不可用给警告),底部固定条显示「已选 N 个」+「保存选中」按钮,统一保存后展示结果列表(每行 site / 脚本名 / adapterPath)。be `handleSave` 兼容单存 `{draftId, source?}` 与批量 `{drafts:[{draftId, source?}]}`:循环调 daemon `/v1/save-adapter`、收集 `saved[]`/`failed[]`、**至少存成功一个才一次性 `ranked→done` + 清草稿**(全失败保持 ranked 可重试)。回 `{saved:[{draftId,site,name,adapterPath}], failed?, adapterPath(兼容)}`。前端新增 `client.saveAdapters(drafts)` + `actions.saveDrafts` + `SessionData.savedAdapters`。`/recorder/save` 是 N4/N5 feature-gated 端点,不在公共 bundle/openapi 契约,HTTP 层向后兼容(单/批两种 body)。

- **verify 并行(N4 提速)**:`runPipeline` 原 `for...of` 串行 verify → 改两阶段:Phase 1 同步对所有 draft 跑静态检查 + 写 0700 草稿(快),Phase 2 对静态通过者**受限并发 verify(并发上限 4)**。根因:daemon RunnerPort 本就内置并发队列(`maxConcurrency` slot + FIFO,clamp 到 CPU 数,超限才 queue_full,见 `src/recorder/runner/runner-port.ts`),be 串行发起是浪费。产出顺序按原 gen.scripts 保持。`verifyDraftSync` 轮询从 `max(250, REQUEST_POLL_AFTER_MS)`(默认 1000ms)降到固定 **300ms**(150 次封顶 ≈ 45s),消除每个 verify 完成后的轮询拖尾。纯 be 改动,daemon 不动。

- **投屏滚动顺滑(Phase 2 务实优化,非 Phase3 真帧流)**:`LivePreview` 截图轮询加**交互期升频**——滚动/点击/拖拽时 `bumpActive()` 把轮询间隔临时降到 `ACTIVE_POLL_MS=180ms`(维持 `ACTIVE_WINDOW_MS=1200ms`),空闲回落 `POLL_MS=800ms`。wheel 改 **requestAnimationFrame 按帧合并 delta**:连续 wheel 累积进 accDx/accDy,rAF 里一次性发一条 `synthesizeScrollGesture`,避免一次手势打几十条 CDP 指令堆在 daemon 串行处理(指令积压本身加剧卡顿)。Phase 3 真 `Page.startScreencast` 帧流仍是后续根治项。

- **LLM 提示词透明展示**(用户要求:看到发给 AI 的提示词)。用户已同意外发痕迹,理应能看到**到底发了什么文本**。
  - `buildScorePrompt`/`buildGenPrompt`(原 `score.ts`/`generate.ts` 私有纯函数)导出;`runPipeline` 用**同一份 builder** 重建本轮实际发出的提示词,挂 `PipelineResult.prompts = { score, generate, screenshotCount }`(`generate` 无高分候选时空串)。截图按 base64 图片块单独外发、**不在文本里**,故只标注张数。
  - **外发前预览**:新增只读端点 `POST /recorder/pipeline/preview`——**不调 LLM、不外发、不改状态**,只返回评分(score)阶段提示词 + 截图张数,供用户在「发送痕迹」同意前预览。生成(generate)阶段提示词依赖评分结果(需先调 LLM),预览阶段不可得、运行后才展示——诚实反映管线结构(score 第一个发、可预知;generate 基于 score 输出、事后才知)。
  - 前端:PipelineStep 同意界面加「预览将发送的提示词」按钮 + 折叠面板(score/generate 两段只读文本框 + 「另附 N 张页面截图」),运行后结果页也展示。`actions.previewPrompts` 走 `pipelinePreview`(transitions 加 `pipelinePreview: ['ranked']`)。

**关键文件**:be `server.ts`(handleSave 批量 + verifyDraftSync 轮询 + handlePipelinePreview + handlePipeline 回 prompts)、`llm/pipeline.ts`(两阶段并发 verify + 重建 prompts)、`llm/score.ts`·`generate.ts`(导出 buildScorePrompt/buildGenPrompt);前端 `PipelineStep.tsx`(多选 UI + 结果列表 + PromptPanel)、`LivePreview.tsx`(升频 + rAF 合并)、`recorderClient/httpRecorderClient/mockRecorder`(saveAdapters + pipelinePreview)、`useRecorderSession`(saveDrafts/savedAdapters + previewPrompts/pipelinePrompts)、`models/transitions.ts`(pipelinePreview)、`types/recorder`(SaveResult.saved/SavedAdapter + PipelinePrompts)。
