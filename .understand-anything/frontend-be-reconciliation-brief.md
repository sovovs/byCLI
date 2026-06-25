# 前端 client ↔ be 真实契约 reconciliation — Codex 讨论 brief

## 背景
dashboard/ 前端的 RecorderClient/类型/mock 当年照「理想契约」手写,dashboard-be 落的是「真实契约」。
现在要做「前端端到端真实联调」(真 client → 真 be → 桩 daemon 跑通 8 步录制链路)。
核对发现 8 处契约漂移。**裁判 = schemas/(recorder.openapi.yaml + adapter-recorder.bundle.json)**,
不是只看 be 代码。已确认:每处争议都是**前端过时**,be 符合契约。方向 = 前端向契约对齐
(遵 memory「schema↔实现 drift 以实现/契约为权威」)。

## 要读的文件(只读)
前端:
- dashboard/src/services/httpRecorderClient.ts(真实 HTTP client)
- dashboard/src/services/recorderClient.ts(RecorderClient 接口)
- dashboard/src/services/mockRecorder.ts
- dashboard/src/models/useRecorderSession.ts(状态机 model)
- dashboard/src/types/recorder.ts(前端契约类型)
- dashboard/src/pages/Workbench/steps/InitStep.tsx
- dashboard/src/pages/Workbench/steps/VerifyStep.tsx
- dashboard/src/pages/Workbench/index.tsx
be:
- dashboard-be/src/server.ts(handler;be 是契约一方)
契约(裁判):
- dashboard-docs/system/adapter-recorder-system/schemas/recorder.openapi.yaml
- dashboard-docs/system/adapter-recorder-system/schemas/adapter-recorder.bundle.json

## 契约硬事实(已核)
- CaptureStartRequest required = [sessionId, sampleName, **trigger**]
- InitRequest required = [sessionId, **name**, **writePolicy**, **selectedCandidateId**];write 时 required responsibleUseAcknowledgedAt;select-only(domain/strategy/endpoint 服务端从候选派生)
- VerifyRequest required = [sessionId, **name**]
- RequestStatus.result:verify → bundle $defs/VerifySummary(M6 已落地,be 真返回它)
- bundle RecorderReport = {adapterPath, reportPath, warnings?, responsibleUseAcknowledgedAt, releaseChannel, localExperimentProfile, configSnapshotVersion}(无 diff 字段)
- bundle VerifySummary = {ok, stage?, rows?(数量), rowShape?, fixture?, trace?, error?}(无原始行数据——安全设计 M7c:report only redacted shape)
- bundle RankCandidate props 与前端 types RankCandidate 一致

## 8 处漂移 + 我的拟定方案(请逐条批判 + 给更优解)
1. captureStart 漏 `trigger`:client 写死 `trigger:'user_manual'`(UI 即手动触发),不改接口。
2/3. init/verify 漏 `name`:把 `name` 串进 client init/verify;model 从选中候选 endpoint.host+pathname **自动派生** `site/command`(用户已定:自动派生);保持 model action 签名不变 → Workbench 不动。
4. rank 响应是 `{...,candidates:[]}` 对象、client/model 当数组:client 从 envelope.data 抽 `.candidates` → RankCandidate[]。
5. init 响应 `{report,dryRun}` vs 前端扁平 AdapterDraft:**重塑前端 AdapterDraft 镜像 be**(report: RecorderReport + dryRun: {exists,changedLines}),改 InitStep 渲染 report 字段 + changedLines,**删掉伪 unified-diff 字符串**(契约无此物)。
6. verify 响应 VerifySummary vs 前端 VerifyResult(rows 数组):**用 VerifySummary 替换 VerifyResult**,重写 VerifyStep 成 summary 视图(行数 + rowShape.keys + fixture/trace 状态),**不再渲染数据表**(安全:无原始行)。
7. init 写入/同意(契约强制):InitRequest 必带 writePolicy,write 必带 responsibleUseAcknowledgedAt。UI 流程:Init 步先 **dry-run 预览**(显示 exists/changedLines)→ 显式「确认写入」+ ADR-0005 责任声明勾选 → write(responsibleUseAcknowledgedAt=Date.now)→ 推进 ranked→draft_created → 解锁 verify。状态机支持从 ranked 多次 init(dry-run 不推进、write 推进)。
8. captureRead entries:be 透传原始 daemon 抓包条目(`{requestId,method,url,responseStatus,responseContentType,responsePreview}`),既非 bundle RecorderNetworkEntry 也非前端 NetworkEntry。client 映射成前端 NetworkEntry(仅展示;rank 在服务端做)。**疑点:be 原始抓包格式是否偏离契约 RecorderNetworkEntry?**(be 归 M7 会话,别改 be,只标注)。

## 请 Codex 回答
A. **核心工程取舍**:map-in-client(httpRecorderClient 翻译 wire→domain 类型)vs **重塑前端类型对齐契约**(types+mock+UI 都改成契约形状)。我倾向后者(更诚实、无隐藏翻译层;代价是 mock 也要产契约形状)。哪个对?
B. 逐条方案(1-8)对不对?#5/#6 重塑类型 vs 映射,哪个?#7 dry-run→确认写入→verify 流程与状态机是否成立?
C. **陷阱**:重复 dry-run init 的 Idempotency-Key 冲突?be handleVerify:437 残留调试字段 `_d`(要清但别动 M7 的活)?contract-drift 校验脚本(dashboard/scripts/check-contract-drift.mjs 只校 ErrorCode)是否需扩?mock 改后 RecorderClient 类型约束?#8 be 抓包格式 vs RecorderNetworkEntry 是否真 gap?
D. **分趟 vs 一趟**:我倾向分趟(A 趟=请求侧+rank+绿 harness 到 ranked;B 趟=init/verify 响应重塑+类型+UI+写入同意)。还是一趟更好?
E. 有没有我漏掉的第 9 处漂移?(尤其 confirmAuth/navigate/bind/cancel/analyze 链路、RequestStatus 轮询语义、idempotency)

输出:逐条裁决(采纳/改/驳)+ 推荐落地顺序 + 风险清单。别写代码,给设计结论。
