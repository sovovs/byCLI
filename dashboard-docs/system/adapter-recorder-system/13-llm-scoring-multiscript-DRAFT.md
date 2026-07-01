# 13 · LLM 评分 + 多脚本 + verify-then-save(设计,Codex 深聊已定稿 prompt)

> 重设计「录制→adapter」主流程:**LLM 评审 A/B 痕迹 → 评分排序 → 为高分候选各自生成完整 cli 脚本(可多个)→ 各自 verify → verify 成功后展示给用户改/存**。取消人工选候选。两个 prompt(评分 A / 写脚本 B)经 Codex 深聊定稿,见下。
>
> **✅ N1–N5 已实现(2026-06-27)**:N1 `dashboard-be/src/llm/score.ts`(be 按 profile delta 求和算权威分)；N2 `generate.ts`+`sandbox-check.ts`(@babel AST 白名单)+`draft-store.ts`(0700)；N3 主仓 verify 加 `adapterPath` override(`runner-port`/`highlevel/verify`,守 ~/.bycli)+`verify-expectation.ts`；N4 `pipeline.ts`(score→生成→静态检查→草稿→verify→收集)+ be `/recorder/pipeline`&`/recorder/save` handler + daemon `/v1/save-adapter`(`saveAdapterSource`)+ 状态机 `saveAdapter` ranked→done + egress 前置同意；N5 前端 `PipelineStep.tsx`(多脚本结果页:评分依据+verify rows/字段+源码编辑器+选/改/存)替代手动选候选,Workbench ranked 渲染它,FLOW_STEPS 合并为「生成并保存」。测试:be 119+2skip / recorder-core 94 / dashboard 30 / 主仓 runner-verify 101 / Tier A 2。**待补**:契约 schema(/recorder/pipeline·/save·/v1/save-adapter)文档化、真实站点端到端验证。

## 目标流程 vs 现状
- **现状**:capture A/B → 启发式 `rank` 选候选 → 人工选 1 个 → init(LLM 只生成 funcBody)→ write → verify。
- **目标**:capture A/B(network+操作+截图,已有)→ LLM 评分排序(启发式作 prior)→ LLM 为高分候选**各自生成完整脚本**→ 逐个 **verify(临时草稿)** → verify-ok 的展示(评分+rows/字段+源码)→ 用户**改/存**到 `~/.bycli/clis/<site>/<cmd>.js`。

## Codex 深聊关键决策(2026-06-27)
**评分(A)**
- **强制「逐信号 delta 求和 = 总分」**(镜像 `score.ts` 的 `scoreExplanation`,可审计可复现),**不许 LLM 直接拍总分**;不 clamp(允许负分),展示用 `uiScore=max(0,min(100,score))`。
- 启发式 score 作 **prior/anchor** 一并给(抗漂移),要求 LLM **重算 delta 并解释分歧**(`priorDeltaDisagreement`)。
- A/B 差分当**证据层**(证明 `seed_arg_maps_to_param`/`response_echoes_seed`;A/B 全同→`inputIndependentRisk`),不额外加分。
- **hard-reject 由 be 启发式预过滤**(analytics 域名/静态资源/写操作),LLM 只复核边界。
- 多候选裁剪复用 `synthesize.ts:buildSampleSummary`(候选同 path、action cap 50、响应体 4000 字)。

**写脚本(B)**
- LLM 产**完整脚本**(非只 funcBody),但**执行前 be 必须 AST 白名单 + origin 校验**。
- **pipeline vs func 由规则定,默认 func**(verify-runner 注册后需 `func`,pipeline 在 load 阶段会失败;`clis/hackernews/top.js` 那种 pipeline 仅适合简单 PUBLIC)。
- 分页/COOKIE/嵌套 unwrap(`items`/`data.items`/`results`…)/字段映射写成**硬规则**。
- **评分 A 与写脚本 B 两段式**(先筛后写,token 更稳、便于预算/并发/重试/安全审查),不一次调用。
- verify 只回 rows/fieldCount → LLM 额外输出 `verifyExpectation`(minRows/expectedFieldCount/verifyArgs),be verify 后比对。

**结构性问题(必须先解决)**
1. **默认 profile high 不可达**(正向合计 ~60 < 75,见 [[m4-default-profile-high-unreachable]])→ 「高分自动生成」阈值**不能用 high**,改 `medium+` 或 `topN`,否则可能没脚本可生成。
2. 现有 `synthesize.ts` 是「单候选→funcBody」契约 + `extractJson` 只吃根 JSON → 多脚本完整 source 需**新 handler + 新 schema**,不能复用 `SynthesisResult`。
3. **verify 临时草稿必须**:写 0700/0600 临时目录 verify,成功再进保存确认,**不污染 `clis/`**(verify-runner 真实路径 `src/recorder/runner/verify-runner-main.ts`,按 adapterPath 载入)。
4. **安全顺序**:consent(egress 前置同意,覆盖痕迹外发 + verify 访问目标站)→ LLM → AST 白名单 + allowed-origin → verify(子进程隔离,08 章明确非强沙箱)→ 展示 → 人工保存确认(ADR-0005)。
5. **状态机(拟)**:`captured → heuristic_ranked → llm_scoring → script_synthesizing → draft_static_checked → verifying_drafts → verified_drafts → save_pending → saved`,失败分支 `llm_failed/use_heuristic_fallback`、`verify_failed`、`all_rejected`;多脚本 verify 走 runner 队列 + 并发上限。

