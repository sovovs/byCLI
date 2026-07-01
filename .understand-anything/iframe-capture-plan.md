# 实施方案:扩展录制 OOPIF(跨源 iframe)内的请求与页面操作

状态:**已落地 + Codex 四轮对抗复审收敛,确认可上真机**(2026-06-28)。分支 `recorder-iframe-capture`(基于 recorder-llm-synthesis)。

## 落地结果(终态)

- **核心**:flat autoAttach iframe + 按 sessionId 路由,子 session 的 Network/UI 事件归并到父 tab buffer;buffer key `${sessionId||'top'}:${requestId}` 防撞;follow-up 命令用事件 source 路由。
- **能力位幂等**:`ChildArmState{autoAttach,network,ui,overCap}`,armChildSession 只补缺域;rearmChildSessions 在两个 capture-start 末尾调用(network/ui 先后启动都能后补);sendSafe 返回 boolean,仅成功置位。
- **背压**:per-tab 50 子 session 上限,over-cap 持久标记 + rearm 短路。
- **生命周期**:detach 无条件清状态;generation guard + states 引用 + `states.has` 三重防 rearm/detach 并发复活。
- **#3 错关联防护(关键)**:timeline frameSessionId `?? 'top'` 归一**强相等**约束——iframe 内 action 绝不关联到顶层(或别的 iframe)请求,反向亦然。扩展 network entry + UI event 打 frameSessionId,be synthesize 透传两侧。**为何必须接下游**:timeline 兜底是 5s 时间窗 + 缺 frame 不拒绝,只到数据层会产出**错误**因果链喂 LLM(非精度问题)。
- **iframe URL 显式捕获**:取 `Target.attachedToTarget.targetInfo.url`(脱敏→`sessionToFrameUrl` map),给子 session 的 network entry + UI event 打 `frameUrl`,be synthesize 透传进 actionSeq/endpointCalls。比注入脚本 location.href 可靠(CDP 无条件给、不受 CSP)。
- **验证**:recorder-core 100+timeline 11、extension 107(cdp 27)、dashboard-be 127,三处 tsc 净,extension build 净,manifest 1.0.26。

## iframe(OOPIF)内 UI 操作录制原理

录制 UI 操作**不靠 content script**,而是 CDP(chrome.debugger)**注入一段只读监听脚本 + 一个 binding 回传通道**。iframe 用的是和顶层完全相同的机制,只是要先解决「跨源 iframe 是独立 CDP target」。

**顶层页面(基础机制)**:
1. `Runtime.addBinding({name:'__bycli_ui'})` —— 在页面 JS 世界挂一个特殊函数 `window.__bycli_ui(str)`,页面调用它 → 内容作为 `Runtime.bindingCalled` 事件回到扩展(页面→扩展单向管道)。
2. 注入监听脚本(`ui-capture.ts` 的 `UI_LISTENER_SOURCE`):`Page.addScriptToEvaluateOnNewDocument`(后续每个新文档自动跑,覆盖导航)+ `Runtime.evaluate`(当前已加载文档立即注入一次,脚本内 `__bycli_ui_installed` 防重复)。
3. 脚本用捕获阶段 `addEventListener('click'/'change'/'submit'/'keydown')` 监听,算 CSS selector/tag/valueShape(**绝不取原始输入值**,密码框只记类型),`JSON.stringify` 后调 `window.__bycli_ui(json)`。
4. 扩展全局 `chrome.debugger.onEvent` 收 `bindingCalled`(name===`__bycli_ui`)→ `parseUiEvent` 解析校验 → push 进该 tab 的 `uiCaptures` ring-buffer。

**OOPIF 的难点**:跨源 iframe 是 Chrome 拆出的独立 CDP target,有自己独立的 JS 世界;顶层 target 上的 `addBinding`/`addScriptToEvaluateOnNewDocument` 完全不作用于它 —— iframe 里没有 `__bycli_ui` binding、监听脚本也没注进去、即便 click 也无人监听、无通道喊回。

