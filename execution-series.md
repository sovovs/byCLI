# byCLI Execution 专题索引

这一组文档专门解释 `src/execution.ts` 如何处理 adapter，尤其是 browser adapter 如何通过 bycli daemon、Chrome Extension、Chrome DevTools Protocol 完成页面操作。

推荐阅读顺序：

1. [Execution 1：executeCommand 总入口](./execution-1-execute-command.md)
2. [Execution 2：浏览器会话与 adapter 调度](./execution-2-browser-session.md)
3. [Execution 3：CLI 到 daemon 的通信链路](./execution-3-daemon-bridge.md)
4. [Execution 4：Extension 如何操作 Chrome DevTools](./execution-4-extension-cdp.md)
5. [Execution 5：Trace、错误和生命周期清理](./execution-5-trace-errors.md)

总览链路：

```text
commanderAdapter.ts
  -> execution.ts executeCommand()
  -> runtime.ts browserSession()
  -> browser/bridge.ts BrowserBridge
  -> browser/page.ts Page
  -> browser/daemon-client.ts sendCommand()
  -> daemon.ts /command
  -> extension/src/background.ts handleCommand()
  -> extension/src/cdp.ts chrome.debugger.sendCommand()
  -> Chrome DevTools Protocol
```

注意区分两条浏览器路径：

- 普通网站 adapter：`BrowserBridge -> bycli daemon -> Chrome Extension -> chrome.debugger/CDP`。
- Electron app adapter：`CDPBridge -> 直接连接 Electron/Chrome CDP WebSocket`。