---

## 定稿 Prompt A —— 评分(逐信号 delta 求和,可审计)
```text
你是 byCLI recorder 的数据接口评审器。你会收到一次浏览器任务的 A/B 录制摘要:两个 sample 使用不同输入,包含候选 network endpoint、用户 action、valueShape、截图摘要、候选的 heuristic prior、response shape、A/B 配对信息。

目标:对每个候选 endpoint 判断是否值得生成 byCLI 只读数据命令,并输出可审计、可复现的评分结果。只输出一个原始 JSON 对象,不要 markdown,不要解释性正文。

评分规则必须严格镜像 DEFAULT_SCORING_PROFILE:
- stable_json_shape: +25,响应 bodyShape.kind 是 array 或 object,且像稳定数据而不是 HTML/静态资源。
- seed_arg_maps_to_param: +20,A/B 证明用户输入 seed arg 映射到 query/body/path/header 参数;强证据是同 endpoint 中只有该输入相关参数变化。
- response_echoes_seed: +10,响应弱回显 seed arg,或 A/B 响应内容随输入变化且能解释为查询结果变化。
- requires_session: +5,请求依赖 cookie/session/authSignals,且是读用户自有数据。
- dynamic_field: -10,存在 _t、ts、time、timestamp、nonce、uuid、sign、signature、csrf、token、callback、cb、rand、random 等动态/cache/sign 参数;同时加入 risk。
- weak_html_static: -25,响应像 HTML 页面、静态资源、脚本、样式、图片、字体,且不是 confirmed static hard reject。
- suspected_mutation: -100,写方法 POST/PUT/PATCH/DELETE 且响应不是 JSON array 的读列表。

Hard reject 规则优先于分数:
- confirmed_analytics:analytics/tracking host(google-analytics、googletagmanager、doubleclick、segment.io、mixpanel、sentry.io、hotjar、facebook.com/tr、stats.*、analytics.*、tracking.*)。
- confirmed_static:确认静态资源 .js/.css/.png/.jpg/.svg/.woff/.woff2/.ico。
- mutation:POST/PUT/PATCH/DELETE 且响应不是 array。
- unparseable_url、missing_method、pairing_failed_no_shape:若输入已标记,直接 rejected。

总分规则:
- 不允许直接臆造 total score。
- 每个候选先列 signals,每个 signal 用上面的固定 name 和固定 delta。
- score 必须等于所有 present signals 的 delta 求和;不要 clamp,允许负分。
- uiScore = max(0, min(100, score)),仅展示用。
- confidence:hardReject 存在则 rejected;否则 score<20 rejected;>=75 high;>=50 medium;否则 low。
- 注意:默认 profile 下正向最高通常只有 60,不要为制造 high 自行加分。

A/B 差分判断:
- paired=true 且 method/host/path/body kind 相同,是可比基础。
- A/B 只有 seed 对应参数变化、其他 stable params 相同、动态参数被排除 → strongParamEvidence=true。
- A/B 响应 shape/itemKeys 稳定、内容或 count 随 seed 变化 → responseVariesWithSeed=true。
- A/B 请求和响应基本相同 → inputIndependentRisk=true,risks 加 "input_independent_across_ab"。
- 只有单样本或 A/B seed evidence 相同 → 加 single_sample 或 shared_seed 风险。

输出 JSON schema:
{
  "candidates": [
    { "candidateId","endpointKey":"METHOD host pathname","isDataEndpoint":bool,
      "decision":"generate|review|reject","hardReject":null,
      "score":int,"uiScore":int,"confidence":"high|medium|low|rejected",
      "signals":[{"name","delta","present":bool,"why"}],
      "differential":{"paired":bool,"strongParamEvidence":bool,"responseVariesWithSeed":bool,"inputIndependentRisk":bool,"notes":[]},
      "args":[{"argName","in":"query|body|path|header","paramName","valueType"}],
      "excludedParams":[],"responseShape":{"kind","itemKeys":[],"count":int},
      "risks":[],"prior":{"heuristicScore":int,"heuristicConfidence","priorDeltaDisagreement":"none|minor|major","whyDifferent"},
      "reason":"one sentence" }
  ],
  "rejectedSummary":[{"candidateId","hardReject":"confirmed_static|confirmed_analytics|mutation","reason"}]
}
排序:先 confidence 非 rejected,再 score 降序,再 candidateId 升序。不要输出 schema 外的顶层字段。
输入:{{SCORING_INPUT_JSON}}
```