**iframe UI 录制(本实现)= 把同一套机制复制到每个 iframe 子 session**:
1. **flat autoAttach 纳管**:capture 启动对 tab 发 `Target.setAutoAttach({flatten:true,filter:[iframe],waitForDebuggerOnStart:true})`;每个跨源 iframe 出现 → 收到 `Target.attachedToTarget`,拿到它的 **sessionId**(flat 模式子事件 source 是 `{tabId,sessionId}`)。
2. **对子 session 武装同一套 UI 抓取**(`armChildSession`,用 `{tabId,sessionId}` 作 debuggee):`Runtime.enable` + `Page.enable` + `Runtime.addBinding(__bycli_ui)`(挂进 iframe 自己的 JS 世界)+ `Page.addScriptToEvaluateOnNewDocument` + `Runtime.evaluate`(把同一段监听脚本注进 iframe 文档)+ **`Runtime.runIfWaitingForDebugger` 放行**(waitForDebuggerOnStart:true 让子 frame 暂停了,武装完必放行否则 iframe 卡死)。
3. **回传**:iframe 内 click → 它的监听脚本调 iframe 世界的 `__bycli_ui` → `bindingCalled` 事件**带子 session 的 sessionId** 回到扩展全局 onEvent → 收进同一个 tab 的 `uiCaptures` buffer。
4. **打 frame 归属**:收时事件 `source` 带 sessionId,给这条 UI event 打 `frameSessionId`(区分来自哪个 iframe)+ `frameUrl`(取自 `attachedToTarget.targetInfo.url`)。

**为何 frame 归属是关键(非装饰)**:下游 `timeline.ts` 因果对齐有 5s 时间窗兜底,不标 frame 归属时 iframe 内 click 会被**错误关联**到顶层同窗请求,喂 LLM 即错误因果链。故 timeline 用 `frameSessionId ?? 'top'` **强相等**约束:iframe 操作只能配同一 iframe 内请求,绝不串顶层/别的 iframe。

**一句话**:和顶层一样靠「CDP 注入只读监听脚本 + binding 回传」,但因跨源 iframe 是独立 CDP target,经 flat autoAttach 按 sessionId 逐个把同一套 binding+脚本武装到每个 iframe 子 session,回传事件带 sessionId/frameUrl 标明来源 iframe。

## Follow-up(非阻断,Codex 确认可后补)

1. ~~**真机验证**~~ **✅ PASS(2026-06-28,网络+UI 双通道)**:`oopif-manual-drive.mjs` 经真 daemon→真扩展→测试页(juejin iframe)实测——**网络**:123 entries,122 条 iframe 内请求带 frameSessionId+frameUrl=juejin.cn(含 wss,token 脱敏),顶层 github 1 条无 frameSessionId;**UI**:iframe 内搜索打字+回车+提交录到 7 条带 frameSessionId 的 click/input/keydown/submit/navigate(input 只记 valueShape 不含原文),顶层按钮 click 标 `[top]`。frame 归属、URL 捕获、脱敏全中。坑见记忆。
2. **Q7 capture 期 per-frame exec**:若将来要在 capture 活跃时支持 per-frame CDP exec,把 `sendCommandInFrameTarget` 从 `{targetId}` 直接 attach 改成复用 flat `{tabId,sessionId}`(需 frameId↔sessionId 探针)。当前互斥退路(capture 中不发 per-frame exec)对 recorder 时序成立。
3. ~~**契约 schema 文档化**~~ **✅ 已做(2026-06-28)**:bundle `CaptureRawEntry` 加 `frameSessionId`/`frameUrl`(+ 顺带补齐早已 emit 但漏文档的 `frameId`/`initiatorType`/`resourceType`、kind 改 `cdp|cdp-websocket`);模块 12 doc 加 M-UI-OOPIF 落地段;UserActionEvent 不在 JSON 契约(非 rank 生产↔消费契约,只在模块 12 doc)。契约漂移校验通过、recorder-core 100 测试过。**随 LLM 分支整批提交**。

---

# 原方案(保留供追溯)


## 1. 问题(根因,已代码级核实)

扩源 iframe(OOPIF)是 Chrome 拆出的**独立 CDP target**,经 flat auto-attach 后其事件 `source` 带 **`sessionId`**(`source.tabId` 仍是父 tab),而顶层事件无 `sessionId`。当前抓取链路既没对子 session 开域/注脚本,分发器又只认顶层。

三处具体证据(`extension/src/cdp.ts`):

