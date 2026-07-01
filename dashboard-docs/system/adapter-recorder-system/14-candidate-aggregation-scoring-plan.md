# 候选接口聚拢 + 评分重构 落地计划 (v2,已过 Codex 计划评审)

> 来源:2026-06-30 与 Codex 两轮设计讨论 + 四轮真机数据 prompt 实验 + 一轮 Codex 计划评审(挑出 6 High + 4 Moderate 实现坑,全部吸收进本版)。
> 实验证据:同输入同模型(gpt-5.5 经网关),article_rank 从旧架构 30/low → 新 prompt 88/high;4 个 browser-settings 聚成 1 条且仍 reject;seed 正例 search/articles 判出 seed_arg_maps_to_param=present + keyword seed_argument(92/high);token 顺带省 64%(同 endpoint evidence md5 相同,现被复制 N 份)。

## 两个诉求

诉求1(聚拢):同 endpoint(method+host+pathname)被多次调用、参数集不同时,现在 rank 按请求实例逐条出候选(candidateId 带 index),参数分散。要按接口聚拢、参数取并集、推断每个参数含义。
诉求2(评分):候选分数普遍偏低。根因=正分上限 60 < high 阈值 75,high 数学不可达;且 LLM 被降级成信号布尔判定器,真实好接口永远 low。
依赖:**先聚拢、再改评分**(聚拢出参数全集后 seed→param 识别率自然上升)。

## 🔴 核心架构原则(Codex High 1,贯穿全计划)
**确定性事实归 recorder-core,语义推断归 LLM。** core 是纯 domain 层,只能产出可靠观测事实;`type=hot 是不是查询维度`、`category_id 该不该暴露`是语义判断,必须由 LLM 出,core 不许假装确定。这条决定了下面所有字段的归属。

## 现状权威实现(已核实)
- `rank.ts:84` 按 pair 实例逐条出候选 candidateId(a,i);`pairing.ts:24` pairKey=method+host+pathname+mime+bodyShape.kind。
- `normalize.ts:70` endpoint.queryParams 只含该次调用 stable query,非并集。
- `score.ts` 规则评分,DEFAULT_SCORING_PROFILE 正分上限 60;`scoreCandidate` 的 ScoreContext **没有 pair.b/聚合信息**。
- `dashboard-be/llm/score.ts:140` createScorer **把 profile 冻结在闭包**;`server.ts:591` 合并 LLM 结果时 scoreExplanation **delta 全填 0**;`synthesize.ts:154` buildSampleSummary **只按 pathname 子串匹配**(`url.includes(pathname)`)。
- `generate.ts:75` 把 endpoint.queryParams 当"可组请求模板的观测参数值"喂 LLM 生成 fetch。
- `pipeline.ts:84` 按 candidateId 找原始候选。
- bundle schema `additionalProperties:false`,但 BE 已返回 `scoredBy` → **现存契约漂移 bug**(顺带修)。

## 落地步骤(Codex 建议的安全顺序:先护栏 → 只加事实 → BE parser → 双轨 → 最后改默认值 → 前端)

### 第0步:先加测试护栏(改任何逻辑前)
- core:聚拢用例、mixed shape primary 选取用例。
- be:buildSampleSummary host+method+pathname 精确匹配用例、score 双轨 parser 用例。
- 这批测试先红,后续实现转绿。