## 定稿 Prompt B —— 写 cli 脚本(完整 source + verifyExpectation)
```text
你是 byCLI adapter 生成器。你会收到 Prompt A 选出的高价值候选 endpoint、A/B 请求响应摘要、参数映射、用户 action 因果链、截图摘要、评分理由和风险。

目标:为每个可生成候选输出一个完整、可执行、只注册一个命令的 byCLI JavaScript adapter 草稿。只输出一个原始 JSON 对象,不要 markdown。代码放在 JSON 字符串字段 source 中。

生成优先级:
1. 默认生成 func 形式,不生成 pipeline。
2. 只有当输入明确说明 verify 支持 pipeline,且 endpoint 是 PUBLIC、无认证、线性 fetch/limit/map/filter、无复杂错误处理时,才可生成 pipeline。
3. 任何 COOKIE、browser、POST read-like、分页、嵌套 wrapper、字段清洗、错误处理,都用 func。

脚本 contract:
- 必须:import { cli, Strategy } from '@sovovs/bycli/registry';
- 可选:import { ArgumentError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
- 禁止 import fs/path/process/child_process/vm/module/http/https,禁止 eval、Function、动态 import,禁止读写文件、环境变量、shell。
- fetch 只能访问候选 endpoint 的 origin;不访问证据外的第三方 origin。
- access 默认 "read";mutation/hardReject 候选不生成。
- site/name 只含字母数字下划线短横线;一个 source 只 cli({...}) 一次。
- columns 必须等于 row 最终返回字段;不声明不会返回的列。
- args 来自 A/B 证明的 seed 参数、分页参数或安全 limit;动态签名参数不做成用户参数。
- limit 必须有上限(默认 10,最大通常 ≤100)。
- 空结果抛 EmptyResultError;HTTP 非 2xx 抛 CommandExecutionError;参数非法抛 ArgumentError。

策略规则:
- PUBLIC:无需 cookie/session,browser:false,Node fetch。
- COOKIE:authSignals/401/403/302/依赖 cookie 时用 Strategy.COOKIE,通常 browser:true;优先浏览器上下文 page.evaluate 同 origin fetch + credentials:'include'。
- UI:仅在无可复用数据 endpoint、必须 DOM 读取时;本任务尽量不用。
- POST 返回 array 可视作 read-like,但保留 review risk;POST 返回 object ack 不生成。

响应解析规则:
- array 直接 map;object 按证据找数组 wrapper(items、data.items、data.list、data.results、results、list、records)。
- wrapper 不确定 → 写保守 unwrapArray helper,找不到数组抛 EmptyResultError,不静默 return []。
- 字段优先稳定 itemKeys;保留 id/title/name/url/created_at/count/status 等;key 用 ASCII camelCase/snake_case,不要把 seed 值当 key。
- 字段缺失给 ""/0/null,不丢整行(除非核心字段全缺);URL 字段用 new URL(rel, base).toString() 规范化。

分页规则:
- 证据有 page/offset/limit/cursor/next_cursor/page_token → 生成对应 args。
- 简单 page/limit:循环到 limit 满足或无更多,最多 ceil(limit/pageSize) 页 + 硬上限。
- cursor:仅响应里有 next cursor 才循环,否则只取第一页、cursor 留可选参数。
- 不猜测证据外的分页协议。

输出 JSON schema:
{
  "scripts":[
    { "candidateId","site","name","description","access":"read","domain",
      "strategy":"PUBLIC|COOKIE|UI","browser":bool,"scriptKind":"func|pipeline",
      "args":[{"name","type","required":bool,"help"}],"columns":[],
      "source":"complete JavaScript source string",
      "verifyExpectation":{"commandName":"site/name","verifyArgs":{...占位/默认,绝不放真实密钥},"minRows":int,"expectedFieldCount":int,"allowedOrigins":[],"expectedStage":"execute"},
      "risks":[],"notes":[] }
  ],
  "skipped":[{"candidateId","reason"}]
}
source 要求:func 非浏览器 = cli({...,strategy:Strategy.PUBLIC,browser:false,func:async(args)=>{...return rows;}});
func 浏览器 COOKIE = cli({...,strategy:Strategy.COOKIE,browser:true,func:async(page,args)=>{await page.goto('https://domain',{waitUntil:'load'});const rows=await page.evaluate(...);return rows;}});
不确定 page.evaluate 形式 → 生成简单 browser func 并在 notes 标注需人工 review。不要输出 funcBody-only;source 必须是完整文件内容。
输入:{{SCRIPT_INPUT_JSON}}
```

## 落地里程碑(拟,待批准)
- **N1** be 评分流水线:启发式 hard-reject 预过滤 + 组装评分输入 + 调 LLM(Prompt A)+ 解析校验(delta 求和一致性);阈值用 medium+/topN(非 high)。
- **N2** be 多脚本生成(Prompt B)+ AST 白名单 + allowed-origin 静态检查 + 写 0700 临时草稿。
- **N3** be verify 临时草稿(逐个,runner 队列)+ verifyExpectation 比对 + 收集 verified-ok。
- **N4** 新契约/状态机(captured→…→saved)+ 保存确认(ADR-0005)+ egress 前置同意复用 P0-2。
- **N5** 前端:多脚本结果页(评分依据 + rows/字段 + 源码编辑器)+ 选择/编辑/保存;旧 RankStep 降级为「评分依据」可选视图。