1. **网络域只开在顶层**:`startNetworkCapture`(:711)只对 `{tabId}` 发一次 `Network.enable`;从不对子 target 开 Network。
2. **UI binding/脚本只注顶层**:`startUiCapture`(:744)对 `{tabId}` 发 `Runtime.addBinding` + `Page.addScriptToEvaluateOnNewDocument` + 一次性 `Runtime.evaluate`。OOPIF 是另一个 target,没有 `window.__bycli_ui` binding,监听脚本也没注进去。
3. **分发器丢弃所有子 target 事件**:全局 `chrome.debugger.onEvent` 回调(:905、:788)第一行 `const tabId = source.tabId; if (!tabId) return;`。OOPIF 事件只有 `targetId` → 直接被丢。

**分类结论:**
- **同进程 iframe**(同源/普通子框架):请求与主框架共享渲染进程,顶层 Network 域能看到,正常录到(`entry.frameId` 标来源,:948)。UI 脚本对同进程新文档通常也注入到。→ **本就能录。**
- **OOPIF**(跨源 iframe,独立进程):请求与 DOM 事件属独立 target,被 `!tabId` 挡掉 + 根本没开域/没注脚本。→ **录不到。这是本方案要解决的。**

现有 `ensureFrameTarget`/`setAutoAttach(filter iframe)`/`sendCommandInFrameTarget`(:494-558)只为「按需向某个 iframe 发执行类命令(DOM.querySelector / setFileInputFiles / Input.insertText)」,**既没开 Network 域也没注 UI 脚本**,且其 attach 出来的子 session 事件同样被主分发器丢。

## 2. 与既有决策的关系

- 记忆 `recorder-in-dashboard-iframe-rejected`(adr/0008)讲的是「不在 **dashboard** 内嵌 iframe 做录制」=另一回事,**不冲突**。本方案是录制**目标页自身内部的 iframe**,仍维持「扩展拥有的真实 top-level tab + CDP」模式。
- `FEATURE_DIRECT_CDP_CAPTURE` flag 当前 reserved,与此无关。

## 3. 设计目标 / 非目标

目标:
- OOPIF 内的 Fetch/XHR/WebSocket 请求纳入 capture(与顶层同一 buffer,带 `frameId` 区分)。
- OOPIF 内的 click/input/submit/keydown/navigate 纳入 UI capture。
- 子 target 生命周期正确清理,不泄漏 attach、不在 detach/导航后留悬挂监听。

非目标(本轮不做):
- 嵌套 OOPIF(iframe 里的 iframe)递归——先支持一层,递归作为 stretch(setAutoAttach 在 flat 模式可级联,但留待验证)。
- 改 be/daemon 契约:子 frame 请求归并到同一 session 的 capture 输出,**对 be/core 透明**(还是一串 NetworkCaptureEntry,只是多了来自 iframe 的条目 + frameId)。

## 4. 方案

> **核心前提(已 Codex 复审 + chrome.debugger 官方文档核实)**:`chrome.debugger.attach({tabId},'1.3')` 作 root 时,flat autoAttach 子 target 的事件 `source` 是 **`{tabId:<父tab>, sessionId:<子session>}`,不是 `{targetId}`**;顶层事件无 `sessionId`。给子 session 发命令要用 `{tabId, sessionId}`。所以**全程按 `sessionId` 路由,不用 `targetId`**(`source.targetId`/`Target.detachedFromTarget.targetId` 已 deprecated)。Playwright 同款 sessionId 路由。来源见文末。

### 4.1 自动 attach iframe + 监听 attachedToTarget 纳管子 session

复用现有 `setAutoAttach({autoAttach:true, flatten:true, filter:[{type:'iframe'}]})`(已在 :507),但提升为「capture 启动时对 tab 调一次」,并监听 `Target.attachedToTarget` 把新子 session 纳管。**`waitForDebuggerOnStart:true`**(见 §4.6 时序)。

新增模块级状态(全部以 sessionId 为 key):
```
// childSessionId → 归属 tabId(子 session 事件路由用)
const sessionToTab = new Map<string, number>();
// tabId → 该 tab 下已武装抓取的子 sessionId 集合(去重 + 清理)
const armedChildSessions = new Map<number, Set<string>>();
```

