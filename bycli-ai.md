
---

## 四、执行链路：一条命令端到端怎么跑（总览）

> 源：execution-series.md（索引/总纲）；细节由后续 execution-1~5 补充。

这组讲 `src/execution.ts` 怎么处理 adapter，尤其 browser adapter 如何经 daemon、Chrome 扩展、CDP 操作页面。

**端到端调用链（普通网站 adapter）**：

```
commanderAdapter.ts
 → execution.ts  executeCommand()      // 总入口
 → runtime.ts    browserSession()      // 起/复用浏览器会话
 → browser/bridge.ts  BrowserBridge    // 浏览器桥
 → browser/page.ts    Page             // Page 抽象
 → browser/daemon-client.ts  sendCommand()
 → daemon.ts  /command                 // 常驻进程
 → extension/src/background.ts  handleCommand()
 → extension/src/cdp.ts  chrome.debugger.sendCommand()
 → Chrome DevTools Protocol            // 真实页面
```

**关键：两条浏览器路径**（正好对应 commit 的 "website or Electron app"）：
- **普通网站 adapter**：`BrowserBridge → daemon → Chrome 扩展 → chrome.debugger/CDP`——借道扩展驱动你的真实 Chrome。
- **Electron app adapter**：`CDPBridge → 直连 Electron/Chrome 的 CDP WebSocket`——不经扩展，直接连。

这也解释了第二节 strategy 谱系如何落地：PUBLIC/LOCAL 在纯 Node 跑完、不碰这条链；COOKIE/INTERCEPT/UI 才会走这条"daemon→扩展→CDP"的重链路。
