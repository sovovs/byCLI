# byCLI Adapter 源码时序图索引

这组文档把 adapter 的运行原理拆成 4 个阶段。建议按顺序读，像顺着调用栈往下走：

1. [阶段 1：启动发现与注册](./adapter-stage-1-startup.md)
2. [阶段 2：命令解析与执行调度](./adapter-stage-2-execution.md)
3. [阶段 3：Pipeline Adapter 执行原理](./adapter-stage-3-pipeline.md)
4. [阶段 4：Browser Function Adapter 执行原理](./adapter-stage-4-browser-func.md)

如果你想继续深挖 `src/execution.ts`、bycli daemon、Chrome Extension 和 Chrome DevTools Protocol 的交互链路，读这个专题：

- [Execution 专题索引](./execution-series.md)

核心主线：

```text
src/main.ts
  -> src/discovery.ts
  -> src/registry.ts
  -> src/cli.ts
  -> src/commanderAdapter.ts
  -> src/execution.ts
  -> adapter func 或 pipeline
  -> src/output.ts
```

一句话模型：adapter 是一个调用 `cli({...})` 的 JS 模块。byCLI 启动时发现 adapter，把命令注册到全局 registry；随后 Commander 把 registry 里的命令变成 `bycli <site> <command>`；执行时 `execution.ts` 决定是否需要浏览器，并调用 adapter 的 `func(...)` 或 `executePipeline(...)`。
