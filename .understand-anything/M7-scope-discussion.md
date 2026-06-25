# M7（安全/数据策略）切分讨论 brief — 给 Codex 对抗式复审/裁决

## 背景
byCLI Adapter Recorder，三层架构：`dashboard/` 前端 · `dashboard-be/` 后端(独立 ESM,经 daemon HTTP 不 import 主仓 src/) · byCLI 主仓 `src/`(daemon + 浏览器底座 + high-level 托管)。M0–M6 已全部落地(导航 spike / page lease / core engine / analyze·init·verify / verify runner 子进程隔离)。现进入 **M7**。

## M7 权威范围(`dashboard-docs/system/adapter-recorder-system/11-roadmap-and-acceptance.md:47-52`)
5 块:① CSRF/Origin/header/token gates ② Electron XSS defenses ③ seedArgs HMAC ④ temp store TTL ⑤ redaction。
①② 多在 M2 已落地(04 章 localhost guard),M7 是审计/收尾;③④⑤ 是实质新工作。
验收(11:74,82,83):security=cross-origin blocked / token hidden / Electron XSS / **no raw sensitive logs**;data=**report only redacted shape/HMAC summaries**;observability=requestId propagated / structured logs / metrics without sensitive fields。

## 逐块 gap(Explore 调查,精确 file:line)

### 块 A — session-keyed HMAC
- 占位 `daemon-${PORT}`(`src/daemon.ts:282`),**确定性 / 跨进程稳定 / 跨 session 复用** → 违反 `04:112` "cross-session HMAC 不可关联"。
- 纯算法已正确:`packages/recorder-core/src/verify.ts:34-54` `deriveEvidenceSeedArgs(raw, sessionHmacKey)` = `createHmac('sha256', key)`,输出 placeholder/type/hmac(32hex)/length/hmacScope='recorder_session'/comparableAcrossRuns=false/usage='display_only'。key 是注入参数(纯函数),无需改。
- 注入 seam 已预留:`src/recorder/highlevel/verify.ts:74,82` `verifyAdapter(input, sessionHmacKey, runner?)`。
- **根因 gap**:`04:111` 要求 salt **per-session + memory-only**,但 **recorder session 实体在 `src/` 不存在**(`05:74` 描述 per-session 线性化 + stateVersion CAS + 每会话 mutex,纯文档;grep `createSession|sessionId|stateVersion` 于 `src/recorder/**`+`daemon.ts` 零命中)。salt 无处挂载。
- HMAC key **不进 input.json、不传 child runner**(`runner-port.ts:199` 只传 rawSeedArgs);derive 在 daemon 进程内完成即随 summary 走。现有架构已正确。

### 块 B — temp TTL
- 现状:生命周期 cleanup(done/cancel/timeout)✅ `runner-port.ts:131-133,179,344-346`;startup reap(仅按 ownerPid 死活)`reap.ts:66-68,127`,`daemon.ts:550` 启动调一次。
- 缺:**完全没有"基于时长 TTL"**。reap 不读 marker `startedAt`(虽 `runner-port.ts:123`/`reap.ts:45` 已写)做年龄比较;`RECORDER_TEMP_TTL_MS`(default 1h)/`RECORDER_STARTUP_REAP_MAX_AGE_MS`(24h)/`RECORDER_ORPHAN_KILL_GRACE_MS` 三键(`09:27-29`)**代码零引用**(已 grep 确认);reap 是 startup-only 非周期。

### 块 C — 脱敏(redaction)
- 现状:summary-only 白名单防护 `recorder-core/verify.ts:118-131`;raw seed 唯一落点 input.json(0600)。
- 已有成熟 redaction 库 `src/observation/redaction.ts`(redactValue/redactText/redactHeaders/redactUrl,含 Bearer/JWT/cookie/token 正则)但 **recorder/daemon 未 import**。
- 缺:daemon/runner 错误出口 `daemon.ts:287,292` + `runner-port.ts:213,256,282` 直接回传 `err.message`/`result.reason` **未脱敏**(若 adapter 抛错含 seed 值会泄漏);缺 `09:118` 要求的集中 redact-before-write 关卡。

## 我的切分提案(请裁决是否合理)
- **M7b temp TTL**(完全独立、最低风险):reap 加 `startedAt` 年龄分支 + 接 3 个 09 配置键 + 可选周期 sweep。
- **M7a-0 session skeleton**(HMAC 硬前置):建 recorder session 实体 + memory-only 随机 salt。
- **M7a HMAC**:daemon 按 sessionId 查 salt 替换 `daemon-${PORT}` + be→daemon 注入链(body 带 sessionId)。
- **M7c 脱敏**:复用 `src/observation/redaction.ts`,daemon/runner 错误出口接 redact-before-write 关卡 + 补 `09:107-116` Forbidden log fields 过滤 + 测试。
- **M7d**(可选):gates/XSS 审计(M2 已落地,回归审计对照 04:15-47)。
- 推荐顺序:M7b → M7a-0 → M7a → M7c → M7d。

## 需要 Codex 裁决的关键决策点
1. **session skeleton 归属(最关键)**:per-session memory-only HMAC salt 挂哪?
   - 选项 X:**daemon 进程内存表**(daemon 维护 sessionId→salt map,be `/v1/verify` 传 sessionId,daemon derive)。salt 永不出 daemon 进程。
   - 选项 Y:**be session registry**(be 已有 `dashboard-be/src/session/registry.ts` 的 session,但 HMAC derive 在 daemon;若 be 持 salt 则须过 wire 给 daemon → 疑似违反 04:111 memory-only 不入 wire)。
   - 约束:`04:111` salt memory-only、不入 wire、不可配置;derive 发生在 daemon 进程(verifyAdapter)。⚠️ 关键子问题:dashboard-be 的 session 与 05 章"recorder session"是否同一概念?跨三层(前端/be/daemon)的 session 身份如何统一?salt 由哪层生成/持有?
2. 切分顺序(M7b→M7a-0→M7a→M7c→M7d)是否合理?M7b 先做有无隐藏依赖?
3. 我遗漏的 gap/风险?
4. observability(11:83 structured logs/metrics)属 M7 还是 M8(09 章 observability)?M7d gates/XSS 审计并入 M7 还是留 M10 acceptance?

**请对抗式复审**:挑战我的切分、给出 session skeleton 归属的明确选择(含理由,尤其跨层 session 身份问题)、列我遗漏的风险。别只附和。
