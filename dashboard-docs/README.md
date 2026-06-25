# dashboard-docs · 结构提案(system 已迁入)

> 状态:**部分执行**。系统设计已迁入 `dashboard-docs/system/adapter-recorder-system/`,`TDD.md` 已迁入 `dashboard-docs/` 根(作为跨 system/ui/api 的治理总则)。`ui/`、`api/` 子层待补(见迁移步骤 3/4)。

## 背景

当前三处现状:
- `dashboard/` — 前端页面实现(Umi Max + antd 5,已落地 `/docs`、`/workbench`)。
- `dashboard-docs/system/adapter-recorder-system/` — 一套自洽的**系统/架构设计**(11 模块 + adr/ + schemas/),几乎不含页面设计。
- 计划新增 `dashboard-be/` — **真实 Recorder Local Service 的 HTTP 形态**(已确认定位)。

目标:把"整套系统设计"重组为三层文档——系统设计(保留)、页面设计(新增)、后端接口设计(引用现有契约 + 补传输层),支撑 `dashboard/` 前端与 `dashboard-be/` 后端两条实现线。

## 关键前提(已与用户确认 + Codex 复审修正)

1. `dashboard-be/` 的**目标**是真实 Local Service,但 Codex 复审指出:由于走 HTTP,它必须明确定位为 **04 章里 feature-gated 的 localhost HTTP transport**(`FEATURE_LOCALHOST_HTTP_UI=true`),不能直接宣称"真实 Local Service"。不补全安全门禁前,它只等同 mock/demo。
2. 系统设计文档 **整体保留、不拆**,在其上新增 UI 层。

由前提 1 引出的定位问题**已由用户正式拍板确认**:`dashboard/` 正式定位为 ADR-0001 里那个**可选 localhost HTTP UI**,`dashboard-be/` 是其 feature-gated HTTP 形态 Local Service。

**交付条件(已接受为硬性义务,缺一不可)**:`FEATURE_LOCALHOST_HTTP_UI=true` 开关、仅监听 `127.0.0.1`、启动随机 token / bootstrap 注入、Origin allowlist、自定义 header gate、CSRF token、POST-only side-effect、no-CORS。并须有对应测试(CSRF/header/Origin)。**用户已接受:实现 `dashboard-be/` 即承担 04 章全套安全门禁,不实现门禁则不得对外宣称为 Local Service。**

## 目标目录结构

```
dashboard/                     # 前端(现状,保留)= 「可选 localhost HTTP UI」形态
dashboard-be/                  # 真实 Local Service 的 HTTP 形态(薄封装 + 安全门禁)
dashboard-docs/
  README.md                    # 本文件:总入口 + 三条铁律 + 迁移说明
  system/                      # = 现有 adapter-recorder-system/ 整体迁入,不拆
    00-tdd-governance.md ... 11-roadmap-and-acceptance.md
    adr/                       # 关键决策记录(0001-ui-channel 等)
    schemas/                   # 契约单一来源:adapter-recorder.bundle.json + *.openapi.yaml
  ui/                          # 新增:页面设计(净新增,现有文档没有)
    00-overview.md             # 信息架构、导航、页面清单、与 system 的映射
    01-design-system.md        # = dashboard/design-system/MASTER.md 的设计层来源
    pages/
      docs.md                  # /docs 页面设计(阅读型)
      workbench.md             # /workbench 页面设计(Data-Dense + 8 步状态机映射)
  api/                         # 后端接口设计:引用 system/schemas,补 HTTP 传输层
    00-transport.md            # HTTP 形态:路由 ↔ /recorder/* 映射、统一响应包
    01-security-gates.md       # 04 章落地:Origin/CSRF/token 门禁的 HTTP 实现
    02-error-mapping.md        # ErrorCode → HTTP status 映射(引用 schema $defs/ErrorCode)
```

## 三条铁律(否则三层会互相打架)

### 铁律 1 · 契约单一来源 = 整个 system/schemas/
`api/` 与 `ui/` 一律**引用** `system/schemas/`,绝不重定义类型或错误码。
**Codex 复审修正**:契约源不是只有 `adapter-recorder.bundle.json`,而是**四文件并列**(00 章 CI gate 四者并列):
- `recorder.openapi.yaml` / `high-level.openapi.yaml` / `daemon-high-level.openapi.yaml` —— 三个 OpenAPI,管 transport / route / envelope / idempotency / request body(`daemon-high-level.openapi.yaml` 是 dashboard-be 实际转发 FS/子进程能力的 daemon `/v1/init`、`/v1/verify`)。
- `adapter-recorder.bundle.json` —— 管共享 domain/error/runner `$defs`(ErrorCode/EndpointDescriptor/RankCandidate 等)。

`api/` 只补 HTTP 传输、安全、状态码映射,**不重定义路由或类型**。
**Drift 风险**:前端 `dashboard/src/types/recorder.ts` 当前是**手写"对齐"**而非生成,须加类型生成或 contract-drift 校验,否则会与 schema 漂移。