`registerListeners`(全局 onEvent)新增:
```
if (method === 'Target.attachedToTarget') {
  const ti = params.targetInfo;            // {targetId, type, url, ...}
  const childSessionId = params.sessionId; // ← 路由 key
  if (ti?.type !== 'iframe' || !childSessionId) {
    // 非 iframe 也要放行,否则 waitForDebugger 卡住该 target
    if (childSessionId) sendSafe({ tabId, sessionId: childSessionId }, 'Runtime.runIfWaitingForDebugger', {});
    return;
  }
  sessionToTab.set(childSessionId, tabId);   // tabId 来自父 source
  armChildSession(tabId, childSessionId);    // 见 4.2(内部 finally runIfWaitingForDebugger)
  return;
}
if (method === 'Target.detachedFromTarget') {
  const sid = params.sessionId;              // 主字段是 sessionId(targetId deprecated)
  if (sid) { sessionToTab.delete(sid); armedChildSessions.get(tabId)?.delete(sid); }
  return;
}
```
注意:`attachedToTarget`/`detachedFromTarget` 事件的 `source` 是**父 session**(顶层即 `{tabId}`),`source.tabId` 即归属 tab;子 session 标识在 `params.sessionId`。

### 4.2 对子 session 武装 Network + UI(按当前激活的 capture 种类)

```
async function armChildSession(tabId: number, sessionId: string) {
  const set = armedChildSessions.get(tabId) ?? new Set();
  if (set.has(sessionId)) return;
  set.add(sessionId); armedChildSessions.set(tabId, set);
  const child = { tabId, sessionId } as chrome.debugger.Debuggee;  // ← flat 子 session debuggee
  try {
    // 级联:让子 session 也自动 attach 它内部的 iframe(嵌套 OOPIF)
    await sendSafe(child, 'Target.setAutoAttach', { autoAttach:true, waitForDebuggerOnStart:true, flatten:true, filter:[{type:'iframe',exclude:false}] });
    if (networkCaptures.has(tabId)) {
      await sendSafe(child, 'Network.enable', {});
    }
    if (uiCaptures.has(tabId)) {
      await sendSafe(child, 'Runtime.enable', {});
      await sendSafe(child, 'Page.enable', {});
      await sendSafe(child, 'Runtime.addBinding', { name: UI_BINDING_NAME });
      await sendSafe(child, 'Page.addScriptToEvaluateOnNewDocument', { source: UI_LISTENER_SOURCE });
      await sendSafe(child, 'Runtime.evaluate', { expression: UI_LISTENER_SOURCE }); // 已加载的子文档
    }
  } finally {
    // 关键:无论武装成功与否都放行,否则 waitForDebuggerOnStart 会卡死该 iframe 加载
    await sendSafe(child, 'Runtime.runIfWaitingForDebugger', {});
  }
}
```
`sendSafe` = try/catch 包装的 sendCommand(子 session 可能正在销毁,全 best-effort)。

**反向同步**:`startNetworkCapture`/`startUiCapture` 启动时,除了对顶层武装,还要:
1. 对 tab 发 `Target.setAutoAttach({waitForDebuggerOnStart:true, flatten:true, filter:[iframe]})`(确保后续 iframe 自动 attach)。
2. 对 capture 启动**前**已 attach 的子 session 逐个 `armChildSession`——遍历 `armedChildSessions` 未覆盖到的、或重新对 tab 触发一次 setAutoAttach 让 Chrome 重发 attachedToTarget。**注意**:对 capture 启动前**已加载完**的 iframe,首批请求无法补回(域未开时已发完)——这是已知局限,文档化。

### 4.3 分发器按 sessionId 路由回 tab(核心改动)

把 `registerListeners` 与 fetch-guard 两个 onEvent 回调的 `const tabId = source.tabId; if (!tabId) return;` 改成:
```
const tabId = source.tabId
  ?? (source.sessionId ? sessionToTab.get(source.sessionId) : undefined);
if (!tabId) return;
```
> 实测顶层与子 session 的 `source.tabId` 都等于父 tab(flat 模型),故 `source.tabId` 通常已够;但子 session 销毁竞态下若 `tabId` 缺失,用 `sessionToTab` 兜底。**真正用 sessionId 的地方是 §4.4 的 buffer key 与 §4.3 follow-up 命令路由**,不是 tab 归属判断。

这样来自子 session 的 `Network.requestWillBeSent` / `responseReceived` / `loadingFinished` / `webSocket*` / `Runtime.bindingCalled` 全部归并到父 tab 的 buffer。

