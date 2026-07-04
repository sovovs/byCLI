# adapter-runtime · byCLI 核心运行时原理

> byCLI **核心 CLI 运行时**如何执行 adapter(`clis/<site>/<command>.js`)的源码级讲解。
> 与兄弟子系统 [`adapter-recorder-system`](../adapter-recorder-system/) 的关系:**recorder 生产 adapter,runtime 消费/执行 adapter**。
> 这组文档描述既有代码(`src/execution.ts`、`src/daemon.ts`、`extension/`),是开发者向的"代码怎么工作"讲解,非新设计提案。
> (2026-07-04 从仓库根目录迁入,保留 git 历史;文档基线约 2026-06-12,引用的代码路径当前仍有效。)

## 两组文档

### adapter-* — adapter 运行原理(4 阶段,按调用栈顺序读)
- [索引:adapter-sequence](./adapter-sequence.md)
- [阶段 1:启动发现与注册](./adapter-stage-1-startup.md) — `clis/<site>/<command>.js` 怎么被找到并注册成命令
- [阶段 2:命令解析与执行调度](./adapter-stage-2-execution.md) — 终端参数 → adapter 调用
- [阶段 3:Pipeline Adapter 执行原理](./adapter-stage-3-pipeline.md) — 声明式 adapter(无 func)怎么执行
- [阶段 4:Browser Function Adapter 执行原理](./adapter-stage-4-browser-func.md) — `page` 从哪来、怎么传进 `func(page, kwargs)`

### execution-* — `src/execution.ts` 深入(5 篇)
- [索引:execution-series](./execution-series.md)
- [Execution 1:executeCommand 总入口](./execution-1-execute-command.md)
- [Execution 2:浏览器会话与 adapter 调度](./execution-2-browser-session.md)
- [Execution 3:CLI 到 daemon 的通信链路](./execution-3-daemon-bridge.md)
- [Execution 4:Extension 如何操作 Chrome DevTools](./execution-4-extension-cdp.md)
- [Execution 5:Trace、错误和生命周期清理](./execution-5-trace-errors.md)
