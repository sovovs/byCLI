# 15 · Score Prompt 压缩(TOON + evidence DSL)

> 承接 [14-candidate-aggregation-scoring-plan](./14-candidate-aggregation-scoring-plan.md)。
> 目标:压缩 score 阶段发给 LLM 的评分提示词体积,**不损失信号判定准确率**。
> 权威约束:be 用固定 profile delta 双轨重算权威分,LLM 只判信号 → **"信号判定准确率"是唯一质量指标**。

## 背景与动机

score 阶段把已聚拢的 endpoint 候选 + A/B 录制证据喂 LLM,让 LLM 判定每个评分信号是否成立、推断参数角色。
prompt 越大:① 越接近网关 Cloudflare 120s 硬墙(超时→524→退回规则分)② token 成本越高 ③ 信号越不聚焦、判定越易漂移。

压缩分两阶段:
- **阶段一(本文档已落地)**:paramObservations TOON 表格化 + PROMPT_A 精简。
- **阶段二(规划中)**:evidence 压缩(证据 DSL),evidence 占数据段 76%,是更大杠杆。

## 阶段一:paramObservations TOON 化 + PROMPT_A 精简 ✅

### 方案选择(codex 双轮评审)

先试的 **zipjson 式参数折叠**(`Fixed: aid=2608,...; var: uuid`)= **NO-GO**:
会擦掉每参数的确定性信号位(observedVariation/dynamicLike/cursorLike/coverage),而 PROMPT_A 的
`seed_argument`/`dynamic`/`pagination` 铁律强依赖这些位。**值可以折叠,信号事实不能擦。**

改用 **TOON(Token-Oriented Object Notation)**:对同构对象数组用"表头+行"表格编码,
天然消除重复字段名,但**逐行保留每个字段/信号位** —— 不违反红线。

```
paramObservations[7]{name,in,observedVariation,coverage,dynamicLike,signedLike,cacheBusterLike,cursorLike}:
  aid,query,false,2/2,,,,
  uuid,query,false,2/2,1,,,
```

编码约定(与 PROMPT_A 的"读表说明"一致):
- 首行 `paramObservations[N]{列序}:` 声明行数 + 列序(表头即 schema)。
- **observedVariation 保留三态字面量 `true`/`false`/`unknown`**,绝不压成 1/空(**unknown≠false** 是红线:
  "只出现一次/body 未捕获值"是 unknown,当成 false 会误判值稳定)。
- 布尔命中列(dynamicLike/signedLike/cacheBusterLike/cursorLike):命中→`1`,未命中/缺省→空单元。
- coverage 原样 "n/m"。

### 哪些该/不该 TOON 化(codex A1-A4)

| 结构 | 决定 | 理由 |
|---|---|---|
| paramObservations | ✅ TOON | 同构 + 字段稳定,省 54% |
| endpointCalls.urlParams | ❌ 保持 JSON | 嵌套对象、键随接口变 → 表格化有动态列/空值歧义 |
| responseSummary.rowKeys | ❌ 保持 JSON | 点分字符串数组,表格化收益小 |
| 单对象(endpoint/prior/responseShape) | ❌ 保持 JSON | 无重复行可折叠 |

### PROMPT_A 精简

4388 → 3916 chars。删重复约束("不要质疑聚拢"多处合一)、压缩证据形状散文(evidence TOON 表头自解释)、
精简输出 JSON 注释。**保留真实 interfaces 输出契约**(candidateId/paramUnion/ruleSignals/semanticSignals/
hardReject/llmUtilityScore) —— codex 曾给一份把契约改成 `{items:[{ruleSignal}]}` 的草稿,**弃用**(会破坏
be 的 `parsed.interfaces` 解析 + 双轨求分)。

**MUST-KEEP 字段**:name, in, observedVariation, dynamicLike, cursorLike, coverage。
signedLike/cacheBusterLike 是 be 侧 `computeDynamicPenalty` 从**原始候选**读的(非 LLM 输出),
PROMPT_A 无显式规则消费,保留仅作风险措辞/debug。

### 实现落点

全在 `dashboard-be/src/llm/score.ts`:
- `toonParamObservations(compacted)`:导出纯函数,compactParamObs 数组 → TOON 表格串。
- `renderPrompt(perCand)`:唯一序列化处。paramObservations TOON、其余字段 JSON。
  degradeToBudget 就地改 perCand 后重新 renderPrompt 仍成立。