### 第1步:recorder-core 加 endpoint 聚拢层(只出事实字段)
- 新增 `groupPairsByEndpoint(pairs: Pair[]): EndpointGroup[]`,插在 `rankSamples` 的 `pairSamples()` 之后、候选构造循环之前。**不动 pairing.ts**。
- 聚拢键 = `method + host + pathname`(不带 query、不带 response shape kind)。**第一版不做路径参数化**。
- **primaryPair 选取要有优先级(Codex High 4)**,不能取组内第一条:① 2xx+array ② 2xx+object 且 itemKeys 丰富 ③ paired 优先 single ④ response body present ⑤ 顺序兜底。
- EndpointGroup 保留:
  - `primaryPair`:兼容现有评分 + endpoint 基础字段。
  - `pairs`/`entries`:evidence、shape variants 来源。
  - **`paramObservations[]`(只放事实,Codex High 1)**:`{ name, in:'query'|'body', observedCount, totalCalls, observedSamples, observedAlways, observedVariation: true|false|'unknown', valueKinds, dynamicLike, cursorLike }`。**不放 paramRole/exposeAsArg/inferredMeaning**(那些是 LLM 的活)。
  - `responseShapeVariants` + `mixedResponseShape`(Codex High 4/Q1b):shape 不参与聚拢键但保留差异,mixed 时标 reviewRequired。
  - `evidenceIds`=合并后的 requestIds(**不叫 mergedCandidateIds**,Codex Moderate 4:core 聚拢后没有"被合并的 candidateId" 概念,只有 requestId);debug 字段叫 `mergedRequestIds`/`groupedPairIndexes`。
- **`endpoint.queryParams` 保持向后兼容(Codex High 2)**:仍代表"代表性请求里的稳定非动态 query,能实际组 URL",**不改成参数并集**。参数全集只放 paramObservations。`args` 仍只放已证明 seed 映射的。`urlTemplate` 若含并集参数必须区分 required/optional,否则不塞 optional union。
- `RankCandidate`(types.ts)加可选字段 `paramObservations?` / `responseShapeVariants?` / `mergedRequestIds?`,旧字段兼容。
- **本步不改评分默认值、不改前端主展示。**

### 第2步:dashboard-be/llm/score.ts — prompt 支持 paramObservations 输入 + paramUnion 输出
- PROMPT_A 换成验证版(实验已过),含:聚拢意识(若 core 已聚拢→改成"以下是 core 已聚拢的 endpoint group,paramObservations 是确定性事实,你来判语义角色")、`inferredFunction`、参数角色枚举(7类)。
- **LLM 输出 paramUnion(语义推断,Codex High 1)**:`{ name, paramRole:pagination|dynamic|infrastructure_constant|query_dimension|seed_argument|auth_session|unknown_constant, exposeAsArg:yes|optional_candidate|no, inferredMeaning, confidence, why }`。铁律:"不要把 observedVariation=false 等同 fixed";seed_argument 须值确实随输入变。
- **保证 LLM 返回的 candidateId 仍是输入里的 core candidate id(Codex Moderate 4)**,否则 pipeline.ts:84 找不到原始候选。
- **buildSampleSummary 改精确匹配(Codex High 3)**:解析 URL 后 `method===endpoint.method && host===endpoint.host && pathname===endpoint.pathname`,解析失败才 fallback 子串;不再用 substring 当主路径(否则同 path 不同 host/GET vs POST/`/api/article` 误召回,聚拢后污染更大)。
- buildSampleSummary 同步按 endpoint 去重证据(省 64% token),但**保留少数代表 responseBody**(不全删,否则丢"参数变化→响应变化"的 seed 证据)。

### 第3步:be 双轨求权威分 + scoreExplanation 真 delta
- LLM 输出 `ruleSignals`(可审计事实)+ `semanticSignals`(带 strength)+ `llmUtilityScore`(辅助,非唯一权威)。
- `finalScore = clamp(deterministicRuleScore + semanticBonus, hardReject→0)`:
  - deterministicRuleScore = be 按固定 delta 对 ruleSignals 求和(可复现)。
  - **semanticBonus 要 allowlist + 每类一次 + 总 cap(Codex Moderate 1)**:`SEMANTIC_BONUS={response_varies_with_seed:{strong:15,med:10,weak:5}, rich_business_data:{10/6/3}, endpoint_semantic_data:{8/5/2}, param_interpretable:{8/5/2}, pagination:{5/3/1}}`,`semanticBonus=min(25, sum(allowlistedUnique))`。
  - **去重边界(Codex Moderate 1)**:rich_business_data 不能只是 array/object(要字段丰富/列表规模),否则和 stable_json_shape 双重计分;param_interpretable 不奖励已计入 seed_arg 的参数;hardReject 后 finalScore 强制 0,bonus 不翻案。
