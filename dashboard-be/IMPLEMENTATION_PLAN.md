# dashboard-be M2 Shell 实现计划

## 决策(已拍板)
- **技术栈**:方案 2 — 独立 Node/TS 进程,经 HTTP 调主仓 daemon(`127.0.0.1:19825` + `X-byCLI:1`),**不 import 主仓 src/**。耦合面 = daemon 线上契约,非源码。
- **范围**:方案 A — 只建不依赖导航的 M2 shell;navigate/capture/rank/init/verify 先 `feature_disabled` 占位,等 M1 spike 落地再开。**不碰 URL policy,不违反 M1 硬门禁。**

## 本次交付的 endpoint
| Endpoint | 行为 |
| --- | --- |
| `GET /recorder/health` | 经 daemon `GET /status` 映射 localService/daemon/extension/highLevel |
| `POST /recorder/session/bind` | 创建 recorder session(idle→session_bound / awaiting_user_login),写 registry |
| `POST /recorder/session/confirm-auth` | awaiting_user_login→auth_confirmed |
| `GET /recorder/requests/{id}` | 查 request/session 状态(registry + TTL) |
| `POST /recorder/cancel` | 幂等清理 session/capture |
| navigate/capture/rank/init/verify | 一律返回 403 `feature_disabled`(占位,M1 后开) |

## 04 章安全门禁(全套,硬性义务)
- 仅监听 `127.0.0.1`
- `X-Recorder:1` 自定义 header gate
- Origin allowlist(只认自身 UI origin),preflight 不回 `Access-Control-Allow-Headers`
- 启动随机 token(`X-byCLI-Token`)+ bootstrap 注入端点(one-time)
- CSRF:SameSite=Strict cookie + header 双重提交
- side-effect 一律 POST-only
- token 不落日志

## 目录结构(be 私有:HTTP adapter + bootstrap + 门禁;无 domain 核心)
```
dashboard-be/
  package.json                  # 独立 ESM 包,zod + node:http(零重框架)
  tsconfig.json
  src/
    server.ts                   # http server,127.0.0.1 bind,路由分发
    config.ts                   # ConfigPort:env→RecorderConfig(zod),fail-fast config_invalid
    security/
      gates.ts                  # header/origin/csrf/token 校验中间件
      bootstrap.ts              # 启动随机 token 生成 + 注入端点
    transport/
      envelope.ts               # RequestEnvelope 构造 + ErrorCode→HTTP status 映射(03 章表)
      daemonBridge.ts           # ~30行:fetch daemon /status (+ 未来 /command),X-byCLI,超时
    session/
      registry.ts               # 内存 session/request registry + TTL + stateVersion CAS
      stateMachine.ts           # 05 章合法转移校验(idle→...→done|failed|cancelled)
    routes/
      health.ts bind.ts confirmAuth.ts requests.ts cancel.ts gated.ts
  test/                         # vitest:门禁(CSRF/header/Origin)+ 状态机 + 错误映射
```

## 契约对齐(不重定义)
- 类型:从 `dashboard/schemas/` 引用;ErrorCode 复用,error 映射照 03 章表(invalid_state→400、csrf_failed/auth_failed→403、feature_disabled→403、request_not_found→404、idempotency_conflict→409…)。
- envelope 形状照 OpenAPI `ApiResponse`;RequestStatus 照 schema(含 expiresAt/pollAfterMs)。
- 幂等:`Idempotency-Key`,scope=uiSessionId+endpoint+key(03 章)。

## ownership 铁律遵守
- be 只放 HTTP adapter / bootstrap / 安全门禁 / session+registry 编排。
- **不实现** URL policy、normalize/rank、runner、draft 生成(这些是 domain/high-level,归主仓 src/ 或共享包)。所以 navigate 之后的链路本就该 feature_disabled,不是偷懒。

## 验证
- vitest:① 门禁三件套(无 header/错 Origin/缺 CSRF → 403)② 状态机非法转移 → invalid_state ③ 错误码→HTTP status 映射 ④ health 在 daemon 不可达时降级 daemon_unavailable。
- 手验:`node dist/server.js` 起在 127.0.0.1,curl 验证 header gate 拦截。
- daemon 真实联调:需要主仓 daemon 在跑(可选,health 能在 daemon down 时返回降级态,不强依赖)。

## 明确不做(本次)
- 任何 URL 导航 / 真实 capture(M1 未过)
- rank/init/verify 真实逻辑(M4/M5 domain+high-level)
- 前端 bootstrap 注入对接(be 提供注入端点,前端那侧下个增量再接)

## 后续顺序
M1 导航 spike(主仓 URL policy + interception)→ M3 strict page lease + daemon /command 封装 → M4 core engine → M5 high-level。