### 真机 A/B 验证(codex 通过线)

用真实录制的 juejin ScoreInput(25 候选,A=apple/B=java)做离线 A/B:
A=旧 pretty-JSON + 旧 PROMPT_A,B=TOON + 精简 PROMPT_A,同一份输入各跑真 LLM,对比信号判定一致性。

| 维度 | 一致性 | 通过线 | 结果 |
|---|---|---|---|
| paramRole | 9/9 = **100%** | ≥98% | ✅ |
| ruleSignals.present | 14/14 = **100%** | ≥99% | ✅ |
| semanticSignals(name+strength) | 11/12 = 91.7% | ≥95% | ⚠️ 见下 |
| band 回归(generate/review→reject) | **0** | =0 | ✅ |

唯一不一致:`author_recommend.query_dimensions_available` A=medium / B=strong —— 是 LLM **语义强度的
run 间抖动**(同编码跑两次也会抖),差一档且不影响 band(semanticBonus cap 40 吸收)。3 个确定性维度
(paramRole/ruleSignals + band)全 100% 才是关键证据。

**结论:TOON + 精简 PROMPT_A 对 LLM 判定实质无损。** 附带发现:B(TOON)比 A(legacy)prompt 更小、LLM 更快。

### 附带发现:多候选批仍会超时

A/B 中 5 选中候选分批(3/批),含 3 候选的批**仍超 CF 120s 失败**(两臂一致,scored 2/5)。
paramObservations TOON 只占数据段 5%,压不到大头 —— **evidence(76%)才是超时主因**。这印证阶段二必要性。

## 阶段二:evidence 压缩(证据 DSL) —— #1+#2+#3 已收官、#4 不做(详见下方"阶段二收官")

### 体积分布(真机 juejin 7 候选实测)

- PROMPT_A 基座 3916(9%) | 数据段 38650(91%)
  - TOON paramObservations: 1937(**5%**)
  - JSON 段: 36683(95%),其中 **evidence ≈ 29309(数据段 76%)**、endpoint ≈ 6926(18%)

evidence 内部(A/B 累加):responseSummary **41%** / actions **32%** / endpointCalls **22%** / navigations 5%。

### codex 方案:不 TOON evidence,改"可逆紧凑证据 DSL + proof-only 参数值"

4 个压缩点(按收益/风险比排序):

| # | 压缩点 | 预估省 | 结论 | 状态 |
|---|---|---|---|---|
| 1 | actions.selector 砍(score+generate 两侧) | **6-8k** | ✅ GO | **已落地**。selector 对 score 判信号无用(seed 靠 A/B url/params 差异)、generate 侧 PROMPT_B 也不引用(靠 responseSchema/paramUnion 写脚本) → 两侧都砍 |
| 3 | arrayPaths 过滤 count:0 空数组 | 0.7k | ✅ GO | **已落地**。pickRowPath 仍看全量,rowPath 不受影响 |
| 2 | endpointCalls.urlParams 只留证明性键 | 2.5-3.5k | ✅ GO | **已落地**。只删 paramObservations 里 observedVariation===false 且非 cursorLike 的稳定常量键;保留 true(seed)/unknown/cursorLike/不在 paramObs 的键 |
| 4 | rowKeys 公共前缀折叠 | 1-1.6k | ❌ 不做 | codex 判**负价值**:收益小、侵入大,且 rowKeys 已截断 30 够判 rich_business_data,折叠反引入呈现波动 |

### 阶段二收官(2026-07-03):#1+#2+#3 落地、#4 不做

累计压缩 ≈ 9-12k chars(evidence 从 ~29k 降到 ~17-20k):#1 selector 6-8k + #2 urlParams 2.5-3.5k + #3 count:0 0.7k。
叠加阶段一 paramObservations TOON,score prompt 大幅瘦身。

#2 验证方式(codex 判定):**GO 逻辑收口,不需真 A/B**。#2 删的是 paramObservations 已证明 observedVariation=false
的稳定常量**值**(名字+稳定性 paramObs 已含),真正判 seed 的变化键 A/B 差异全保留 → 属"删冗余"非"改语义"。
规则安全性:真 seed 恰好 A/B 同值时本就无 urlParams seed 证明力,保留也无用;navigations URL diff 兜底。
PROMPT_A 强约束措辞"urlParams 里没有的键即稳定常量,非缺失"防 LLM 误判参数缺失。

### #1+#3 落地与验证方式(2026-07-03)

