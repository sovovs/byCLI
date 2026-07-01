<!--
  维护说明(给未来的 Claude / 协作者):
  本文件是「agent 控浏览器/桌面」赛道的竞品调研 + 与 byCLI 的逐点架构对照。
  它是「研究/参考」视角的活文档,**不是契约源、不是系统设计模块**(契约源永远是 system/schemas/,
  系统设计在 system/adapter-recorder-system/)。
  调研方法:对竞品仓库 `git clone --depth 1` 拆源码;非记忆/非臆测,结论附源码位置。
  当以下任一发生时,建议刷新本文件并更新顶部「最后核实」日期:
    - 重新调研了新的竞品,或竞品发生重大架构变化(版本/范式)
    - byCLI 自身的浏览器接管方式 / 选择器策略 / 漂移救援 / adapter 持久化机制发生变化
      (即下表「byCLI 侧」引用的 extension/src/cdp.ts、src/browser/{dom-snapshot,target-resolver}.ts、
       clis/<site>/*.js 任一的核心机制变动)
  相关 memory:bycli-competitive-landscape / dashboard-three-layer-split / recorder-hosting-capability-split。
  最后核实:2026-06-26(首版:调研 vercel-labs/agent-browser、sleepinginsummer/agent-browser-cli、
  remorses/usecomputer、asweigart/pyautogui;核对 byCLI extension/src/cdp.ts、src/doctor.ts、
  src/browser/{dom-snapshot,target-resolver}.ts、skills/bycli-browser/SKILL.md)
-->

# 竞品 / 赛道对照:agent 控浏览器与桌面

> 一句话定位:**byCLI 在工程鲁棒性上已领先同类对手;真正的护城河是它们都没有的两层——`target-resolver` 漂移救援 + 持久 `adapter`。本次调研最大价值不是"抄到什么",而是核实后否决了若干"照搬"(那会是 cargo-cult 倒退)。**

## 0. 背景与方法

应需求调研 GitHub 上「让 AI agent 控制浏览器/桌面」的代表项目,与 byCLI 逐点对照,定位 byCLI 的差异化。
方法:对竞品 `git clone --depth 1` 拆源码(`gh`/网页 WebFetch 在本机不可用),结论均附源码位置,不依赖记忆或臆测。

## 1. 赛道光谱(按控制粒度)

```
语义浏览器控制 ───────────────────────► OS 像素级控制
(懂 DOM / 无障碍树)                      (只懂坐标 / 截图)

agent-browser        agent-browser-cli         usecomputer / cua        pyautogui
(vercel,新起受控Chrome)  (真实Chrome+登录态)       (截图+点坐标)            (原语库)
                     ▲
                     byCLI 在这一格
```

| 项目 | 星 | 栈 | 浏览器/桌面接管方式 | 与 byCLI 关系 |
|---|---|---|---|---|
| [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | ~37k | Rust | **新起**受控 Chrome(Chrome for Testing),CDP 驱动 | 头部对手;选择器范式可对照 |
| [sleepinginsummer/agent-browser-cli](https://github.com/sleepinginsummer/agent-browser-cli) | ~458 | Rust | MV3 扩展 `chrome.debugger.attach` **已开 tab**,复用登录态 | **直接同构对手**(架构几乎一致) |
| [remorses/usecomputer](https://github.com/remorses/usecomputer) | ~304 | Zig | OS 级 screenshot/mouse/click/type | 不竞争(另一层) |
| [asweigart/pyautogui](https://github.com/asweigart/pyautogui) | ~12.6k | Python | OS 级原语(win32/Cocoa/Xlib)+ 图像找位 | 不竞争(原语库,2024 后基本停更) |

> 注:`agent-browser` 与 `agent-browser-cli` 是**两个不同项目**,不是同一个的两种叫法。

## 2. 直接同构对手:sleepinginsummer/agent-browser-cli

源出自 [lsdefine/GenericAgent](https://github.com/lsdefine/GenericAgent) 的 `TMWebDriver`/`simphtml` 工具链。它和 byCLI 是**同一条路线**:扩展 + `debugger` 权限 + daemon + 登录态复用。

```
Agent → CLI(reqwest 阻塞)
          ├─ ensure_server(): fs2 文件锁防并发拉起 → 没起就 spawn【脱离终端】的 daemon
          └─ HTTP ──────────────┐
                                 ▼
        Daemon(单 Rust 进程, axum, 共享 DriverState)
          ├─ HTTP API 127.0.0.1:18767   ← CLI
          ├─ WS server 127.0.0.1:18765  ← 扩展
          ├─ 命令关联: PendingExec{id, oneshot};扩展回 ack→result/error
          ├─ session_key = browser_id:profile_id:tab_id(断连留 disconnected_at)
          ├─ SnapshotCache: AX-tree refs(@e + backendDOMNodeId)
          └─ idle 300s 无业务请求 → 自杀关停
                                 ▲ WS
        扩展(background.js, MV3 SW)
          ├─ ext_ready 上报可脚本化 tab
          ├─ chrome.debugger.attach(tabId,'1.3') 接管【已开】tab
          │   └─ stale-attach 恢复: "Another debugger is already attached" → detach+retry
          ├─ 命令经 CDP 执行(Input/DOM/Page/Runtime)
          ├─ Network./Runtime./Log. 事件流 → 抓包 + console
          └─ detachDebugIfIdle: 没在抓包/console 就 detach 释放调试横幅
        真实 Chrome(保留登录态 + Cookie)
```

### 2.1 逐点对照 byCLI

| 维度 | agent-browser-cli | byCLI | 谁更强 |
|---|---|---|---|
| 浏览器接管 | 扩展 `chrome.debugger.attach` 已开 tab | **同款**扩展(`debugger` 权限)+ 受控 tab lease;**另有** `src/launcher.ts` 走 CDP 探活/`--remote-debugging-port` 拉起 Antigravity/Cursor/Codex | byCLI(多 CDP 直连/拉起 app) |
| 进程模型 | 单 Rust 二进制, HTTP 18767 + WS 18765 同进程 | Node/TS daemon(19825)+ dashboard-be 独立 ESM 进程(daemon bridge)+ 前端 | abc 更轻;byCLI 分层更完整 |
| session 标识 | `browser:profile:tab` 三段键 + profile label | 会话上限默认 2、`queue_full`、废弃会话不过期(已知痛点) | **abc 更干净** |
| 元素定位 | AX-tree → `@e` ref + backendDOMNodeId | `data-bycli-ref` + 指纹(详见 §3) | 思路一致,目标函数不同 |
| 断连/陈旧身份 | tab 消失标 `disconnected_at`;stale attach detach+retry | `cdp.ts` Runtime.evaluate 探活 + 每次 attach 前强制 detach | 见 §4(byCLI 已更强) |
| daemon 生命周期 | **idle 300s 自杀**,扩展横幅不常驻 | daemon 常驻 19825 | 各有取舍 |
| 并发拉起 | fs2 排他文件锁 | 启动锁 | 同模式 |
| **录制/复用** | ❌ 无,每任务现场重推 | ✅ **adapter recorder:录一次→稳定可重放 CLI** | **byCLI 护城河** |
| 抓包/console | CDP 内建 | CDP 内建(`cdp.ts` Network 捕获) | 平 |
| 安全 | CORS permissive + 仅 localhost,面薄 | M7:HMAC / temp TTL / 脱敏 / CSP | **byCLI 远胜** |
| UI / 三层 | 纯 headless CLI | dashboard + dashboard-be + docs | byCLI |

## 3. 选择器策略:vercel `@e` vs byCLI 三层

### 3.1 vercel agent-browser 的 `@e`(`cli/src/native/snapshot.rs`)
1. 快照源 = **CDP `Accessibility.getFullAXTree`**:Chrome 直接给 role/name/backendDOMNodeId。
2. 发 ref 对象:`INTERACTIVE_ROLES`(总发)、有名字的 `CONTENT_ROLES`、**cursor-interactive 元素**(单独 DOM 扫描补 div-当按钮)。
3. `ref_id = e{N}` 顺序计数器(`@e1`…),存进 `RefMap`:ref →(backendDOMNodeId, role, name, frame);`role:name:nth` 去重。
4. **纯临时句柄**:导航/重渲染即失效,失效就重 `snapshot`。**无漂移救援、无持久化**。

### 3.2 byCLI 三层(各有专属文件)

| 层 | 文件 | 机制 | vercel 有无 |
|---|---|---|---|
| **本回合定位** | `src/browser/dom-snapshot.ts` | 注 JS `querySelectorAll` + 打 `data-bycli-ref` 属性 + JS 算 ARIA name,序列化 `[58]` | ✅ 等价(它走 AX-tree) |
| **会话内漂移救援** | `src/browser/target-resolver.ts` | ref 存**指纹** `{tag,role,text,ariaLabel,id,testId}`,实时比对分 `exact`/`stable`/`reidentified`;原节点没了靠指纹**重认** | ❌ **完全没有** |
| **跨周持久复用** | `clis/<site>/*.js` | adapter = **手写 JS**,用 `data-testid`/`aria-label` 语义稳定选择器(如 `clis/twitter/quote.js`) | ❌ **完全没有** |

### 3.3 核心差异(一句话)
**vercel 为「单回合、LLM 友好、即用即弃」优化**(AX-tree→`@eN`→操作→变了就重拍);**byCLI 为「持久 + 抗漂移」优化**(产品是"录一次→稳定可重放的 CLI")。两者在**本回合定位层趋同**(都 AX-ish role/name + 临时 ref + nth 去重 + cursor-interactive 补抓),分歧全在**目标函数**。

## 4. 核实后【不要照搬】的点(避免 cargo-cult 倒退)

本次调研最重要的产出是这张「否决表」——多处看似可借鉴,核对源码后发现 byCLI 要么已有、要么更强、要么对它根本不成立:

| 候选借鉴点(来自对手) | 核实结论 | 依据 |
|---|---|---|
| abc 的 **stale-attach 恢复** | byCLI **已有且更强**:`ensureAttached` 先用 `Runtime.evaluate('1')` 探活已 attach 会话(abc 只查 `getTargets` 标志),retry 循环每次 attach 前**无条件 detach** 清陈旧状态 | `extension/src/cdp.ts:67`(`ensureAttached`)、`:83-149` |
| abc 的 **「别先健康检查」skill 话术** | **不成立**:abc 唯一外部依赖是扩展,`daemon_not_running` 是假警报;byCLI 的 `bycli doctor` 是**真实端到端探活**(`bridge.connect` 顺带 auto-start daemon + `page.evaluate('1+1')`),并诊断 **Chrome 没开/扩展没装/profile 没选** 这类 agent 自己修不了的真前置 → doctor-first 合理 | `src/doctor.ts:80-160` |
| vercel 的 **cursor-interactive 抓取**(div 当按钮) | byCLI **已抓**:`isInteractive` 查 `onclick/onmousedown/ontouchstart`、`tabindex!=-1`、`getComputedStyle.cursor==='pointer'` | `src/browser/dom-snapshot.ts:403-425` |

**唯一真正可考虑的窄点**:vercel 用 `Accessibility.getFullAXTree` 拿的是 **Chrome 按规范算好的 accessible name**(正确处理 `aria-labelledby`/`label[for]`/alt/title 回退链);byCLI 在 `dom-snapshot.ts` 里**自己用 JS 算 name**(149 行起),复杂场景(labelledby 链)可能不如 Chrome 完整。**但**换成 AX-tree 会丢掉 `data-bycli-ref` + 指纹这套漂移救援的根基——所以这不是干净替换,**最多作为"名字算不准时拿 AX-tree 交叉校验"的补充**,不值得伤筋动骨。

## 5. 已落地的小改动

依据 §4 的核实,只移植了 abc 唯一真正可移植的窄点(瞬时 daemon-down 自愈、别手动 restart、只为真前置停下),改到 [skills/bycli-browser/SKILL.md](../skills/bycli-browser/SKILL.md) 的 Prerequisites 段——**保留 doctor-first**(它对 byCLI 是对的),不与排障表(扩展卡住才 restart)冲突。其余候选点均**未改**(已有/更强/不成立)。

## 6. 结论:byCLI 的护城河

两个对手都没有的两层,是 byCLI 最值钱的部分:
1. **`target-resolver` 漂移救援**(`exact`/`stable`/`reidentified` 指纹重认)——会话内抗 SPA 重渲染/i18n 换标签。
2. **持久 `adapter` 层**(`clis/<site>/*.js` 用语义稳定选择器,"录一次→可重放 CLI")——这是产品定位的核心。

vercel 是更好的「单回合现场操作器」,sleepinginsummer/abc 是更精简的「真实浏览器现场操作器」,而 **byCLI 是更完整的「把网站沉淀成 CLI 的产品」**。后续若要继续深挖,最有价值的方向是 byCLI **recorder 如何把一次 live 操作固化成 `clis/<site>/*.js` 里那种 `data-testid` 选择器**(录制→持久化管线),那是两个对手完全空白、也是护城河的成因。