**关键细节(follow-up 命令路由)**:`Network.getResponseBody`/`getRequestPostData` 这些 follow-up sendCommand 当前写死 `{tabId}`(:960、:1002)。对子 session 的 requestId,必须发给**同一子 session**(`{tabId, sessionId}`)否则报 "No resource with given identifier"。
→ 解决:把事件 `source`(顶层 `{tabId}`、子 frame `{tabId, sessionId}`)直接当 debuggee 透传进 requestWillBeSent/loadingFinished 处理分支,follow-up 全用 `source`。

### 4.4 frameId 归属与去重

- 子 session 的 `requestWillBeSent` 也带 `frameId`(子框架的 frameId),`entry.frameId` 自然填上,与顶层条目可区分。
- `requestToIndex` 以 requestId 为 key——**CDP requestId 只保证单 session 内唯一,跨 session 不保证**。→ key 改为 `${source.sessionId ?? 'top'}:${requestId}` 防撞;getOrCreate / responseReceived / loadingFinished / webSocket* 全处同步。

### 4.5 生命周期 / 清理

- tab detach(`onDetach`)/ tab removed(`onRemoved`):按 tabId 反查清 `sessionToTab` 所有该 tab 的 entry、`armedChildSessions.delete(tabId)`、复用现有 `networkCaptures.delete`/`uiCaptures.delete`。**不靠浏览器级联回调兜底,显式清。**
- `Target.detachedFromTarget`:按 `params.sessionId` 清单个映射。
- 顶层 root session detach 通常自动释放子 session(无需逐个 detach 子 session),但**内存状态必须显式清**。
- 已有 `registerFrameTargetCleanup`(:476)的 `frameTargets`/`frameTargetKeys`(执行类命令 `sendCommandInFrameTarget` 用,走 `chrome.debugger.attach({targetId})` 独立路径)与新 capture 状态并存。**⚠️ 潜在冲突**:同一 iframe 既被 flat autoAttach(子 session)又被 `ensureFrameTarget` 显式 `attach({targetId})`,可能双 attach 走错 session。需在落地时核对:capture 期间若 `sendCommandInFrameTarget` 也用,是否改为复用 flat sessionId(见 §7 Q7)。

### 4.6 子 session 时序(waitForDebuggerOnStart:true)

`waitForDebuggerOnStart:false` 有竞态:`attachedToTarget` 到达、我们 `Network.enable`/注入 UI 之前,子 frame 已在跑 → 漏早期 XHR/UI。改 **`waitForDebuggerOnStart:true`**:子 target 暂停在启动点,等我们武装完域再 `Runtime.runIfWaitingForDebugger` 放行(§4.2 finally)。**代价**:必须保证 finally 一定放行(异常路径也放),否则坏 iframe 永久卡加载。仍无法补回 capture 启动前已加载完 iframe 的首批请求(已知局限)。

## 5. 改动清单(文件级)

- `extension/src/cdp.ts`:
  - 新增 `sessionToTab`/`armedChildSessions` 状态 + `armChildSession` + `sendSafe`。
  - `registerListeners`:加 `Target.attachedToTarget`/`Target.detachedFromTarget`(按 `params.sessionId`)处理;dispatcher tabId 解析加 sessionId 兜底;follow-up sendCommand(getResponseBody/getRequestPostData)改用事件 `source` 而非写死 `{tabId}`。
  - `ensureFetchListener`:**不改 fetch 武装范围**(本轮不给子 session `Fetch.enable`,见 §7 Q3);只在需要时同步 tabId 兜底。
  - `startNetworkCapture`/`startUiCapture`:启动时对 tab `setAutoAttach(waitForDebuggerOnStart:true,flatten,filter iframe)` + 武装已 attach 的子 session。
  - `requestToIndex` key 加 `${sessionId||'top'}:` 前缀。
- `extension/manifest.json`:version bump 1.0.25 → 1.0.26(扩展改动必 bump,记忆 [[recorder-tab-ux-capture]])。
- `extension/src/cdp.test.ts` / `background.test.ts`:加 OOPIF 路由单测——mock onEvent 发 **`{tabId, sessionId}`** 源事件 → 断言进了对应 tab buffer;`attachedToTarget(iframe)` → armChildSession 发了 `{tabId,sessionId}` 的 Network.enable;requestId 跨 session 不撞(同 requestId 不同 sessionId → 两条 entry);finally runIfWaitingForDebugger 一定被调用(即使武装抛错);detach 清理 sessionToTab。
- `extension/dist/background.js`:`npm run build` 重出。

## 6. 验证