- **#1 selector**:`buildScoreEvidenceSummary` 不再产 selector(只留 type/valueShape/key);删了无用的
  `SCORE_MAX_SELECTOR_LEN` + degradeToBudget 里的"去 selector"死步。generate 侧 PROMPT_B 经查证不引用
  selector(降级第一步本就丢它),故两侧一致。
- **#3 count:0**:`buildResponseSummary` score 模式两处(array/object)`summary.arrayPaths` 过滤 count>0;
  `pickRowPath` 仍用全量 arrayPaths → rowPath 选择不变。
- **验证方式(与阶段一不同)**:#1+#3 移除的是 **LLM 从不读的字段**(PROMPT_A/B 都不引用 selector、空数组
  无信息量),性质是"删死字段"而非"改编码格式" → 逻辑上不可能影响判定,由**逻辑论证 + 单测**收口
  (单测已证:零字段丢失、rowPath 不变、valueShape/key 信号保留、count:0 全过滤)。阶段一 TOON 改的是
  **编码格式**(LLM 可能读不懂),才必须真 LLM A/B。#2(改 LLM 看到的参数值)属"改语义",做时需真 A/B。
- 真机 A/B 实验教训:第三方网关(ikuncode)当日响应不稳(连接堆积 17-22 + CPU 0 纯等响应),分批并发
  会放大;真 A/B 只对"改 LLM 输入语义"的改动才必要(#2/#4),别为"删死字段"耗在不稳定网关上。

证据 DSL 形态:
```
actions: pattern:"click>keydown(Enter)>input(text,len A=5/B=4)>submit"
calls:   每 sample 只列 status/by/proofParams(query:A=apple,B=java; cursor:B=0->20_...)
responseSummary: 过滤空数组 + rowKeys prefix-group + A/B 相同则 sameAs:"A"
navigations: 保留 A/B URL diff
```
总计 evidence 29k 可压到 ~17-19k。

### 🔴 关键区分:selector 分 score/generate 两侧

selector 在 **score 阶段没用**(LLM 只判信号),但 **generate 阶段(生成 CLI 脚本)可能有用**(点击/填表定位)。
好在两侧是**独立的 evidence 构建函数**(`synthesize.ts`:`buildScoreEvidenceSummary`→ScoreEvidence /
`buildGenerateEvidenceSummary`→GenerateEvidence,各有 SCORE_MAX_SELECTOR_LEN/GEN_MAX_SELECTOR_LEN)。
所以:**score 侧砍 selector、generate 侧保留**,互不影响。

做 generate 侧前还需确认:生成器/PROMPT_B 是否真用 selector,还是只靠 API 响应结构(rowKeys/columns)
写抽取逻辑 —— 若不碰 UI selector,则 generate 侧也能砍。

### 实现约束

- MUST-KEEP:seed_arg_maps_to_param 需 A/B urlParams 差异 + navigations diff;
  stable_json_shape/rich_business_data 需 rowKeys + businessFieldHints;
  response_varies_with_seed 需 A/B responseSummary 可比。
- 一次只动一个被测变量(evidence DSL 单独一轮 + 单独 A/B 验证,不和阶段一混)。
- 验证方法同阶段一:真实大小 ScoreInput 的 A/B 真 LLM 对照(离线验证必须用真实数据)。

## 阶段三:generate 阶段 —— 选中过滤(修 bug,2026-07-03)

### 根因 bug:generate prompt 混入所有 generate 资格候选,忽略用户选中

用户在候选页只选 `/search` 一个接口做生成,但 generate prompt 却含全部 7 个候选。根因:
- `runScore`(pipeline.ts)算 `genCands = scored.candidates.filter(c => c.decision === 'generate')` —— 所有 LLM 判
  `decision:'generate'` 的候选(medium+),**不是用户选中的**。
- `handlePipelineGenerate`(server.ts)把全部 genCands 喂生成器;前端 `pipelineGenerate` **根本没传选中 id**。

后果:① prompt 巨大(真机 7 候选 **85KB**,远超单候选 ~12KB,是撞 CF 120s 超时的主因)② 生成一堆用户没选的脚本
③ 浪费 token。PROMPT_B 明说"你会收到**一个**已选中候选",与实际严重不符。

### 修复:选中态贯穿到 generate

- **be**:`handlePipelineGenerate` 读 `body.candidateIds`(或 selectedCandidateId),过滤 genCands 到选中集
  ∩ generate 资格;空/未传 → 全部 genCands(向后兼容)。选中集与 genCands 无交集 → validation_failed。
- **前端**:选中态从 `ScoreCandidatesStep` 局部 state **提升到 `PipelineStep`** 容器级(onSelectionChange 上报),
  `GenerateStep` 的生成按钮把选中 ids 传给 `pipelineGenerate` → be。RecorderClient/httpRecorderClient/mock 签名
  加 candidateIds 参数。

效果:generate prompt 85KB(7候选)→ **~12KB(单候选)**,砍 ~85%,直接解决 generate 阶段超时根因。

### generate 侧 TOON:初判不做 → **后被阶段四推翻(见下)**

阶段三时的判断:选中过滤后**单候选** generate prompt ~12KB,TOON 单候选仅省 ~0.6KB(在 pretty 基础上比),
边际收益极小 → 初判不做。**此判断后被推翻**:阶段四重测发现 ① 该省字符要在 **minify 基础上**比、② generate
可能选中**多候选**(收益线性放大)。实测多候选 paramUnion+recommendedColumns TOON 化单候选省 899、10 候选省 ~9KB
→ 值得做(见阶段四)。教训:压缩收益要在"当前已压到的基线"上评估,且别假设候选只 1 个。

## 阶段四:generate prompt minify + 浅层数组 TOON(2026-07-03)

### minify(两侧统一)
喂 LLM 的 JSON 从 `JSON.stringify(x,null,2)`(pretty)→ `JSON.stringify(x)`(minify)。零风险纯收益
(JSON 语义等价、LLM 解析无损)。覆盖 score.ts renderPrompt(rest 段)、generate.ts renderCandPrompt、
synthesize.ts buildPrompt(init 合成路径)。实测:score 数据段省 38%、generate 单候选省 45%。
codex 复审通过(无风险/遗漏,降级阶梯不用调,generate 降级代码作防御性保留)。

### generate 浅层数组 TOON(paramUnion + recommendedColumns)
generate 可能选中**多候选**,候选越多 prompt 越大。在 minified 基础上再 TOON 化两个**浅层安全数组**:
- paramUnion `{name,in,paramRole,exposeAsArg,inferredMeaning}`:单候选省 629 chars。
- recommendedColumns `{name,path,type}`:单候选省 270 chars。
- **单候选省 899;5 候选省 ~4.5KB;10 候选省 ~9KB**(线性放大)。

**为何只这两个**:paramUnion/recommendedColumns 是浅层同构数组、字段值语义受控。itemFields 的 sample 是
**响应样本值**(可能含逗号/中文/特殊字符 + 嵌套片段)→ 不适合表格化,**保持 minified-JSON**。

实现:generate.ts `toonObjectArray(arr,cols,label)` 通用编码器 + renderCandPrompt 抠出这两个数组→末尾 TOON 块
(标注 sample 归属)、其余 minify;PROMPT_B 加读表说明。**renderCandPrompt 里 TOON/minify 是互斥字段划分**:
先把这两数组从 clone `delete` 掉编码成 TOON 块,再对剩余 clone(含 itemFields)`JSON.stringify` minify,
拼 `PROMPT_B + minifyJSON + TOON块`(同一字段只走一条路)。degradeToBudget 6 步降级不受影响(TOON 在 render 内做)。

**🔴codex 复审 Q1(真 bug,已修)**:`toonObjectArray` 初版裸 `String(v)` 逗号分隔,但 **paramUnion.inferredMeaning
是 LLM(score 阶段)生成的中文含义,可能含逗号**(如"搜索词,支持多关键词")→ 破坏 TOON 逗号分隔、行列错位。
"放末列/换分隔符"只降低概率非修复。**修:每单元改 `JSON.stringify(String(v))`(JSON-cell 编码)** —— 逗号/
换行/引号/中文全部转义安全,缺省单元为 `""`,读表方按 JSON 字符串边界读(逗号只在引号外才是列分隔)。
PROMPT_B 读表说明同步声明"每单元是 JSON 字符串"。**教训:TOON 单元含 LLM 生成文本时必须 JSON-cell 转义,
不能裸分隔;"值无逗号所以安全"的假设不成立。**

验证:单测零字段丢失 + 缺省空单元 `""` + 含逗号 inferredMeaning 不错位 + 多候选各自表格;be 全量 292 绿。
TOON 是无损编码(零丢失),逻辑收口不跑真 A/B。