### 铁律 2 · dashboard-be 是封装不是重造 + ownership 规则
真实 Local Service 的职责是**封装** byCLI 主仓既有能力(`src/daemon.ts`、`src/browser/`、`src/adapter-*`),只补 HTTP 入口 + 安全门禁 + session/lease/registry 管理。
依据 01/05/07 章与六边形架构(02 章)。
> **实现状态(截至 2026-06-25,M0–M7 全落地)**:`dashboard-be/` 已是完整的 feature-gated Local Service(独立 ESM 进程经 daemon bridge,不 import 主仓 `src/`):`/recorder/*`(health/session·bind/confirm-auth/navigate/capture/rank/analyze/init/verify/requests/cancel)全套 + 04 章安全门禁全套 + 同源 UI 托管(含 M7d CSP)。主仓 daemon 在原有 `/ping`/`/status`/`/logs`/`/shutdown`/`/command` 之外加了 high-level 端点 `/v1/init`、`/v1/verify`、内部 `/v1/requests/{id}`(ADR-0007)。M1 导航硬门禁已过(真实链路 live no-hit PASS)。纯 domain 全在共享包 `packages/recorder-core`(铁律 2 的 ownership 规则已遵守)。逐里程碑明细见 `architecture-relationship.md` 与 `11-roadmap-and-acceptance.md`。

**Codex 复审补充的 ownership 规则(关键)**:application / domain / high-level 可复用模块**最终归属主仓 `src/` 或共享包**,`dashboard-be/` 只放 HTTP adapter、bootstrap、安全门禁。
否则核心服务若先落在 `dashboard-be/` 私有目录,未来主仓 Local Service 很可能**重复实现或反向依赖 dashboard-be**。

### 铁律 3 · 安全门禁不可选
`dashboard/` 既定位为 localhost HTTP UI,`dashboard-be/` 必须实现 04 章门禁:仅监听 `127.0.0.1`、Origin allowlist、自定义 header gate、CSRF token、POST-only side-effect、启动随机 token。
不能当成普通 web 后端裸接。

## 迁移方式(分步,不一次性执行)

1. ✅ **已建** `dashboard-docs/` 骨架 + 本 README。
2. ✅ **已迁** `dashboard/docs/adapter-recorder-system/` → `dashboard-docs/system/adapter-recorder-system/`,`TDD.md` → `dashboard-docs/` 根。注:`dashboard/docs/` 原未纳入 git,故用 `mv`(无历史可保);`dashboard/docs/` 已移除。
3. 新增 `ui/`:从已落地的 `dashboard/src/pages/*` 反向补页面设计文档 + 迁移 `design-system/`。(待做)
4. 新增 `api/`:基于 system/schemas 写 HTTP 传输层 + 安全门禁设计。(待做)
5. ✅ **已更新** CLAUDE.md + memory 里的文档路径(现指向 `dashboard-docs/...`),并同步 `dashboard/src/pages/Docs/modules.ts` 的 `P` 常量。

## 待复审确认的问题

- **Q1(已拍板 ✅)**:`dashboard/` 已正式接受「localhost HTTP UI + 04 章安全门禁」定位。`dashboard-be/` = feature-gated HTTP 形态 Local Service,实现即承担全套安全门禁。
- **Q2(已拍板 ✅)**:`dashboard-be/` = 独立 ESM/TS 进程,**不 import 主仓 `src/`**,经 daemon bridge(HTTP `/command` + high-level `/v1/*`)调主仓能力。技术栈/门禁/ownership 见记忆 `dashboard-be-m2-shell`。
- **Q3(已失效)**:历史上记录有 `dashboardCodex/docs/` 与 `dashboard/docs/` 两份并行设计,实际只存在 `dashboard/docs/` 一份(`dashboardCodex/` 目录已不存在),无需合并。是否迁入单一 `dashboard-docs/system/` 仍按上方迁移步骤推进。
- **Q4**:schema bundle 物理只放一份在 `system/schemas/`,前端/后端都引用它——是否需要发布为内部包以避免跨目录相对路径引用?
- **Q5(已收口 ✅)**:M1 navigation / request interception spike **已先行落地并真实链路验证通过**(扩展经 `chrome.debugger` 在导航前 arm Fetch 拦截,daemon→扩展→浏览器全链路 live no-hit PASS,tier=ip-observed-only,ADR-0006);dashboard-be 的 navigate/capture 随后经 daemon `/command` 接通(M3)。arbitrary navigation 仍依 ADR-0006 能力分级(strict-ip-enforced 为 post-MVP)。
- **Q6(已处理 ✅)**:迁移后硬编码路径已同步:`dashboard/src/pages/Docs/modules.ts`(`P` 常量改为 `dashboard-docs/system/adapter-recorder-system`)、CLAUDE.md、memory、`src/browser/url-policy.ts` 注释。前端类型生成路径如另有引用需复查。

## 遗漏的阻塞性问题(Codex 复审发现,接真后端前必须解决)

这两条不解决,前端无法从 mock 切到真实 Local Service:

1. **mock 接入未抽象出 HTTP client**:`useRecorderSession.ts` 直接 `import mockRecorder`,`mockRecorder.ts` 自身也标注后续要替换。真实接入前必须先定义 HTTP client + token/bootstrap 注入 + 错误/状态轮询机制。
2. **UI 状态机与真实 API 有差异**:
   - 真实流程要求 `capture/start` + `capture/read` 两步驱动每个 A/B 样本(05 章),但当前 model 直接调 `captureRead('A'/'B')`,省略了 start。
   - `confirmAuth` 在 allowed transitions 里声明了,但 actions 未暴露真实调用路径(`awaiting_user_login → auth_confirmed` 这条分支前端没走通)。

> 这些是前端实现与契约的已知偏差,接真后端时需对齐 05 章状态机,不属于本目录提案的范围,但必须在 `dashboard-be/` 落地前一并修。