- 单测:`npx vitest run extension/`(routing/dedup/lifecycle/runIfWaitingForDebugger)。
- typecheck + build:`cd extension && npm run typecheck && npm run build`。
- 真机:找带跨源 iframe 且 iframe 内发 API 的站(嵌第三方支付/地图/评论组件)→ C1 真 Chrome 抓包 e2e(`BYCLI_AX_E2E=1`,记忆 [[recorder-manual-run-and-e2e]],`CHROME_PATH` 补 macOS 路径、先停常驻 daemon)→ 确认 iframe 内请求与点击进入 entries/events,frameId 正确、无重复、页面不卡(waitForDebugger 放行验证)。
- 扩展 reload(`bycli doctor` 自证版本 1.0.26)。

## 7. 开放问题裁决(Codex 复审 + 官方文档已定)

1. **【已定】flat-mode 路由** = `sessionId`,**不是** `targetId`。子事件 `source={tabId, sessionId}`(tabId 仍是父 tab),给子 session 发命令用 `{tabId, sessionId}`,`source.targetId`/`detachedFromTarget.targetId` 已 deprecated。§4 全程已改 sessionId。这是贯穿全局的硬伤,原 v1 方案按 targetId 路由会整体跑偏。
2. **【已定】时序** = `waitForDebuggerOnStart:true` + `armChildSession` finally `Runtime.runIfWaitingForDebugger`(异常路径也放行,否则卡 iframe)。仅覆盖 capture 启动后新建/新导航的子 target;启动前已加载完的 iframe 首批请求无法补回(已知局限,文档化)。
3. **【已定】fetch-guard 不扩到 iframe**:本轮只做 capture,**不给子 session `Fetch.enable`**。现有 guard 本就只 root tab `Fetch.enable` + 只拦顶层 Document。不做「半扩」(若以后子 session 启 Fetch,continue/fail 也必须用子 source)。04 章威胁模型已声明 ip-observed-only tier 不防 rebinding、子框架同理 out-of-scope,文档注明、不引入新安全回退。
4. **【已定】背压**:设 per-tab 子 session 上限(建议常数如 50);超限跳过 UI 注入(只开 Network)或整体跳过 + 计数。广告站几十 iframe 会放大事件,必须限。
5. **【已定】只在 capture 激活时 setAutoAttach**:不常驻 autoAttach(避免无谓 attach 开销/干扰)。capture stop 时关 autoAttach。
6. **【已定】detach**:root session detach 通常级联释放子 session,但**内存状态显式清**(不靠回调兜底)。
7. **【已查清,需处理】`ensureFrameTarget` 冲突**:现有 `sendCommandInFrameTarget`(`cdp.ts:547`)只在 `handleCdp`(`background.ts:1676-1681`)里、当命令显式带 `params.frameId` + `params.sessionId === 'target'` 时触发——是「把某条 CDP 命令显式路由进某个 iframe」的主动 per-frame DOM/exec 操作(navigate/exec/screenshot 阶段)。它经 `chrome.debugger.attach({targetId})` **直接以非-flat 方式 attach 子 target**,拿到 `{targetId}` debuggee(`cdp.ts:515,557`),与本方案 capture 期的 **flat autoAttach(`{tabId,sessionId}`)是两套 attach 模型挂同一个 OOPIF**。

   **冲突点**:Chrome 对同一 target 同时 flat-attach(经父 session)与直接 `attach({targetId})` 会撞——`ensureFrameTarget` 已经 try/catch 吞掉 `"Another debugger is already attached"`(:518),说明这个撞已被预期到。但吞掉之后 `frameTargets.set(key,targetId)` 仍记录,后续 `sendCommand({targetId})` 在该 target 已被 flat 占用时**可能报错或路由到错误 session**。

   **裁决**:capture 激活期间,把 per-frame 执行类命令也走 **flat 子 session**——即 `sendCommandInFrameTarget` 在已有 flat 子 session 时,改用 `{tabId, sessionId}`(从新方案的 `frameId→sessionId` 映射查),不再 `attach({targetId})`。落地步骤:
   - 在 `Target.attachedToTarget` 纳管时,除了 `sessionToTab`,再存 `frameId→sessionId`(`params.targetInfo` 有 targetId,但子 session 的 frameId 要从该 session `Page.getFrameTree` 或首个带 frameId 的事件得到——**需落地时验证 frameId↔sessionId 映射怎么稳定建立**)。
   - `sendCommandInFrameTarget`:先查 flat sessionId,命中则 `sendCommand({tabId,sessionId},...)`;未命中(capture 未激活/该 frame 没被 autoAttach)再回退现有 `attach({targetId})` 老路径。
   - 这样 capture 开着时单一 flat 模型,capture 关着时维持旧行为,**向后兼容**。
   - **风险**:frameId↔sessionId 映射的稳定建立是新方案唯一没有官方文档直接背书的点(`attachedToTarget` 的 `targetInfo` 不直接给 frameId)。落地第一步就要写个真机探针确认:flat autoAttach 的 iframe 子 session,怎么从 `frameId`(be 命令里带的)反查到 `sessionId`。**若映射不可靠,退回方案 = capture 与 per-frame exec 时间上互斥**(record 阶段不发 per-frame exec,二者本就不同步进行),冲突自然消失,代价是文档声明这个限制。

