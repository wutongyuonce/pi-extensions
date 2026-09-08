# 看懂 pi-chrome-devtools：先附着已有浏览器，必要时才自己拉起

> 本文面向第一次接触该扩展的读者。需要知道 Chrome DevTools Protocol（CDP）是浏览器调试协议；不需要写过 MCP server。
>
> 源码基线：`@narumitw/pi-chrome-devtools` **v0.53.1**（本仓库 `@narumiruna/pi-chrome-devtools`）。工具名、WebMCP 开关和选择器 UI 易变；稳定认知放在「谁拥有浏览器进程」和「工具如何按需暴露」上。
>
> 官方说明：[README](../../@narumiruna/pi-chrome-devtools/README.md) · [npm](https://www.npmjs.com/package/@narumitw/pi-chrome-devtools)

本文定位：小/轻量偏中，二次开发深度。设计受 [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) 启发，**不保证兼容**。

## 1. TLDR：它到底是什么

pi-chrome-devtools 让 Pi 通过 CDP 列标签、导航、跑 JS、截图，并可选发现页面提供的 WebMCP 工具。主线：

```text
模型需要看浏览器
→ 可能先调 chrome_devtools_load 露出具体能力
→ 第一次真正操作时解析 CDP endpoint
→ 能附着已有 DevTools 就附着；否则在允许时启动隔离 Chromium
→ 对当前页发 CDP 命令
→ session 结束：只杀掉本扩展自己启动的浏览器
```

所以它不是：

- 不是 MCP 服务器。工具是原生 Pi tool，不经 MCP 宿主；
- 不是 Playwright 测试框架，没有断言 runner，也没有测试夹具生命周期；
- 不是「保证操作你正在用的那个日常 Chrome」。附着已有 endpoint 和启动隔离 profile 是两条路；
- 不是远程浏览器管理器。auto-launch 只针对本机 host。

正面定义：**Pi 进程里的 CDP 客户端 + 可选的托管浏览器生命周期。** 判断点哪个标签、跑哪段 JS 的是宿主 Agent；扩展负责连接、重试陈旧 page id、安全写截图。

权威目标是 **当前选中的 inspectable page**。设置文件记 endpoint/工具白名单，不记页面 DOM。

## 2. 为什么不做成常驻浏览器插件

Agent 对浏览器的需求是突发的：查一下 UI、截一张图、执行一段表达式。若扩展一加载就启动 Chrome：

- 没做浏览器工作的会话也要背一个进程；
- 用户已经开着的 DevTools 调试口用不上；
- 关 Pi 时容易留下孤立的 Chromium。

所以默认策略是 **endpoint-first**：先找已有 DevTools；只有本地、可启动、且允许 auto-launch 时，才用隔离 profile 拉起托管浏览器。关会话时，只 `shutdownManagedBrowser`，不动不是自己 spawn 的进程。

该用：本地 web 调试、UI 核对、页面上暴露了 WebMCP 时的实验性调用。

不该用：把生产用户的日常浏览器当无头农场；把 `evaluate` 当任意代码执行沙箱（它就是在目标页里跑 JS）。

## 3. 先看整体架构，不急着看类名

```text
Pi 宿主
 └─ chrome-devtools.ts（命令、session、关闭时的所有权）
     ├─ lazy-tools.ts     先暴露 load，再按模型能力展开工具
     ├─ tools.ts          具体 CDP / WebMCP 工具
     ├─ browser-manager.ts 附着 vs 启动 vs 关闭
     ├─ cdp-client.ts     HTTP /json + WebSocket JSON-RPC
     ├─ screenshot.ts     高风险写文件
     ├─ webmcp/           页面提供的工具：发现、策略、调用
     └─ settings / selector UI
```

| 层 | 收到什么 | 做什么 | 产出什么 |
|---|---|---|---|
| 暴露 | 会话、模型 | 决定哪些 chrome_* 工具可见 | load 工具 ± 具体工具 |
| 命令 | `/chrome-devtools` | 选择工具、浏览器设置 | 更新设置与 active tools |
| 连接 | 第一次需要浏览器 | 附着或 launch | CDP endpoint |
| 页选择 | list/select/navigate | 维护 `activePageId`，陈旧则回退 | 当前 page |
| 操作 | evaluate / screenshot / webmcp | 发 CDP，约束写路径 | 给模型的结果 |
| 关闭 | session_shutdown | 取消启动、杀托管进程 | 不碰外部浏览器 |

图纸上的「浏览器层」在进程上可能是 **用户已有的 Chrome**，也可能是 **本扩展 spawn 的孩子**。这是本扩展最重要的差异点。

## 4. 实际怎样运行：扩展在 Pi 里，浏览器是可选孩子

证据：`pi.extensions: ["./dist/index.ts"]`。命令 `/chrome-devtools`。工具名以 `chrome_devtools_` 为前缀；另有 `chrome_devtools_load` 做延迟暴露。

装了什么：npm 包、用户目录 `pi-chrome-devtools.json`（旧文件名仅兼容），可选项目级配置。真正的浏览器二进制要本机有，或用户自己开好 remote debugging。

有没有常驻进程：

- 扩展：没有独立 daemon；
- 浏览器：第一次工具需要时才可能出现；若是托管启动，profile 在临时目录，端口动态分配，轮询 `DevToolsActivePort`；
- session 结束或扩展关闭：取消未完成的 launch，shutdown **owner 是本 session 的**托管浏览器。

和宿主的关系：

```text
Pi 宿主进程
 └─ 本扩展（CDP 客户端 + 工具）
     ├─ 附着：已有 Chrome 的 DevTools 端口（不拥有其生命周期）
     └─ 托管：自己 spawn 的 Chromium（拥有，必须关掉）
```

谁拉起归谁：工具路径上的 `ensureDevToolsEndpoint` 拉起；`session_shutdown` 负责收尸。远程 host 不允许 auto-launch。

## 5. 一条真实输入：打开页面并截图

```text
（可选）chrome_devtools_load
→ chrome_devtools_navigate / list_pages / select_page
→ 确保 endpoint（附着或启动）
→ CDP 导航到 URL
→ chrome_devtools_screenshot
→ 校验保存路径后原子写 PNG
```

### 5.1 暴露层：不是一上来就把七个工具塞进模型

八个工具在扩展加载时就已经 `registerTool`。所谓懒加载只改 **Pi 的 active tools 暴露**：模型支持原生延迟加载时，具体能力先藏着，只留 `chrome_devtools_load`；不支持则尽快露出已勾选工具。WebMCP 两个工具还受设置开关约束。换模型会作废已发现的页面工具。

`chrome_devtools_load` 不启动浏览器，也不连 CDP。

### 5.2 连接层：先附着，再考虑启动

`browser-manager.ts` 把附着、动态端口、启动和关闭放在同一个所有权状态机里。启动失败应提示 endpoint / 手工启动方式，而不是假设世界上一定有 Chrome。

### 5.3 页面层：activePageId 会过期

标签被用户关掉是常态。list/select/navigate 会重查 `/json`；操作前对陈旧 id 回退。navigate 必要时可以创建新 tab。

CDP **WebSocket 是按次的**：`withCdp` 连上、发命令、`finally` 关掉。托管 Chromium 可以跨多次工具调用活着，socket 不会。不要把「浏览器还在」理解成「调试会话一直开着」。

### 5.4 截图层：写文件是安全边界

截图路径必须落在允许的目录（工作区或临时目录），拒绝 symlink、`..`、非常规文件，先写临时再 rename。这不是审美，是防止模型把 PNG 写到任意位置。

### 5.5 WebMCP 层：页面说有什么工具，仍要策略和确认

`webmcp/` 负责发现和调用页面提供的工具。实验性、默认需确认。页面刷新或 session 更换会使发现结果失效。不要把它理解成「网站 API 的稳定 SDK」。

完成 ≠ 页面已经稳定：navigate 返回只说明 CDP 命令完成；动画、后续请求、登录态是另一回事。screenshot 成功只证明文件写出去了。

## 6. 边界、误区和排错

| 词 | 是 | 不是 |
|---|---|---|
| 附着 | 用已有 DevTools 端口 | 拥有那个浏览器进程 |
| 托管浏览器 | 本扩展 spawn、必须关掉 | 用户的日常 profile |
| `chrome_devtools_load` | 延迟暴露目录 | 启动浏览器的开关 |
| WebMCP | 当前页提供的实验能力 | chrome-devtools-mcp 兼容层 |

常见误区：

- 「调用了 list_pages 就是启动了 Chrome。」错。正：可能只是打到了已有 endpoint。
- 「关 Pi 会把我正在用的 Chrome 一起杀掉。」错。正：shutdown 只针对托管进程。
- 「这就是 chrome-devtools-mcp。」错。正：启发来源，协议/工具集都不保证兼容。

症状式排错：

- **工具在，但连不上**：先看设置里的 host/port、本机是否真有 DevTools、auto-launch 是否被关。不要先改 WebSocket 客户端。
- **截图失败**：先看路径是否越出工作区/临时目录，而不是怀疑 CDP `Page.captureScreenshot`。
- **WebMCP 刚刚还在，现在没了**：先假设页面导航或模型切换让发现结果作废，这是设计。

当前可靠性边界：没有把「启动浏览器 + 导航 + 截图」包成一个总事务。启动成功但导航失败时，托管浏览器可能已经在跑，直到 session 结束才收。

## 7. 总结

1. 原生 Pi 工具，不是 MCP server；浏览器进程可有可无。
2. endpoint-first；只关闭自己启动的 Chromium。
3. 工具可延迟暴露；WebMCP 是当前页的实验能力，不是稳定 API。
4. 截图路径是安全边界，按 realpath 拒绝，而不是字符串前缀。

如果只记一条主线：

```text
露出工具 → 附着或启动 CDP → 选页 → 导航/求值/截图 → session 结束只杀托管浏览器
```

## 8. 深入通道：源码阅读顺序

1. `src/index.ts` — 入口。
2. `src/chrome-devtools.ts` — 命令、session_start/shutdown、所有权。
3. `src/lazy-tools.ts` — 为什么有 `chrome_devtools_load`。
4. `src/tool-names.ts` — 稳定的工具名清单。
5. `src/tools.ts` — 每个工具做什么。
6. `src/browser-manager.ts` — 附着/启动/关闭状态机。这是进程真相。
7. `src/cdp-client.ts` — `/json` 与 WebSocket pending map。
8. `src/screenshot.ts` — 写文件边界。
9. `src/webmcp/` — 发现、策略、调用。
10. `src/settings.ts`、`src/tool-selector.ts` — 白名单与迁移。
11. `test/` — 启动失败、路径拒绝、session 关闭。

二次开发时先守住「谁 spawn 谁 kill」和截图路径，再加新 CDP 域。新工具如果在 session_shutdown 里漏掉托管进程，会把 Chromium 留在用户机器上。