- **scoreExplanation 填真 delta(Codex Moderate 2)**:rule signal 用 profile delta、semantic signal 用 bonus delta,不再全 0(前端 PipelineStep:34 用 delta>0 判 seed 命中);llmUtilityScore 独立字段不塞进 explanation。
- **createScorer 别冻结 profile(Codex High 6)**:profile 放进 ScoreInput(`ctx.scorer.score({candidates,samples,cap,profile})`)或 score(input,profile),否则热 reload/preview profile 下规则 rank 与 LLM 求分用两套 profile。

### 第4步:改 DEFAULT_SCORING_PROFILE + core/LLM-off 信号(放最后,影响面最大)
- 调 delta(Codex Q2a):stable_json +25→+30、新增 response_varies_with_seed +15 等;阈值 high 75→70 / medium 50→45 / low 20。endpoint_semantic_data 路径词只作**弱正向**(+5~10,不当主力——/monitor_web 无语义词靠 host/响应判、/track-list 含 list 却是埋点)。
- **新增 ScoringProfile key ≠ LLM-off 自然生效(Codex High 5)**,二选一:
  - ① 要让 LLM-off 也受益 → 扩展 ScoreContext 把 group/paired B/paramObservations 传进 core scoreCandidate,在 core 实现这些确定性信号。
  - ② 只给 LLM 语义层用 → **不放进 ScoringProfile**,单独建 BE 内部 `SEMANTIC_BONUS_TABLE`(避免配置项看着可调但 core 永不用)。
  - 倾向②:语义信号本就是 LLM 判的,放 core profile 名不副实。ScoringProfile 只加确定性能算的(如 response_varies_with_seed 可由 paired A/B 响应 diff 在 core 算)。
- **契约同步(Codex Moderate 3)**:ScoringProfile 是**进程本地配置,不在 wire bundle** → 同步范围=types.ts/config.ts/config.test.ts/09+06 文档;bundle/前端要同步的是新增的 **RankCandidate 可选字段**(paramObservations/responseShapeVariants/inferredFunction/llmUtilityScore)+ **顺带把现有 scoredBy 加进 bundle**(修现存 additionalProperties:false 漂移)。

### 第5步:前端拆 rank 分 / verify 状态(Q2b)
- 候选卡:`inferredFunction`(接口功能)+ 参数全集表(paramObservations 事实 + LLM paramUnion 的 exposeAsArg 标必填/可选/不暴露)+ 来源标签。
- 单一 0-100 拆成 `Rank confidence`(录制证据置信)+ `Verify status`(passed/failed/not run + rows/fields)。verify passed 不再显示成垃圾档。
- CandidateCard / PipelineStep CandidateTable 同步;rowKey 仍用 candidateId(聚拢后 id 语义变化,注意已选 id 迁移)。

## 不做(本轮明确排除)
- 路径参数化(/users/{id})——第二阶段保守启用。
- 聚拢透明度交 LLM 当主逻辑——core 确定性做,LLM 最多输出 debug mergeAssessment。
- 纯 LLM 拍总分作唯一权威——双轨。

## 验证清单
- core:聚拢 + paramObservations 事实字段 + mixed shape primary 优先级 + 旧用例兼容。
- be:新 PROMPT_A 回归(browser-settings reject / article_rank high / type+category_id=query_dimension / seed 正例 seed_argument)+ 双轨求和 + semantic cap/去重 + scoreExplanation 真 delta + buildSampleSummary 精确匹配 + 证据去重。
- 前端:候选卡新字段 + rank/verify 拆分 + candidateId 迁移。
- 契约漂移校验通过(RankCandidate 新字段 + scoredBy 补进 bundle)。
- 三端 tsc 净。
- 真机:换 1-2 个站点复跑确认泛化。

## 风险
- 去重删 responseBody 会丢 seed 判定证据 → 保留少数代表响应。
- 改 ScoringProfile 默认值影响 rank/LLM-off/preview 全路径 → 全链路回归。
- 改 RankCandidate = 改契约,生产↔消费端 + schema + 文档同步(记忆 edit-contract-check-counterpart)。
- 聚拢后 candidateId 语义变化,用户已选 id 可能失效 → 前端注意迁移。