## 来源

- chrome.debugger `onEvent` 的 `source` 在 flat auto-attach 下含 `sessionId`(子 target),顶层无 `sessionId`;子命令用 `{tabId, sessionId}`:
  https://developer.chrome.com/docs/extensions/reference/api/debugger
- Target domain `setAutoAttach`/`attachedToTarget`(`params.sessionId`)语义:
  https://chromedevtools.github.io/devtools-protocol/tot/Target/
- 真实消费者(按 sessionId 路由)Playwright:
  https://github.com/microsoft/playwright

## 真机验证 runbook(OOPIF capture,手动)

前置:扩展 1.0.26 已 build(`extension/dist`,已含 frameUrl/frameSessionId)。测试页已起在 `http://127.0.0.1:8899/oopif-test-page.html`(本会话用 `python3 -m http.server 8899` 起于 `.understand-anything/`;跨源 iframe 需 http 源,file:// 会污染 origin)。

**A. 装扩展(你操作)**
1. Chrome → `chrome://extensions` → 开「开发者模式」→「加载已解压的扩展程序」→ 选 **`extension/` 根目录**(不是 dist)。
2. 确认扩展版本显示 **1.0.26**。若之前装过旧版,先移除或点「重新加载」。

**B. 起 daemon + 录制(两条路任选)**

*路线 1：bycli CLI 直接抓(最快验证 capture 本体)*
- 先停常驻 daemon(端口 19825 现被占):`lsof -ti :19825 | xargs kill`(你来,或我代跑)。
- `npm link` 后 `bycli` 可用;起 daemon,navigate 到测试页,开 capture,点页面,读 capture。
- 这条要扩展连上 daemon(扩展 popup 里确认已连 19825)。

*路线 2：自动化 C1(若想要可回归的断言)*
- 现有 C1(`dashboard-be/test/recorder-real-browser-capture.test.ts`)打的是 example.com、**无跨源 iframe**,不覆盖 OOPIF。要覆盖需新增一个 case:navigate 到 `http://127.0.0.1:8899/oopif-test-page.html` → captureStart → 等 iframe 加载/点击 → captureRead → 断言存在 `entry.frameSessionId` 且 `entry.frameUrl` 含 `httpbin`。**这条我可以写**(需要本机 Chrome + 测试页 server 同时在)。

**C. 验收点(无论哪条路)**
1. **iframe 内请求**:capture entries 里出现 `httpbin.org` 的请求,且该 entry 带 `frameSessionId`(非空)+ `frameUrl`(含 `httpbin.org/forms/post`)。
2. **顶层请求**:点「顶层:发一条 top fetch」→ 出现 `httpbin.org/get?from=top` 的 entry,**无** frameSessionId/frameUrl(顶层归一 'top')。
3. **iframe 内 UI 操作**:在 iframe 表单里点输入框/按钮 → ui-capture events 里出现带 `frameSessionId` + `frameUrl` 的 click/input。
4. **页面不卡**:iframe 正常加载渲染(验证 waitForDebuggerOnStart:true + runIfWaitingForDebugger 放行没卡死子 frame)。
5. **多 iframe 不串**:若加第二个不同源 iframe,两者 frameSessionId 不同、各自请求不互相污染。

**判失败的信号**:iframe 内请求 entry 没有 frameSessionId(路由没生效)/ iframe 卡白(放行漏了)/ 顶层请求被打了 frameSessionId(归一错)。
